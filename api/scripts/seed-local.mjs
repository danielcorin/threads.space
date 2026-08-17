// Seed local D1 for development: an admin user plus a stable bot-test fixture
// (a bot user, a fixed API token, a `bot-test` channel, and memberships).
//
// Everything uses FIXED ids/token so you can hardcode them in a bot's .env once
// and reseed repeatedly without the values changing. (The README's API-create
// flow assigns random ids each time and `channels.name` is UNIQUE, so it is not
// repeatable — this fixture is.)
//
// Idempotent and authoritative: the bot fixture is delete-then-recreated, the
// admin user is upserted. Writes directly to local D1 via `wrangler d1 execute
// --local`, so it needs no running server.
//
// Usage:
//   node scripts/seed-local.mjs                 # admin dan + echobot fixture
//   SEED_USERNAME=alice SEED_PASSWORD=secret123 node scripts/seed-local.mjs
//   SEED_BOT=0 node scripts/seed-local.mjs      # admin user only, no fixture
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { adminUpsertSql, credentialId, credentialVerifier, hashPassword, q } from './seed-lib.mjs';

// --- Admin user (parameterizable) -------------------------------------------
const username = process.env.SEED_USERNAME ?? 'dan';
const password = process.env.SEED_PASSWORD ?? 'dan-password-123';
const display = process.env.SEED_DISPLAY ?? username[0].toUpperCase() + username.slice(1);
const email = process.env.SEED_EMAIL ?? `${username}@local.invalid`;

// --- Bot-test fixture (fixed ids so .env stays valid across reseeds) ---------
const SEED_BOT = process.env.SEED_BOT !== '0';
const BOT_USERNAME = 'echobot';
const BOT_USER_ID = 'seed-echobot-user';
const BOT_TOKEN = 'seed-echobot-token-local-dev';
const BOT_PASSWORD = 'echobot-local-dev'; // bots auth by token; this just satisfies NOT NULL
const CHANNEL_ID = 'seed-bot-test-channel';
const CHANNEL_NAME = 'bot-test';
const INSTANCE_SECRET = process.env.INSTANCE_SECRET ?? 'threads-local-development-instance-secret';

const statements = [];

// Admin user — upsert by username (refresh credentials + admin flag).
statements.push(await adminUpsertSql(username, password, display, email, true));

if (SEED_BOT) {
  const botHash = await hashPassword(BOT_PASSWORD);
  const botTokenId = await credentialId(BOT_TOKEN);
  const botTokenVerifier = await credentialVerifier(INSTANCE_SECRET, 'api_token', BOT_TOKEN);
  const botTokenStorageKey = `id:${botTokenId}`;
  // Idempotent upserts keyed on the FIXED ids. The bot user is upserted (never
  // deleted) so reseeding works even after it has authored messages, joined
  // channels, or been set as a channel's auto_respond_bot — delete-then-recreate
  // tripped FK constraints (messages.user_id, channels.auto_respond_bot_id,
  // users.ephemeral_bot_id are all non-cascading references to the bot).
  //
  // A stray random-id "echobot" from API testing would collide on the UNIQUE
  // username, so it's removed first — clearing the non-cascading references that
  // would otherwise block its deletion (channel_members/tokens cascade or are
  // deleted explicitly; messages.user_id is nullable, so orphan rather than block).
  const strayEchobot = `(SELECT id FROM users WHERE username = ${q(BOT_USERNAME)} AND id != ${q(BOT_USER_ID)})`;
  statements.push(
    `UPDATE channels SET auto_respond_bot_id = NULL WHERE auto_respond_bot_id IN ${strayEchobot}`,
    `UPDATE users SET ephemeral_bot_id = NULL WHERE ephemeral_bot_id IN ${strayEchobot}`,
    `UPDATE messages SET user_id = NULL WHERE user_id IN ${strayEchobot}`,
    `DELETE FROM api_tokens WHERE user_id IN ${strayEchobot}`,
    `DELETE FROM users WHERE username = ${q(BOT_USERNAME)} AND id != ${q(BOT_USER_ID)}`,
    // Upsert the bot user on its fixed id — preserves all references on reseed.
    `INSERT INTO users (id, username, password_hash, email, email_normalized, display_name, role, is_admin)
       VALUES (${q(BOT_USER_ID)}, ${q(BOT_USERNAME)}, ${q(botHash)}, NULL, NULL, 'Echo Bot', 'bot', 0)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username, password_hash = excluded.password_hash,
       display_name = excluded.display_name, role = 'bot'`,
    // Stable bot API token; only a verifier and non-secret id are persisted.
    `INSERT INTO api_tokens
       (token, user_id, name, credential_id, token_verifier, verifier_version, token_hint)
     VALUES (${q(botTokenStorageKey)}, ${q(BOT_USER_ID)}, 'seed-local', ${q(botTokenId)},
             ${q(botTokenVerifier)}, 1, ${q(BOT_TOKEN.slice(-6))})
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id, credential_id = excluded.credential_id,
       token_verifier = excluded.token_verifier, verifier_version = 1,
       token_hint = excluded.token_hint, revoked_at = NULL`,
    // bot-test channel, owned by the seeded admin. Upsert on fixed id so its
    // message history survives a reseed (delete would cascade messages away).
    `INSERT INTO channels (id, name, description, created_by)
       SELECT ${q(CHANNEL_ID)}, ${q(CHANNEL_NAME)}, 'Local bot testing channel', id FROM users WHERE username = ${q(username)}
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description`,
    // Memberships: creator + bot (composite PK → INSERT OR IGNORE is idempotent).
    `INSERT OR IGNORE INTO channel_members (channel_id, user_id) SELECT ${q(CHANNEL_ID)}, id FROM users WHERE username = ${q(username)}`,
    `INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (${q(CHANNEL_ID)}, ${q(BOT_USER_ID)})`,
    // Default the seeded admin's ephemeral-channel bot to echobot so the per-user
    // feature works end-to-end out of the box (creating an ephemeral channel
    // auto-adds echobot). Set NULL to opt out.
    `UPDATE users SET ephemeral_bot_id = ${q(BOT_USER_ID)} WHERE username = ${q(username)}`,
  );
}

const sql = statements.join(';\n') + ';';

const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'threads', '--local', '--config', 'wrangler.toml', '--command', sql], {
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
});

if (res.status !== 0) {
  console.error('Seed failed. Did you run `npm run db:migrate:local` first?');
  process.exit(res.status ?? 1);
}

console.log(`\nSeeded admin user "${username}" (password: ${password})`);
if (SEED_BOT) {
  console.log(`Seeded bot fixture. Stable values for a bot .env (e.g. examples/echo-bot/.env):
  THREADS_API_URL=http://localhost:8788
  THREADS_BOT_TOKEN=${BOT_TOKEN}
  THREADS_BOT_USER_ID=${BOT_USER_ID}
  THREADS_BOT_USERNAME=${BOT_USERNAME}
  THREADS_CHANNEL_ID=${CHANNEL_ID}`);
  console.log(`Set admin "${username}" ephemeral_bot_id -> ${BOT_USERNAME}.`);
}
