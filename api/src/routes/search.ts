import type { Env, User } from '../types.js';
import { jsonResponse } from '../utils.js';

// Sentinel characters for snippet() match highlighting. The server inserts these
// around matched tokens; the client HTML-escapes the snippet, then replaces
// sentinels with <mark>/</mark>. This avoids smuggling raw HTML from DB content.
// Kept in sync with client: packages/threads/client/src/lib/search.ts
export const SNIPPET_MARK_START = '\u0002MS\u0002';
export const SNIPPET_MARK_END = '\u0002ME\u0002';

type Token =
  | { type: 'term'; value: string; prefix: boolean }
  | { type: 'phrase'; value: string }
  | { type: 'not'; value: string; prefix: boolean }
  | { type: 'or' };

/**
 * Parse a user query into tokens. Supports:
 *  - `"quoted phrases"` — exact phrase match
 *  - `OR` (uppercase only) — OR operator between terms
 *  - `-term` — exclude messages containing term
 *  - `term*` — prefix match
 *  - bare terms — implicit AND
 */
function tokenizeSearchQuery(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (/\s/.test(ch)) { i++; continue; }

    // Quoted phrase — slurp to the next quote (or end of string)
    if (ch === '"') {
      let end = query.indexOf('"', i + 1);
      if (end === -1) end = query.length;
      const phrase = query.slice(i + 1, end);
      if (phrase.length > 0) tokens.push({ type: 'phrase', value: phrase });
      i = end + 1;
      continue;
    }

    // Negation prefix — only when followed by a non-space character
    if (ch === '-' && i + 1 < query.length && !/\s/.test(query[i + 1])) {
      const start = i + 1;
      let end = start;
      while (end < query.length && !/\s/.test(query[end])) end++;
      let word = query.slice(start, end);
      const prefix = /\*+$/.test(word);
      word = word.replace(/\*+$/, '');
      if (word.length > 0) tokens.push({ type: 'not', value: word, prefix });
      i = end;
      continue;
    }

    // Bare word — may be `OR`, a term, or a prefix term
    let end = i;
    while (end < query.length && !/\s/.test(query[end])) end++;
    const word = query.slice(i, end);
    if (word === 'OR') {
      tokens.push({ type: 'or' });
    } else {
      const prefix = /\*+$/.test(word);
      const bare = word.replace(/\*+$/, '');
      if (bare.length > 0) tokens.push({ type: 'term', value: bare, prefix });
    }
    i = end;
  }
  return tokens;
}

function emitTerm(tok: Token & { type: 'term' | 'phrase' | 'not' }): string {
  const escaped = tok.value.replace(/"/g, '""');
  const base = `"${escaped}"`;
  if (tok.type === 'phrase') return base;
  return (tok as { prefix: boolean }).prefix ? `${base}*` : base;
}

export function sanitizeFtsQuery(query: string): string {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return '';

  // Split into positives (term/phrase) joined by AND/OR, and negatives (NOT).
  // FTS5 requires NOT to have a left operand, so orphan negatives are dropped.
  const positives: string[] = [];
  const joiners: string[] = []; // joiner between positives[i] and positives[i+1]
  const negatives: string[] = [];
  let nextJoin: 'AND' | 'OR' = 'AND';

  for (const tok of tokens) {
    if (tok.type === 'or') {
      if (positives.length > 0) nextJoin = 'OR';
      continue;
    }
    if (tok.type === 'not') {
      negatives.push(emitTerm(tok));
      continue;
    }
    // term | phrase
    if (positives.length > 0) joiners.push(nextJoin);
    positives.push(emitTerm(tok));
    nextJoin = 'AND';
  }

  if (positives.length === 0) return '';

  // Build: p0 [AND|OR] p1 [AND|OR] p2 ... NOT n0 NOT n1 ...
  // FTS5 uses a SPACE as implicit AND between phrases; explicit AND is also
  // valid. We emit explicit AND for readability.
  let out = positives[0];
  for (let k = 0; k < joiners.length; k++) {
    out += ` ${joiners[k]} ${positives[k + 1]}`;
  }
  for (const neg of negatives) {
    out += ` NOT ${neg}`;
  }
  return out;
}

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export async function handleSearch(env: Env, user: User, url: URL): Promise<Response> {
  const query = url.searchParams.get('q') ?? '';
  const channelId = url.searchParams.get('channel');
  const fromUserId = url.searchParams.get('from');
  const sinceParam = url.searchParams.get('since');
  const untilParam = url.searchParams.get('until');
  const hasParam = url.searchParams.get('has');

  const sinceTs = sinceParam !== null ? parseInt(sinceParam, 10) : NaN;
  const untilTs = untilParam !== null ? parseInt(untilParam, 10) : NaN;
  const since = Number.isFinite(sinceTs) && sinceTs >= 0 ? sinceTs : null;
  const until = Number.isFinite(untilTs) && untilTs >= 0 ? untilTs : null;

  const hasAnyFilter = !!(channelId || fromUserId || since !== null || until !== null || hasParam);

  const offsetParam = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;
  const limitParam = parseInt(url.searchParams.get('limit') ?? String(PAGE_SIZE), 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_PAGE_SIZE)
    : PAGE_SIZE;

  const ftsQuery = sanitizeFtsQuery(query);

  // No text query and no filters → return empty (don't dump the entire table)
  if (ftsQuery.length === 0 && !hasAnyFilter) {
    return jsonResponse({ results: [], total: 0, hasMore: false, offset, limit });
  }

  // Branch: filter-only (no text query) vs FTS + filters
  const useFilterOnly = ftsQuery.length === 0 && hasAnyFilter;

  let sql: string;
  let params: any[];
  let countSql: string;
  let countParams: any[];

  if (useFilterOnly) {
    // Plain SELECT — no FTS join
    sql = `
      SELECT m.*, u.username, u.display_name, u.name_color, c.name as channel_name,
        c.is_dm as is_dm, c.dm_partner_id as dm_partner_id,
        NULL as snippet, 0 as bm25_score
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      JOIN channels c ON m.channel_id = c.id
      JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = ? AND cm.left_at IS NULL
      WHERE m.deleted_at IS NULL
    `;
    params = [user.id];

    countSql = `
      SELECT COUNT(*) as total
      FROM messages m
      JOIN channels c ON m.channel_id = c.id
      JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = ? AND cm.left_at IS NULL
      WHERE m.deleted_at IS NULL
    `;
    countParams = [user.id];
  } else {
    // Hybrid ranking: bm25() relevance score (negative; lower = better match)
    // weighted by a linear recency decay `1 / (1 + age_days / TAU_DAYS)`.
    // The decay shrinks toward 0 for older messages, pushing their (negative)
    // score toward 0 (less attractive). Recent matches keep their bm25 value.
    // TAU_DAYS=30 means a 30-day-old message has its score halved.
    sql = `
      SELECT m.*, u.username, u.display_name, u.name_color, c.name as channel_name,
        c.is_dm as is_dm, c.dm_partner_id as dm_partner_id,
        snippet(messages_fts, 0, ?, ?, '…', 20) as snippet,
        bm25(messages_fts) as bm25_score
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      LEFT JOIN users u ON m.user_id = u.id
      JOIN channels c ON m.channel_id = c.id
      JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = ? AND cm.left_at IS NULL
      WHERE messages_fts MATCH ? AND m.deleted_at IS NULL
    `;
    params = [SNIPPET_MARK_START, SNIPPET_MARK_END, user.id, ftsQuery];

    // Separate count query (can't combine COUNT(*) OVER() with FTS5 bm25()/snippet()
    // in the same SELECT — D1 rejects with "unable to use function bm25 in the
    // requested context").
    countSql = `
      SELECT COUNT(*) as total
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      JOIN channels c ON m.channel_id = c.id
      JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = ? AND cm.left_at IS NULL
      WHERE messages_fts MATCH ? AND m.deleted_at IS NULL
    `;
    countParams = [user.id, ftsQuery];
  }

  if (channelId) {
    sql += ' AND m.channel_id = ?';
    params.push(channelId);
    countSql += ' AND m.channel_id = ?';
    countParams.push(channelId);
  }

  if (fromUserId) {
    sql += ' AND m.user_id = ?';
    params.push(fromUserId);
    countSql += ' AND m.user_id = ?';
    countParams.push(fromUserId);
  }

  if (since !== null) {
    sql += ' AND m.created_at >= ?';
    params.push(since);
    countSql += ' AND m.created_at >= ?';
    countParams.push(since);
  }

  if (until !== null) {
    sql += ' AND m.created_at <= ?';
    params.push(until);
    countSql += ' AND m.created_at <= ?';
    countParams.push(until);
  }

  // has: filter — CSV of link, reaction, file
  if (hasParam) {
    const hasValues = new Set(hasParam.split(',').map(v => v.trim().toLowerCase()));
    if (hasValues.has('link')) {
      sql += " AND m.content LIKE '%http%'";
      countSql += " AND m.content LIKE '%http%'";
    }
    if (hasValues.has('reaction')) {
      sql += ' AND EXISTS (SELECT 1 FROM reactions r WHERE r.message_id = m.id)';
      countSql += ' AND EXISTS (SELECT 1 FROM reactions r WHERE r.message_id = m.id)';
    }
    if (hasValues.has('file')) {
      sql += ' AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)';
      countSql += ' AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)';
    }
  }

  if (useFilterOnly) {
    sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
  } else {
    const TAU_DAYS = 30;
    sql += ` ORDER BY bm25(messages_fts) * (1.0 / (1.0 + ((unixepoch() - m.created_at) / 86400.0) / ${TAU_DAYS})) ASC LIMIT ? OFFSET ?`;
  }
  params.push(limit, offset);

  const [results, countResult] = await Promise.all([
    env.DB.prepare(sql).bind(...params).all(),
    env.DB.prepare(countSql).bind(...countParams).first<{ total: number }>(),
  ]);
  const rows = (results.results ?? []) as any[];
  const total = Number(countResult?.total ?? 0);
  return jsonResponse({
    results: rows,
    total,
    hasMore: offset + rows.length < total,
    offset,
    limit,
  });
}
