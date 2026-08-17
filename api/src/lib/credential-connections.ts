import type { Env } from '../types.js';

export async function sessionCredentialIdsForUser(env: Env, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT credential_id FROM sessions WHERE user_id = ?',
  ).bind(userId).all<{ credential_id: string }>();
  return (rows.results ?? []).map((row) => row.credential_id);
}

export async function allCredentialIdsForUser(env: Env, userId: string): Promise<string[]> {
  const [sessionIds, tokenRows] = await Promise.all([
    sessionCredentialIdsForUser(env, userId),
    env.DB.prepare(
      'SELECT credential_id FROM api_tokens WHERE user_id = ?',
    ).bind(userId).all<{ credential_id: string }>(),
  ]);
  const tokenIds = (tokenRows.results ?? []).map((row) => row.credential_id);
  return [...new Set([...sessionIds, ...tokenIds])];
}

/** Close every live socket authenticated by one credential. */
export async function disconnectCredentialConnections(
  env: Env,
  userId: string,
  credentialIdValue: string,
  reason = 'Credential revoked',
): Promise<number> {
  const channels = await env.DB.prepare(
    'SELECT channel_id FROM channel_members WHERE user_id = ? AND left_at IS NULL',
  ).bind(userId).all<{ channel_id: string }>();

  const eventsRoom = env.USER_EVENTS_ROOM.get(env.USER_EVENTS_ROOM.idFromName(userId));
  const presenceRoom = env.PRESENCE_ROOM.get(env.PRESENCE_ROOM.idFromName('global'));
  const counts = await Promise.all([
    eventsRoom.disconnectCredential(credentialIdValue, reason),
    presenceRoom.disconnectCredential(credentialIdValue, reason),
    ...(channels.results ?? []).map((row) => {
      const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(row.channel_id));
      return room.disconnectCredential(credentialIdValue, reason);
    }),
  ]);
  return counts.reduce((total, count) => total + count, 0);
}

export async function disconnectCredentialsForUser(
  env: Env,
  userId: string,
  credentialIds: string[],
  reason: string,
): Promise<number> {
  const counts = await Promise.all(credentialIds.map((id) =>
    disconnectCredentialConnections(env, userId, id, reason)));
  return counts.reduce((total, count) => total + count, 0);
}
