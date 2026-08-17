#!/usr/bin/env bash
#
# End-to-end local test of the webhook delivery path.
#
# What it does, top to bottom:
#   1. migrate + seed local D1 (admin "dan" + "echobot" bot in #bot-test)
#   2. start `wrangler dev` (the API) on :8788 if not already running
#   3. log in as the admin and mint a bot API token WITH a webhook pointing at a
#      local receiver (captures the one-time HMAC secret)
#   4. start the receiver process with that secret + token
#   5. post a message as the human admin into #bot-test
#   6. the API fires the webhook -> receiver verifies the signature and replies
#      over REST -> we print the resulting channel messages
#
# Webhook URLs normally must be public https (SSRF guard). Local dev sets
# WEBHOOK_ALLOW_INSECURE_URLS=true in api/.dev.vars, which lets the webhook point
# straight at http://localhost - no tunnel needed.
#
# Requires: node, jq, wrangler. Usage:  api/scripts/webhook-e2e.sh
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$API_DIR"

API_PORT=8788
RECV_PORT=9099
API_URL="http://localhost:${API_PORT}"
WEBHOOK_URL="http://localhost:${RECV_PORT}/threads"

# Seed fixture constants (see scripts/seed-local.mjs).
ADMIN_USER="dan"
ADMIN_PASS="dan-password-123"
BOT_USER_ID="seed-echobot-user"
CHANNEL_ID="seed-bot-test-channel"

STARTED_WRANGLER=""
WRANGLER_PID=""
RECEIVER_PID=""

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

cleanup() {
  log "cleaning up"
  [[ -n "$RECEIVER_PID" ]] && kill "$RECEIVER_PID" 2>/dev/null || true
  if [[ -n "$STARTED_WRANGLER" && -n "$WRANGLER_PID" ]]; then
    kill "$WRANGLER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
log "ensuring webhook tables + seeding local D1"
# Prefer the normal migration runner; if the local migration bookmark is out of
# sync with an existing DB (a common local-dev state), fall back to applying just
# the webhook migration when its tables are missing. Both touch local D1, so this
# must run BEFORE `wrangler dev` takes the file lock.
if ! npm run db:migrate:local >/dev/null 2>&1; then
  HAS_WEBHOOKS="$(npx wrangler d1 execute threads --local --json \
    --command "SELECT name FROM sqlite_master WHERE type='table' AND name='webhooks'" 2>/dev/null \
    | jq -r '.[0].results | length')"
  if [[ "$HAS_WEBHOOKS" != "1" ]]; then
    echo "migration runner out of sync - applying 0054_webhooks.sql directly"
    npx wrangler d1 execute threads --local --file migrations/0054_webhooks.sql >/dev/null
  else
    echo "webhook tables already present - continuing"
  fi
fi
npm run db:seed:local >/dev/null
echo "seeded admin '${ADMIN_USER}' and bot fixture in #bot-test"

# ---------------------------------------------------------------------------
log "ensuring API is running on :${API_PORT}"
if curl -s -o /dev/null "${API_URL}/auth/login" 2>/dev/null; then
  echo "API already up - reusing it"
  echo "NOTE: it must be running with WEBHOOK_ALLOW_INSECURE_URLS=true (api/.dev.vars)"
else
  echo "starting wrangler dev ..."
  npm run dev >/tmp/wh-wrangler.log 2>&1 &
  WRANGLER_PID=$!
  STARTED_WRANGLER=1
fi
for i in $(seq 1 60); do
  if curl -s -o /dev/null "${API_URL}/auth/login" 2>/dev/null; then break; fi
  sleep 1
  [[ $i -eq 60 ]] && { echo "API never came up; see /tmp/wh-wrangler.log"; exit 1; }
done
echo "API is up"

# ---------------------------------------------------------------------------
log "logging in as admin '${ADMIN_USER}'"
SESSION="$(curl -s -D - -o /dev/null -X POST "${API_URL}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" \
  | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: session=\([^;]*\).*/\1/p' | head -1)"
[[ -n "$SESSION" ]] || { echo "login failed"; exit 1; }
echo "got session"

log "minting bot token + webhook -> ${WEBHOOK_URL}"
MINT="$(curl -s -X POST "${API_URL}/users/${BOT_USER_ID}/api-tokens" \
  -H 'Content-Type: application/json' \
  -H "Cookie: session=${SESSION}" \
  -d "{\"name\":\"webhook-e2e\",\"webhook_urls\":[\"${WEBHOOK_URL}\"]}")"
BOT_TOKEN="$(echo "$MINT" | jq -r '.token // empty')"
WEBHOOK_SECRET="$(echo "$MINT" | jq -r '.webhooks[0].secret // empty')"
WEBHOOK_ID="$(echo "$MINT" | jq -r '.webhooks[0].id // empty')"
if [[ -z "$BOT_TOKEN" || -z "$WEBHOOK_SECRET" ]]; then
  echo "mint failed: $MINT"
  echo "(if the error mentions https/host, the API isn't running with WEBHOOK_ALLOW_INSECURE_URLS=true)"
  exit 1
fi
echo "token minted; webhook ${WEBHOOK_ID} secret captured"

# ---------------------------------------------------------------------------
log "starting webhook receiver on :${RECV_PORT}"
PORT="$RECV_PORT" \
WEBHOOK_SECRET="$WEBHOOK_SECRET" \
THREADS_API_URL="$API_URL" \
THREADS_BOT_TOKEN="$BOT_TOKEN" \
BOT_USER_ID="$BOT_USER_ID" \
  node scripts/webhook-receiver.mjs &
RECEIVER_PID=$!
sleep 1

# ---------------------------------------------------------------------------
log "posting a message as the human admin into #bot-test"
MSG="$(curl -s -X POST "${API_URL}/channels/${CHANNEL_ID}/messages" \
  -H 'Content-Type: application/json' \
  -H "Cookie: session=${SESSION}" \
  -d '{"content":"hello webhook bot"}')"
echo "posted: $(echo "$MSG" | jq -r '.content // .')"

log "waiting for webhook delivery + bot reply ..."
sleep 5

log "webhook delivery health (via GET /users/me/webhooks)"
# Can't query D1 directly while `wrangler dev` holds the local DB lock, so read
# delivery health off the management endpoint instead.
curl -s "${API_URL}/users/me/webhooks" -H "Authorization: Bearer ${BOT_TOKEN}" \
  | jq -r '.webhooks[] | "  \(.url): active=\(.active) failures=\(.failure_count) last_http=\(.last_status)"' \
  || echo "(could not read webhook health)"

log "current #bot-test messages (oldest first)"
curl -s "${API_URL}/channels/${CHANNEL_ID}/messages?limit=10" \
  -H "Cookie: session=${SESSION}" \
  | jq -r '(.messages // .)[] | "  @\(.username): \(.content)"' 2>/dev/null \
  || echo "(could not list messages)"

log "done - if you saw 'echo: hello webhook bot' above, the full loop worked"
