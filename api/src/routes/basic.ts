import { authenticate, authenticateForChannel, authenticatePrincipal, type AuthCredential } from '../auth.js';
import { errorResponse, readJsonObject } from '../utils.js';
import { handleLogin, handleLogout, handleChangePassword } from './auth.js';
import { handleListChannels, handleBrowseChannels, handleCreateChannel, handleGetChannel, handleUpdateChannel, handleDeleteChannel, handleJoinChannel, handleLeaveChannel, handleLeaveChannelSoft, handleListMembers, handleAddMember, handleRemoveMember, handleUpdateChannelNotifications } from './channels.js';
import { handleCreateOrGetDM, handleListDMs, handleHideDM, handleReorderDMs } from './dms.js';
import { handleListFolders, handleCreateFolder, handleUpdateFolder, handleDeleteFolder, handleAddChannelToFolder, handleRemoveChannelFromFolder, handleReorderFolders } from './folders.js';
import { handleGetLinkPreview } from './link-previews.js';
import { createMessageResponse, handleListMessages, handleListInbox, handleSendMessage, handleEditMessage, handleDeleteMessage, handleResolveMessage, handleUnresolveMessage, handleSetThreadTitle, handleGetMessage, handleGetThreadReplies, handleMarkRead, handleMarkMessageRead, handleGetMentions } from './messages.js';
import { handleAddReaction, handleRemoveReaction } from './reactions.js';
import { handleSearch } from './search.js';
import { handleUpload, handleGetUpload } from './uploads.js';
import { handleGetMe, handleUpdateMe, handleSearchUsers, handleListBots, handleGetFrequentEmojis, handleUpdateSelfCapabilities, handleCreateUser, handleCreateMyApiToken, handleCreateApiTokenForUser, handleListMyApiTokens, handleRevokeMyApiToken, handleResetPasswordForUser, handleDeleteUser, handleRevokeApiTokenForUser } from './users.js';
import { handleCreateWebhook, handleDeleteWebhook, handleListWebhooks } from './webhooks.js';
import { handleConfirmEmail, handleRequestEmailChange, handleResendEmailVerification } from './email-verification.js';
import {
  handleCancelMfa,
  handleCompleteMfa,
  handleConfirmMyMfaEnrollment,
  handleDisableMyMfa,
  handleGetMySecurity,
  handleGetWorkspaceSecurity,
  handleResetUserMfa,
  handleStartMyMfaEnrollment,
  handleUpdateWorkspaceSecurity,
} from './mfa.js';
import { ensureFeedbackMembership } from '../lib/feedback.js';
import { FEEDBACK_CHANNEL_ID } from '../constants.js';
import type { ThreadsApp } from './types.js';

function addCredentialToSocketUrl(url: URL, credential: AuthCredential): void {
  url.searchParams.set('credentialKind', credential.kind);
  url.searchParams.set('credentialId', credential.id);
  url.searchParams.set('credentialScopes', credential.scopes === null ? '' : JSON.stringify([...credential.scopes]));
  url.searchParams.set('credentialExpiresAt', String(credential.expiresAt));
}

function internalWebSocketRequest(url: URL): Request {
  // Authentication terminates in the API Worker. Do not forward a user's
  // Authorization or Cookie headers into the Durable Object trust boundary.
  return new Request(url.toString(), { headers: { Upgrade: 'websocket' } });
}

export const CORE_ROUTE_INVENTORY = [
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'POST', path: '/auth/change-password' },
  { method: 'POST', path: '/auth/mfa/complete' },
  { method: 'POST', path: '/auth/mfa/cancel' },
  { method: 'GET', path: '/auth/email/confirm' },
  { method: 'GET', path: '/events' },
  { method: 'GET', path: '/ws/presence' },
  { method: 'GET', path: '/ws/:channelId' },
  { method: 'GET', path: '/presence' },
  { method: 'GET', path: '/uploads/:key{.+}' },
  { method: 'POST', path: '/uploads' },
  { method: 'GET', path: '/link-previews' },
  { method: 'POST', path: '/users' },
  { method: 'GET', path: '/users/me' },
  { method: 'PATCH', path: '/users/me' },
  { method: 'POST', path: '/users/me/email/change' },
  { method: 'POST', path: '/users/me/email/verification/resend' },
  { method: 'GET', path: '/users/me/security' },
  { method: 'POST', path: '/users/me/mfa/enrollment' },
  { method: 'POST', path: '/users/me/mfa/enrollment/confirm' },
  { method: 'DELETE', path: '/users/me/mfa' },
  { method: 'GET', path: '/users/me/frequent-emojis' },
  { method: 'POST', path: '/users/me/api-tokens' },
  { method: 'GET', path: '/users/me/api-tokens' },
  { method: 'DELETE', path: '/users/me/api-tokens/:id' },
  { method: 'GET', path: '/users/me/webhooks' },
  { method: 'POST', path: '/users/me/webhooks' },
  { method: 'DELETE', path: '/users/me/webhooks/:id' },
  { method: 'POST', path: '/users/:id/api-tokens' },
  { method: 'POST', path: '/users/:id/reset-password' },
  { method: 'DELETE', path: '/users/:id/api-tokens/:tokenId' },
  { method: 'DELETE', path: '/users/:id' },
  { method: 'DELETE', path: '/users/:id/mfa' },
  { method: 'GET', path: '/workspace/security' },
  { method: 'PATCH', path: '/workspace/security' },
  { method: 'POST', path: '/bots/self/capabilities' },
  { method: 'GET', path: '/users/search' },
  { method: 'GET', path: '/users/bots' },
  { method: 'GET', path: '/dms' },
  { method: 'POST', path: '/dms' },
  { method: 'PUT', path: '/dms/reorder' },
  { method: 'PATCH', path: '/dms/:id/hide' },
  { method: 'GET', path: '/channels' },
  { method: 'GET', path: '/channels/browse' },
  { method: 'POST', path: '/channels' },
  { method: 'GET', path: '/channels/:id' },
  { method: 'PATCH', path: '/channels/:id' },
  { method: 'DELETE', path: '/channels/:id' },
  { method: 'POST', path: '/channels/:id/join' },
  { method: 'POST', path: '/channels/:id/leave' },
  { method: 'GET', path: '/channels/:id/members' },
  { method: 'POST', path: '/channels/:id/members' },
  { method: 'DELETE', path: '/channels/:id/members/:targetUserId' },
  { method: 'DELETE', path: '/channels/:id/membership' },
  { method: 'PATCH', path: '/channels/:id/notifications' },
  { method: 'GET', path: '/folders' },
  { method: 'POST', path: '/folders' },
  { method: 'PATCH', path: '/folders/:id' },
  { method: 'DELETE', path: '/folders/:id' },
  { method: 'POST', path: '/folders/:id/channels' },
  { method: 'DELETE', path: '/folders/:id/channels/:channelId' },
  { method: 'PUT', path: '/folders/reorder' },
  { method: 'GET', path: '/channels/:id/messages' },
  { method: 'POST', path: '/channels/:id/messages' },
  { method: 'POST', path: '/channels/:id/read' },
  { method: 'GET', path: '/inbox' },
  { method: 'GET', path: '/messages/:id' },
  { method: 'POST', path: '/messages/:id/read' },
  { method: 'PATCH', path: '/messages/:id' },
  { method: 'DELETE', path: '/messages/:id' },
  { method: 'POST', path: '/messages/:id/resolve' },
  { method: 'DELETE', path: '/messages/:id/resolve' },
  { method: 'PUT', path: '/messages/:id/thread-title' },
  { method: 'GET', path: '/messages/:id/replies' },
  { method: 'POST', path: '/messages/:id/replies' },
  { method: 'POST', path: '/messages/:id/reactions' },
  { method: 'DELETE', path: '/messages/:id/reactions/:emoji' },
  { method: 'GET', path: '/mentions' },
  { method: 'GET', path: '/search' },
] as const;

export const BASIC_ROUTE_INVENTORY = CORE_ROUTE_INVENTORY;

export function registerBasicPublicRoutes(app: ThreadsApp): void {
  // --- Auth routes (no auth required) ---
  app.post('/auth/login', (c) => handleLogin(c.req.raw, c.env));
  app.post('/auth/logout', (c) => handleLogout(c.req.raw, c.env));
  app.post('/auth/change-password', (c) => handleChangePassword(c.req.raw, c.env));
  app.post('/auth/mfa/complete', (c) => handleCompleteMfa(c.req.raw, c.env));
  app.post('/auth/mfa/cancel', (c) => handleCancelMfa(c.req.raw, c.env));
  app.get('/auth/email/confirm', (c) => handleConfirmEmail(c.req.raw, c.env));

  // --- Owner-scoped event WebSocket: one socket carries events across all of
  // the user's channels. Authenticated at the user level only; per-channel
  // authorization is enforced producer-side (ChatRoom fans out solely to current
  // channel_members), so this socket can't surface unjoined channels. ---
  app.get('/events', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') {
      return errorResponse('Expected WebSocket', 400);
    }
    const principal = await authenticatePrincipal(c.req.raw, c.env, 'threads:read');
    if (!principal) return errorResponse('Unauthorized', 401);
    const user = principal.user;

    const roomId = c.env.USER_EVENTS_ROOM.idFromName(user.id);
    const room = c.env.USER_EVENTS_ROOM.get(roomId);
    const wsUrl = new URL(c.req.url);
    wsUrl.searchParams.set('userId', user.id);
    wsUrl.searchParams.set('username', user.username);
    wsUrl.searchParams.set('displayName', user.display_name ?? '');
    wsUrl.searchParams.set('nameColor', user.name_color ?? '');
    wsUrl.searchParams.set('role', user.role ?? '');
    addCredentialToSocketUrl(wsUrl, principal.credential);
    return room.fetch(internalWebSocketRequest(wsUrl));
  });

  // --- Presence WebSocket (must be before /ws/:channelId to avoid param capture) ---
  app.get('/ws/presence', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') {
      return errorResponse('Expected WebSocket', 400);
    }
    const principal = await authenticatePrincipal(c.req.raw, c.env, 'threads:read');
    if (!principal) return errorResponse('Unauthorized', 401);
    const user = principal.user;

    const roomId = c.env.PRESENCE_ROOM.idFromName('global');
    const room = c.env.PRESENCE_ROOM.get(roomId);
    const wsUrl = new URL(c.req.url);
    wsUrl.searchParams.set('userId', user.id);
    addCredentialToSocketUrl(wsUrl, principal.credential);
    return room.fetch(internalWebSocketRequest(wsUrl));
  });

  // --- WebSocket ---
  app.get('/ws/:channelId', async (c) => {
    if (c.req.header('Upgrade') !== 'websocket') {
      return errorResponse('Expected WebSocket', 400);
    }
    const channelId = c.req.param('channelId');
    const auth = await authenticateForChannel(c.req.raw, c.env, channelId, 'threads:read');
    if (!auth) return errorResponse('Unauthorized', 401);
    // The global feedback channel auto-joins on first subscribe (no membership UI).
    const isMember = auth.isMember
      || (channelId === FEEDBACK_CHANNEL_ID && await ensureFeedbackMembership(c.env, auth.user.id));
    if (!isMember) return errorResponse('Not a member of this channel', 403);
    const user = auth.user;

    const roomId = c.env.CHAT_ROOM.idFromName(channelId);
    const room = c.env.CHAT_ROOM.get(roomId);
    const wsUrl = new URL(c.req.url);
    wsUrl.searchParams.set('userId', user.id);
    wsUrl.searchParams.set('username', user.username);
    wsUrl.searchParams.set('displayName', user.display_name ?? '');
    wsUrl.searchParams.set('nameColor', user.name_color ?? '');
    wsUrl.searchParams.set('role', user.role ?? '');
    addCredentialToSocketUrl(wsUrl, auth.credential);
    return room.fetch(internalWebSocketRequest(wsUrl));
  });

  // --- Presence REST (batch fetch) ---
  app.get('/presence', async (c) => {
    const user = await authenticate(c.req.raw, c.env, 'threads:read');
    if (!user) return errorResponse('Unauthorized', 401);

    const roomId = c.env.PRESENCE_ROOM.idFromName('global');
    const room = c.env.PRESENCE_ROOM.get(roomId);
    const url = new URL(c.req.url);
    return room.fetch(new Request(url.toString(), { headers: c.req.raw.headers }));
  });
}

export function registerBasicAuthenticatedRoutes(authed: ThreadsApp): void {
  // Uploads
  authed.get('/uploads/:key{.+}', (c) => handleGetUpload(c.env, c.get('user'), decodeURIComponent(c.req.param('key'))));
  authed.post('/uploads', (c) => handleUpload(c.req.raw, c.env, c.get('user')));

  // Link previews
  authed.get('/link-previews', (c) => handleGetLinkPreview(c.env, c.get('user'), new URL(c.req.url)));

  // Users
  authed.post('/users', (c) => handleCreateUser(c.req.raw, c.env, c.get('principal')));
  authed.get('/users/me', (c) => handleGetMe(c.env, c.get('user')));
  authed.patch('/users/me', (c) => handleUpdateMe(c.req.raw, c.env, c.get('user')));
  authed.post('/users/me/email/change', (c) => handleRequestEmailChange(c.req.raw, c.env, c.get('principal')));
  authed.post('/users/me/email/verification/resend', (c) => handleResendEmailVerification(c.req.raw, c.env, c.get('principal')));
  authed.get('/users/me/security', (c) => handleGetMySecurity(c.env, c.get('principal')));
  authed.post('/users/me/mfa/enrollment', (c) => handleStartMyMfaEnrollment(c.req.raw, c.env, c.get('principal')));
  authed.post('/users/me/mfa/enrollment/confirm', (c) => handleConfirmMyMfaEnrollment(c.req.raw, c.env, c.get('principal')));
  authed.delete('/users/me/mfa', (c) => handleDisableMyMfa(c.req.raw, c.env, c.get('principal')));
  authed.get('/users/me/frequent-emojis', (c) => handleGetFrequentEmojis(c.env, c.get('user')));
  authed.post('/users/me/api-tokens', (c) => handleCreateMyApiToken(c.req.raw, c.env, c.get('principal')));
  authed.get('/users/me/api-tokens', (c) => handleListMyApiTokens(c.env, c.get('principal')));
  authed.delete('/users/me/api-tokens/:id', (c) => handleRevokeMyApiToken(c.env, c.get('principal'), c.req.param('id')));
  authed.get('/users/me/webhooks', (c) => handleListWebhooks(c.env, c.get('user')));
  authed.post('/users/me/webhooks', (c) => handleCreateWebhook(c.req.raw, c.env, c.get('principal')));
  authed.delete('/users/me/webhooks/:id', (c) => handleDeleteWebhook(c.env, c.get('user'), c.req.param('id')));
  // Param route registered AFTER the static /users/me/* routes so "me" is not
  // captured as :id (Hono prioritizes static segments, but keep order explicit).
  authed.post('/users/:id/api-tokens', (c) => handleCreateApiTokenForUser(c.req.raw, c.env, c.get('principal'), c.req.param('id')));
  // Admin-only operator actions on other users (session or narrow bearer scope),
  // replacing the old X-Admin-Key `/admin/*` endpoints.
  authed.post('/users/:id/reset-password', (c) => handleResetPasswordForUser(c.req.raw, c.env, c.get('principal'), c.req.param('id')));
  authed.delete('/users/:id/api-tokens/:tokenId', (c) => handleRevokeApiTokenForUser(c.env, c.get('principal'), c.req.param('id'), c.req.param('tokenId')));
  authed.delete('/users/:id', (c) => handleDeleteUser(c.env, c.get('principal'), c.req.param('id')));
  authed.delete('/users/:id/mfa', (c) => handleResetUserMfa(c.req.raw, c.env, c.get('principal'), c.req.param('id')));
  authed.get('/workspace/security', (c) => handleGetWorkspaceSecurity(c.env, c.get('principal')));
  authed.patch('/workspace/security', (c) => handleUpdateWorkspaceSecurity(c.req.raw, c.env, c.get('principal')));
  authed.post('/bots/self/capabilities', (c) => handleUpdateSelfCapabilities(c.req.raw, c.env, c.get('user')));
  authed.get('/users/search', (c) => handleSearchUsers(c.env, c.get('user'), new URL(c.req.url)));
  authed.get('/users/bots', (c) => handleListBots(c.env, c.get('user')));

  // DMs
  authed.get('/dms', (c) => handleListDMs(c.env, c.get('user')));
  authed.post('/dms', (c) => handleCreateOrGetDM(c.req.raw, c.env, c.get('user')));
  authed.put('/dms/reorder', (c) => handleReorderDMs(c.req.raw, c.env, c.get('user')));
  authed.patch('/dms/:id/hide', (c) => handleHideDM(c.env, c.get('user'), c.req.param('id')));

  // Channels
  authed.get('/channels', (c) => handleListChannels(c.env, c.get('user')));
  authed.get('/channels/browse', (c) => handleBrowseChannels(c.env, c.get('user')));
  authed.post('/channels', (c) => handleCreateChannel(c.req.raw, c.env, c.get('user')));
  authed.get('/channels/:id', (c) => handleGetChannel(c.env, c.get('user'), c.req.param('id')));
  authed.patch('/channels/:id', (c) => handleUpdateChannel(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.delete('/channels/:id', (c) => handleDeleteChannel(c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/join', (c) => handleJoinChannel(c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/leave', (c) => handleLeaveChannel(c.env, c.get('user'), c.req.param('id')));
  authed.get('/channels/:id/members', (c) => handleListMembers(c.env, c.get('user'), c.req.param('id')));
  authed.post('/channels/:id/members', (c) => handleAddMember(c.req.raw, c.env, c.get('user'), c.req.param('id'), c.executionCtx));
  authed.delete('/channels/:id/members/:targetUserId', (c) => handleRemoveMember(c.env, c.get('user'), c.req.param('id'), c.req.param('targetUserId'), c.executionCtx));
  authed.delete('/channels/:id/membership', (c) => handleLeaveChannelSoft(c.env, c.get('user'), c.req.param('id')));
  authed.patch('/channels/:id/notifications', (c) => handleUpdateChannelNotifications(c.req.raw, c.env, c.get('user'), c.req.param('id')));

  // Folders
  authed.get('/folders', (c) => handleListFolders(c.env, c.get('user')));
  authed.post('/folders', (c) => handleCreateFolder(c.req.raw, c.env, c.get('user')));
  authed.patch('/folders/:id', (c) => handleUpdateFolder(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.delete('/folders/:id', (c) => handleDeleteFolder(c.env, c.get('user'), c.req.param('id')));
  authed.post('/folders/:id/channels', (c) => handleAddChannelToFolder(c.req.raw, c.env, c.get('user'), c.req.param('id')));
  authed.delete('/folders/:id/channels/:channelId', (c) => handleRemoveChannelFromFolder(c.env, c.get('user'), c.req.param('id'), c.req.param('channelId')));
  authed.put('/folders/reorder', (c) => handleReorderFolders(c.req.raw, c.env, c.get('user')));

  // Messages
  authed.get('/channels/:id/messages', (c) => handleListMessages(c.env, c.get('user'), c.req.param('id'), new URL(c.req.url)));
  authed.post('/channels/:id/messages', (c) => handleSendMessage(c.req.raw, c.env, c.get('user'), c.req.param('id'), c.executionCtx));
  authed.post('/channels/:id/read', (c) => handleMarkRead(c.env, c.get('user'), c.req.param('id')));
  authed.get('/inbox', (c) => handleListInbox(c.env, c.get('user'), new URL(c.req.url)));

  // Message operations
  authed.get('/messages/:id', (c) => handleGetMessage(c.env, c.get('user'), c.req.param('id')));
  authed.post('/messages/:id/read', (c) => handleMarkMessageRead(c.env, c.get('user'), c.req.param('id')));
  authed.patch('/messages/:id', (c) => handleEditMessage(c.req.raw, c.env, c.get('user'), c.req.param('id'), c.executionCtx));
  authed.delete('/messages/:id', (c) => handleDeleteMessage(c.env, c.get('user'), c.req.param('id')));
  authed.post('/messages/:id/resolve', (c) => handleResolveMessage(c.env, c.get('user'), c.req.param('id')));
  authed.delete('/messages/:id/resolve', (c) => handleUnresolveMessage(c.env, c.get('user'), c.req.param('id')));
  authed.put('/messages/:id/thread-title', (c) => handleSetThreadTitle(c.req.raw, c.env, c.get('user'), c.req.param('id')));

  // Thread replies
  authed.get('/messages/:id/replies', (c) => handleGetThreadReplies(c.env, c.get('user'), c.req.param('id'), new URL(c.req.url)));
  authed.post('/messages/:id/replies', async (c) => {
    const targetId = c.req.param('id');
    const msg = await c.env.DB.prepare('SELECT channel_id, thread_id FROM messages WHERE id = ?')
      .bind(targetId).first<{ channel_id: string; thread_id: string | null }>();
    if (!msg) return errorResponse('Thread not found', 404);
    const threadId = msg.thread_id || targetId;

    const body = await readJsonObject<{ content: string; attachmentIds?: string[]; metadata?: Record<string, any>; message_type?: string; idempotencyKey?: string }>(c.req.raw);
    return createMessageResponse(c.env, c.get('user'), {
      channelId: msg.channel_id,
      content: body.content,
      threadId,
      attachmentIds: body.attachmentIds,
      metadata: body.metadata,
      messageType: body.message_type,
      idempotencyKey: body.idempotencyKey,
    }, c.executionCtx);
  });

  // Reactions
  authed.post('/messages/:id/reactions', (c) => handleAddReaction(c.req.raw, c.env, c.get('user'), c.req.param('id'), c.executionCtx));
  authed.delete('/messages/:id/reactions/:emoji', (c) => handleRemoveReaction(c.env, c.get('user'), c.req.param('id'), decodeURIComponent(c.req.param('emoji')), c.executionCtx));

  // Mentions
  authed.get('/mentions', (c) => handleGetMentions(c.env, c.get('user')));

  // Search
  authed.get('/search', (c) => handleSearch(c.env, c.get('user'), new URL(c.req.url)));
}
