import type { Env, User } from '../types.js';
import { generateId, jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import { requireChannelMembership } from '../middleware.js';
import { publishChannelEvent } from '../lib/channel-events.js';

// --- Board ---

export async function handleGetBoard(env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);

  const board = await env.DB.prepare('SELECT * FROM kanban_boards WHERE channel_id = ?')
    .bind(channelId).first();
  if (!board) return errorResponse('Board not found', 404);

  const cards = await env.DB.prepare('SELECT * FROM kanban_cards WHERE board_id = ? ORDER BY position')
    .bind(board.id).all();

  return jsonResponse({ board, cards: cards.results });
}

export async function handleCreateBoard(env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);

  const existing = await env.DB.prepare('SELECT id FROM kanban_boards WHERE channel_id = ?')
    .bind(channelId).first();
  if (existing) return errorResponse('Board already exists for this channel', 409);

  const id = generateId();
  await env.DB.prepare(
    'INSERT INTO kanban_boards (id, channel_id, created_by) VALUES (?, ?, ?)'
  ).bind(id, channelId, user.id).run();

  const board = await env.DB.prepare('SELECT * FROM kanban_boards WHERE id = ?').bind(id).first();
  return jsonResponse(board, 201);
}

export async function handleUpdateBoard(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);

  const board = await env.DB.prepare('SELECT * FROM kanban_boards WHERE channel_id = ?')
    .bind(channelId).first();
  if (!board) return errorResponse('Board not found', 404);

  const body = await readJsonObject<{ columns?: string[] }>(request);
  if (!body.columns || !Array.isArray(body.columns)) return errorResponse('columns array required');

  await env.DB.prepare('UPDATE kanban_boards SET columns = ? WHERE id = ?')
    .bind(JSON.stringify(body.columns), board.id).run();

  const updated = await env.DB.prepare('SELECT * FROM kanban_boards WHERE id = ?').bind(board.id).first();

  // Broadcast board update
  await publishChannelEvent(env, undefined, channelId, { type: 'board_updated', ...updated });

  return jsonResponse(updated);
}

// --- Cards ---

export async function handleCreateCard(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);

  const board = await env.DB.prepare('SELECT * FROM kanban_boards WHERE channel_id = ?')
    .bind(channelId).first<{ id: string }>();
  if (!board) return errorResponse('Board not found', 404);

  const body = await readJsonObject<{
    title: string;
    description?: string;
    assignee?: string;
    priority?: string;
    column_key?: string;
    source_message_id?: string;
    metadata?: Record<string, any>;
  }>(request);
  if (!body.title) return errorResponse('title is required');

  // Position: max existing + 1000, or 1000 if empty
  const maxPos = await env.DB.prepare(
    'SELECT MAX(position) as max_pos FROM kanban_cards WHERE board_id = ?'
  ).bind(board.id).first<{ max_pos: number | null }>();
  const position = (maxPos?.max_pos ?? 0) + 1000;

  const id = generateId();
  const columnKey = body.column_key ?? 'todo';

  await env.DB.prepare(
    `INSERT INTO kanban_cards (id, board_id, column_key, title, description, assignee, priority, position, source_message_id, metadata, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, board.id, columnKey, body.title,
    body.description ?? null, body.assignee ?? null,
    body.priority ?? 'normal', position,
    body.source_message_id ?? null,
    body.metadata ? JSON.stringify(body.metadata) : null,
    user.id
  ).run();

  // Log creation activity
  const actId = generateId();
  await env.DB.prepare(
    'INSERT INTO kanban_activity (id, card_id, user_id, action) VALUES (?, ?, ?, ?)'
  ).bind(actId, id, user.id, 'created').run();

  const card = await env.DB.prepare('SELECT * FROM kanban_cards WHERE id = ?').bind(id).first();

  // Broadcast card creation
  await publishChannelEvent(env, undefined, channelId, { type: 'card_created', ...card });

  return jsonResponse(card, 201);
}

export async function handleUpdateCard(request: Request, env: Env, user: User, cardId: string): Promise<Response> {
  const card = await env.DB.prepare('SELECT * FROM kanban_cards WHERE id = ?')
    .bind(cardId).first<{ id: string; board_id: string; column_key: string; assignee: string | null; title: string; description: string | null; priority: string; position: number }>();
  if (!card) return errorResponse('Card not found', 404);

  // Verify user is member of the board's channel
  const board = await env.DB.prepare('SELECT channel_id FROM kanban_boards WHERE id = ?')
    .bind(card.board_id).first<{ channel_id: string }>();
  if (!board) return errorResponse('Board not found', 404);
  await requireChannelMembership(env, user.id, board.channel_id);

  const body = await readJsonObject<{
    title?: string;
    description?: string;
    column_key?: string;
    assignee?: string | null;
    priority?: string;
    position?: number;
    metadata?: Record<string, any>;
  }>(request);

  const sets: string[] = [];
  const values: unknown[] = [];
  const activities: { action: string; from_value: string | null; to_value: string | null }[] = [];

  if (body.title !== undefined) { sets.push('title = ?'); values.push(body.title); }
  if (body.description !== undefined) { sets.push('description = ?'); values.push(body.description); }
  if (body.priority !== undefined) { sets.push('priority = ?'); values.push(body.priority); }
  if (body.position !== undefined) { sets.push('position = ?'); values.push(body.position); }
  if (body.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(body.metadata)); }

  if (body.column_key !== undefined && body.column_key !== card.column_key) {
    sets.push('column_key = ?');
    values.push(body.column_key);
    activities.push({ action: 'moved', from_value: card.column_key, to_value: body.column_key });
  }

  if (body.assignee !== undefined && body.assignee !== card.assignee) {
    sets.push('assignee = ?');
    values.push(body.assignee);
    activities.push({ action: 'assigned', from_value: card.assignee, to_value: body.assignee });
  }

  if (sets.length === 0) return errorResponse('No fields to update');

  sets.push("updated_at = datetime('now')");
  values.push(cardId);

  await env.DB.prepare(
    `UPDATE kanban_cards SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  // Log activity entries
  for (const act of activities) {
    const actId = generateId();
    await env.DB.prepare(
      'INSERT INTO kanban_activity (id, card_id, user_id, action, from_value, to_value) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(actId, cardId, user.id, act.action, act.from_value, act.to_value).run();
  }

  const updated = await env.DB.prepare('SELECT * FROM kanban_cards WHERE id = ?').bind(cardId).first();

  // Broadcast card update
  await publishChannelEvent(env, undefined, board.channel_id, { type: 'card_updated', ...updated });

  // When a card is moved to "in-progress", create a real message in the channel
  // so the bot picks it up and can start working the card
  const movedToInProgress = body.column_key === 'in-progress' && card.column_key !== 'in-progress';
  if (movedToInProgress) {
    const cardTitle = body.title ?? card.title;
    const cardDesc = body.description ?? card.description;
    let content = `\u{1F4CB} **${cardTitle}** moved to In Progress`;
    if (cardDesc) content += `\n> ${cardDesc}`;
    if (card.assignee || body.assignee) content += `\nAssigned to: ${body.assignee ?? card.assignee}`;

    const msgId = generateId();
    const metadataJson = JSON.stringify({ cardId, source: 'kanban' });
    await env.DB.prepare(
      'INSERT INTO messages (id, channel_id, user_id, content, metadata) VALUES (?, ?, ?, ?, ?)'
    ).bind(msgId, board.channel_id, user.id, content, metadataJson).run();

    // Look up channel settings for broadcast
    const channel = await env.DB.prepare('SELECT auto_respond_bot_id, processing_mode FROM channels WHERE id = ?')
      .bind(board.channel_id).first<{ auto_respond_bot_id: string | null; processing_mode: string }>();

    const broadcastMsg = {
      type: 'message',
      id: msgId,
      channelId: board.channel_id,
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      nameColor: user.name_color,
      content,
      threadId: null,
      createdAt: Math.floor(Date.now() / 1000),
      mentions: [],
      attachments: [],
      metadata: { cardId, source: 'kanban' },
      autoRespondBotId: channel?.auto_respond_bot_id ?? null,
      processingMode: channel?.processing_mode || 'immediate',
    };

    await publishChannelEvent(env, undefined, board.channel_id, broadcastMsg);
  }

  return jsonResponse(updated);
}

export async function handleDeleteCard(env: Env, user: User, cardId: string): Promise<Response> {
  const card = await env.DB.prepare('SELECT * FROM kanban_cards WHERE id = ?')
    .bind(cardId).first<{ id: string; board_id: string }>();
  if (!card) return errorResponse('Card not found', 404);

  // Verify user is member of the board's channel
  const board = await env.DB.prepare('SELECT channel_id FROM kanban_boards WHERE id = ?')
    .bind(card.board_id).first<{ channel_id: string }>();
  if (!board) return errorResponse('Board not found', 404);
  await requireChannelMembership(env, user.id, board.channel_id);

  // Hard delete card and its activity
  await env.DB.batch([
    env.DB.prepare('DELETE FROM kanban_activity WHERE card_id = ?').bind(cardId),
    env.DB.prepare('DELETE FROM kanban_cards WHERE id = ?').bind(cardId),
  ]);

  // Broadcast card deletion
  await publishChannelEvent(env, undefined, board.channel_id, {
    type: 'card_deleted',
    cardId,
    boardId: card.board_id,
  });

  return jsonResponse({ ok: true });
}

// --- Activity ---

export async function handleGetCardActivity(env: Env, user: User, cardId: string): Promise<Response> {
  const card = await env.DB.prepare('SELECT board_id FROM kanban_cards WHERE id = ?')
    .bind(cardId).first<{ board_id: string }>();
  if (!card) return errorResponse('Card not found', 404);

  const board = await env.DB.prepare('SELECT channel_id FROM kanban_boards WHERE id = ?')
    .bind(card.board_id).first<{ channel_id: string }>();
  if (!board) return errorResponse('Board not found', 404);
  await requireChannelMembership(env, user.id, board.channel_id);

  const activity = await env.DB.prepare(
    'SELECT * FROM kanban_activity WHERE card_id = ? ORDER BY created_at DESC'
  ).bind(cardId).all();

  return jsonResponse(activity.results);
}
