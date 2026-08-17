# Threads echo bot

A complete, runnable reference for creating a bot that interacts on a Threads
instance. The finished code is in [`src/echo-bot.ts`](src/echo-bot.ts); this README
has **every step** to go from an admin account to a running bot.

The bot does one thing: when someone @mentions it in a channel, it replies
`Echo: <their message>` in a thread. That is deliberately trivial — the value is the
plumbing (provision → authenticate → subscribe → decide → respond), which is identical
for a real LLM-backed agent. Swap the one `Echo:` line for a model call and you have an
agent.

It is **TypeScript**, typed against the project's OpenAPI spec: request/response bodies
and event shapes are imported from the generated types (`api/generated/types/`), so a
wrong field name or `message_type` fails `npm run typecheck`. The bot is *run* with
[`tsx`](https://tsx.is), which strips types without type-checking — so `npm start` works
even before those (gitignored) types are generated; only `typecheck` needs them.

## What you need

- A Threads instance and its API base URL.
- An **admin account** on that instance (a user whose `is_admin` flag is set). Everything
  below is done with that admin's own API token — no server secrets, no shell access to
  the worker.

Set these once for the commands below:

```bash
export THREADS_API="https://your-instance.example.com/api"   # no trailing slash
```

> **API base URL.** On a combined deployment (client + API in one Worker) the REST API
> is served under **`/api`** — so the base is `https://<origin>/api`. WebSockets resolve
> under that same base (`<base>/ws/:channelId`), so the bot derives its WS URL from
> `THREADS_API_URL` directly. Developing against a standalone local API? Use
> `http://localhost:8788` (no `/api` prefix) — every step is otherwise identical.

### Local quick start (skip Steps 1–4)

The API repo seeds a stable bot-test fixture for you. From `api/`:

```bash
npm run setup:local   # migrate + seed: admin user, an echobot, a bot-test channel
npm run dev
```

This creates an `echobot` bot, a `bot-test` channel, and the memberships — all with
**fixed** ids/token, so local testing is repeatable (unlike provisioning via the API,
which assigns new random ids each time). Copy these into `.env` and you're ready to
`npm start`:

```
THREADS_API_URL=http://localhost:8788
THREADS_BOT_TOKEN=seed-echobot-token-local-dev
THREADS_BOT_USER_ID=seed-echobot-user
THREADS_BOT_USERNAME=echobot
THREADS_CHANNEL_ID=seed-bot-test-channel
```

Log in to the client as `dan` / `dan-password-123`, open **bot-test**, and message
`@echobot`. (The API test suite wipes local D1 — rerun `npm run db:seed:local` after
tests; the values above stay the same.) Steps 1–4 below are the real-instance path.

## Two surfaces

> **Recommended receive path: `GET /events`.** New bots should prefer the
> owner-scoped `/events` socket — **one** connection that streams events for every
> channel and DM the bot belongs to (including ones it joins later), each tagged
> with `channelId` and a `room` object. It removes the per-channel connection
> management (discovery, one socket each, per-socket reconnect) that this example
> implements. **This reference demonstrates the per-channel `GET /ws/:channelId`
> (one socket per channel)** path because it also shows typing signals and
> per-channel lifecycle, which `/events` intentionally doesn't carry. Both are
> fully supported; see the [agent integration guide](../../docs/agent-integration-guide.md#1-connect-to-the-event-stream)
> for the `/events` flow.

A bot integrates over two surfaces (plus an optional presence socket):

| Surface | Endpoint | Direction | Use for |
| --- | --- | --- | --- |
| **WebSocket** | `GET /ws/:channelId` | receive **+** send | live channel events (messages, reactions, members, joins); send `typing_start`/`typing_stop`/`ping` signals **and** correlated `message.create`/`reaction.add` actions |
| **REST** | `POST /messages/:id/replies`, `/messages/:id/reactions`, `/channels/:id/read`, `/bots/self/capabilities`; `GET /channels`, `/dms` | send **+** discover | durable state (replies, reactions, read receipts, capabilities) and finding which channels/DMs to open |
| **Presence WS** | `GET /ws/presence` | receive **+** keepalive | mark the bot **online** just by holding it open; receive `presence_snapshot` / `presence_update` for who else is online |

The two surfaces overlap on purpose: creating a message or reaction works over **either**
REST or a WebSocket action. REST is simpler and returns the created row directly; the WS
action saves a round-trip when you already hold the socket and just want an ack. This bot
uses REST for replies and WS actions for the reaction mirror / welcome message, to show
both.

A bot hears about activity by holding an authenticated WebSocket open. This example
holds one to **each channel and DM it belongs to** (the per-channel path),
finding them with `GET /channels` + `GET /dms`; a new bot would instead hold a single
`GET /events` socket and skip discovery entirely. There is no webhook / HTTP-callback
delivery in this example. Durable actions (replies, reactions, read receipts) go over
REST; ephemeral signals (typing) go over the socket.

---

## Step 1 — Get an admin API token

This is the credential *you* (the admin) use to provision the bot. Two ways:

- **In the UI:** open **User settings → API tokens** (visible to admins), create a
  token, and copy it.
- **Via the API:** log in, then mint a token for yourself.

```bash
# log in (sets a session cookie)
curl -sc cookies.txt -X POST "$THREADS_API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"<your-admin-username>","password":"<your-password>"}'

# mint your own admin token (admin-only)
curl -sb cookies.txt -X POST "$THREADS_API/users/me/api-tokens" \
  -H "Content-Type: application/json" -d '{"name":"bot-admin"}'
# → {"token":"<ADMIN_TOKEN>","name":"bot-admin"}

export ADMIN_TOKEN="<ADMIN_TOKEN>"
```

This token authenticates as you, an admin, and is what authorizes the next two steps.

## Step 2 — Create the bot user

A bot is just a `user` with `role: "bot"`. Create one with your admin token:

```bash
curl -s -X POST "$THREADS_API/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"echobot","displayName":"Echo Bot","password":"'"$(openssl rand -hex 24)"'","role":"bot"}'
# → {"id":"<BOT_ID>","username":"echobot","displayName":"Echo Bot"}

export BOT_ID="<BOT_ID>"
```

The bot logs in via its token, not its password, so a random throwaway password is fine.

## Step 3 — Mint the bot's API token

Mint a token **for the bot** (by id) using your admin token. This is the bot's runtime
credential:

```bash
curl -s -X POST "$THREADS_API/users/$BOT_ID/api-tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"echobot-runtime"}'
# → {"token":"<BOT_TOKEN>","name":"echobot-runtime"}

export BOT_TOKEN="<BOT_TOKEN>"
```

The raw `token` is shown **once** — treat it like a password. It is the single
credential the bot uses for both WebSocket and REST.

**Verify it authenticates as the bot:**

```bash
curl -s "$THREADS_API/users/me" -H "Authorization: Bearer $BOT_TOKEN"
# → {"id":"<BOT_ID>","username":"echobot","role":"bot", …}
```

> `POST /users/:id/api-tokens` is the admin-flag-gated endpoint that lets an admin mint
> a token for another user, authorized by the admin's own session/bearer credential.

## Step 4 — Put the bot in a channel

The bot must be a **current member** of any channel it subscribes to — otherwise the
WebSocket upgrade and message sends return `403`. Either invite it from the UI, or use
its token to create a channel (it becomes the first member) and add a human:

```bash
# create a channel as the bot (bot becomes first member)
curl -s -X POST "$THREADS_API/channels" -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"bot-lab","description":"Bot testing"}'
# → {"id":"<CHANNEL_ID>","name":"bot-lab", …}

# add a human so there is someone to talk to it
curl -s -X POST "$THREADS_API/channels/<CHANNEL_ID>/members" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"<human-username>"}'
```

## Step 5 — Configure and run the bot

Copy `.env.example` to `.env` and fill in the values gathered above:

```
THREADS_API_URL=https://your-instance.example.com/api
THREADS_BOT_TOKEN=<BOT_TOKEN>
THREADS_BOT_USER_ID=<BOT_ID>
THREADS_BOT_USERNAME=echobot
THREADS_CHANNEL_ID=<CHANNEL_ID>   # optional — see note below
```

> **`THREADS_CHANNEL_ID` is optional.** The bot auto-discovers every channel and DM it
> belongs to (`GET /channels` + `GET /dms`) and re-checks every 30s, so it picks up new
> invites and DMs on its own. Set this only to *also* pin a specific channel, or use
> `THREADS_CHANNEL_IDS=a,b,c` for several. The local seed sets it so Step-0 testing has a
> guaranteed channel even before you create others.

Then:

```bash
npm install   # ws + the TypeScript dev tools (tsx, typescript, @types/*)
npm start     # tsx watch src/echo-bot.ts — no build step; reloads on save
# [caps] advertised capabilities (dm_allowed=[dan])
# [presence] connecting
# [presence] online
# [sync] subscribed to 1 new channel(s); 1 total
# [ws] connected: <CHANNEL_ID>
```

Message `@echobot` in the channel (from the UI or the API). The bot logs the message
and its reply, and the echo appears as a threaded reply:

```
[msg] dan: @echobot hello?
[reply] posted <reply-id> in thread <parent-id>
```

### Type-checking (optional)

`npm start` does **not** type-check (tsx strips types). To check the bot against the
spec, generate the types first — they're produced from `api/openapi/*.yaml` and are
gitignored, so they may not exist on a fresh clone:

```bash
npm run gen-types   # → api/generated/types/{threads,ws-events}.d.ts
npm run typecheck   # tsc --noEmit
```

`gen-types` just calls the API package's `openapi:types` script, so the `api/`
dependencies must be installed (the local quick start already does this).

---

## How the code works

### Types (the `import type` block)

REST bodies (`SendMessageRequest`, `AddReactionRequest`, `UpdateSelfCapabilitiesRequest`)
and the created-message response (`Message`) come straight from the generated
`components['schemas']`, so the compiler rejects a misspelled field or an invalid
`message_type`. The `api<T>()` helper is a thin typed `fetch` wrapper — it returns the
response typed as `T` and throws on non-2xx.

> **One spec quirk worth knowing.** `openapi-typescript` rewrites each WebSocket event's
> `type` to the *schema name* (e.g. `"MessageEvent"`) as a synthetic discriminator, but
> the value actually on the wire is the OpenAPI `const` (`"message"`). So the bot
> narrows on the raw string (`frame.type === 'message'`) and re-maps the event type
> (`Omit<MessageEvent, 'type'> & { type: 'message' }`) to keep the runtime check and the
> static type in agreement. Outbound socket signals (`typing_start`/`typing_stop`/`ping`)
> are a small hand-written union for the same reason.

### Discover & subscribe (`syncSubscriptions()` → `connect()`)

A bot listens on **one WebSocket per channel**, and it discovers which channels to open
rather than hard-coding them:

- `GET /channels` — every regular (non-DM) channel the bot is a member of.
- `GET /dms` — every direct-message channel.

The union (plus any `THREADS_CHANNEL_ID(S)` you pin) becomes the subscription set.
`ensureConn()` opens exactly one connection per channel id; each connection has its own
reconnect/backoff and keepalive, so one flaky channel never takes down the others.

Because a brand-new channel invite or a freshly-opened DM does **not** arrive on a
socket the bot already holds, `syncSubscriptions()` also runs on a timer
(`DISCOVERY_INTERVAL_MS`, 30s) and opens connections for anything new. That timer is how
the bot notices *"a human just DMed me."*

Each connection opens `GET /ws/:channelId` with the bot token as a **Bearer header** on
the upgrade. The API base URL becomes the WS URL by swapping the scheme (`https`→`wss`,
`http`→`ws`).

> **Why the `ws` package and not Node's built-in `WebSocket`?** The global
> `WebSocket` constructor can't set request headers, and Threads authenticates the
> upgrade from the `Authorization` header (a bot has no session cookie). The `ws`
> package lets us pass `{ headers }`.

### Presence (`connectPresence()`)

A separate, channel-independent socket — `GET /ws/presence` — drives the **online
indicator**. Simply holding it open marks the bot online (the green dot); closing it (or
missing heartbeats) drops it after a short grace period. The events it pushes —
`presence_snapshot` (initial who's-online map) and `presence_update` (`{userId, online}`
deltas) — keep the bot's `online` set current, ready for presence-aware behaviour.

> **Heartbeat runs the *opposite* way here.** On a channel socket the bot sends `ping`
> and the server replies `pong`. On the presence socket the **server** sends `ping` and
> the bot must reply `pong` — miss two and you're dropped. The bot does both: it answers
> the server's `ping`, *and* sends its own `ping` (the server auto-answers `pong`) to
> detect a half-open socket. Same reconnect-with-backoff as the channel sockets.

### Dispatch (`route()`)

Every frame from the socket flows through `route()`, which switches on the wire `type`
and calls a handler for the events this bot cares about — `message`, `reaction_added`,
`member_added`, `member_removed`, `channel_archived`/`channel_deleted`,
`bot_restart_requested`, and the `action_result`/`action_error` acks — and ignores the
rest (typing, presence, pong, …). The sections below walk the message path first, then
the others.

> **channelId matters for member/channel events.** When the bot is removed from a channel,
> the server delivers `member_removed` (target = the bot) on *every* socket the bot holds,
> not just the affected one. So those handlers compare `event.channelId` to the
> connection's own id and act only on a match — otherwise one removal would tear down all
> connections. (Message and reaction events are already scoped to their channel's socket.)

### Decide (`onMessage()`)

Each new message arrives as a `type: "message"` event:

```json
{
  "type": "message",
  "id": "<message-id>",
  "channelId": "<channel-id>",
  "userId": "<sender-id>",
  "username": "dan",
  "userRole": "human",
  "content": "@echobot hello there",
  "threadId": null,
  "mentions": [{ "userId": "<bot-id>", "username": "echobot" }],
  "messageType": "human",
  "autoRespondBotId": null,
  "processingMode": "immediate"
}
```

(Full contract: `MessageEvent` in
[`api/openapi/ws-events.yaml`](../../api/openapi/ws-events.yaml).)

The response policy:

1. **Ignore your own output** — skip if `event.userId === BOT_USER_ID`. Without this you
   loop forever.
2. **Only react to human chat by default** — skip if `event.messageType` is set and not
   `"human"` (bots also emit `progress` / `tool_output` / `thinking` traces).
3. **Dedup** — track handled `event.id`s so a restart can't double-reply.
4. **Is it for me?**
   - In a **channel**, respond when mentioned (`event.mentions` contains your
     `userId`/`username`) **or** the channel auto-routes to you
     (`event.autoRespondBotId === BOT_USER_ID`).
   - In a **DM**, respond to *every* human message — a DM is 1:1, so no @mention is
     needed. The connection carries an `isDm` flag set at discovery time, and `route()`
     skips the mention check for it.

> **Multi-bot loop guard:** when a *bot* sends a message, the server only delivers it
> over the WebSocket to other bots explicitly @mentioned in it. A per-channel circuit
> breaker also pauses delivery to bots if a loop is detected.

### Advertise (`advertiseCapabilities()`)

On startup the bot announces what it can do with `POST /bots/self/capabilities`:

```bash
curl -X POST "$THREADS_API/bots/self/capabilities" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"dm_allowed_usernames":["dan"]}'
```

The endpoint is **self-scoped** — a bot updates its own row, so its runtime token is
enough (no admin token). Recognised keys:

- **`dm_allowed_usernames`** / **`dm_allowed_user_ids`** — humans allowed to DM the bot
  (the `dan` account is allowed globally; this opts in others).
- **`models`** — model ids the bot exposes; the client renders these as a **DM model
  picker**. An echo bot has no models, so it omits this key — and because the endpoint
  replaces the whole capabilities object, sending the call without `models` also clears
  any value a previous run stored (so the picker disappears).

### Engage (`respond()`)

A real agent's turn isn't a single REST call — it's a small lifecycle the human watches
unfold. The bot walks all of it so the beats are visible in one place; an LLM-backed
agent fills the same beats while a model streams:

1. **Acknowledge** — drop a `👀` reaction (`POST /messages/:id/reactions`) so the sender
   sees the message landed before the answer is ready. Re-adding the same emoji is a
   server-side no-op, so it stays idempotent across restarts.
2. **Show work** — `typing_start` over the socket. Typing is a WebSocket-only signal
   that **auto-expires** server-side, so a crash can't leave the bot stuck "typing".
3. **Answer — in the channel, or in a thread.** By default the bot posts its answer
   **directly in the channel** as a top-level `response` (`POST /channels/:id/messages`).
   Only when the sender's message contains the word **"thread"** (`/\bthread\b/i`) does it
   answer **in a thread** instead (`POST /messages/:id/replies`) — and only then does it
   stream a non-final **trace** (`thinking`/`progress`/`tool_output`, the same endpoint
   with a different `message_type`) first, since a trace belongs under the thread.

   ```bash
   # default: top-level channel message
   curl -X POST "$THREADS_API/channels/<channel-id>/messages" \
     -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
     -d '{"content":"Echo: …","message_type":"response"}'

   # "thread" in the message → threaded reply (resolves channel + thread root for you;
   # if <message-id> is itself a reply, it attaches to the existing thread root)
   curl -X POST "$THREADS_API/messages/<message-id>/replies" \
     -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
     -d '{"content":"Echo: …","message_type":"response"}'
   ```

   `message_type` accepts `human`, `response`, `progress`, `tool_output`, `thinking`; use
   **`response`** for the final answer. Pass `threadId` to `/channels/:id/messages` to post
   into an existing thread without replying to a specific message.
4. **Tidy up** — `typing_stop`, then `POST /channels/:id/read` to clear the unread badge,
   mirroring what a human client does when it "sees" the channel.

Steps 1 and 4 (and the trace) are independent — keep the ones that fit your UX, drop the
rest.

### Send over the socket (`wsAction()`)

`message.create` and `reaction.add` can also be sent **as WebSocket actions** instead of
REST. Each carries a caller-chosen `actionId`; the server answers with `action_result`
(or `action_error`) bearing the same id. `wsAction()` sends one and returns a promise that
the `onActionAck()` handler resolves when the matching ack arrives (with a 10s timeout):

```jsonc
// → bot sends
{ "type": "reaction.add", "actionId": "act-7", "messageId": "…", "emoji": "🎉" }
// ← server replies
{ "type": "action_result", "actionId": "act-7", "action": "reaction.add", "status": 201, "result": { … } }
```

The two features below use this path so it's exercised end-to-end.

### React, greet, tear down (the other handlers)

Beyond messages, the bot acts on a few more events — each with the same self-ignore and
idempotency discipline:

- **`reaction_added` → mirror.** When a human reacts to one of the bot's *own* messages
  (tracked in `myMessages`), it mirrors the emoji back via a `reaction.add` WS action. The
  self-ignore (`userId === BOT_USER_ID`) keeps it from reacting to its own mirror, and
  `reaction.add` is idempotent, so it can't spiral.
- **`member_added` → greet.** When a human joins a channel the bot is in, it posts a
  `👋 Welcome` via a `message.create` WS action. (Skipped for DMs and for the bot being
  added to itself — discovery handles that.)
- **`member_removed` / `channel_archived` / `channel_deleted` → tear down.** Stop listening
  to a channel the bot can no longer use: `teardown()` ends the reconnect loop and forgets
  the channel. (A channel pinned in `THREADS_CHANNEL_IDS` is retried on the next sweep.)
- **`bot_restart_requested` → soft restart.** An admin can ask the bot to restart; it drops
  every connection and re-bootstraps (re-advertise capabilities, re-discover channels). A
  `restarting` flag debounces the duplicate the bot receives on each socket. A production
  bot might instead `process.exit(0)` and let its supervisor relaunch to load new *code*.

### Stay connected

`src/echo-bot.ts` also handles the realities of a long-lived connection:

- **Reconnect with backoff** on `close`/`error` (1s → 30s cap).
- **App-level keepalive** — sends `{"type":"ping"}` every 30s; the server replies
  `{"type":"pong"}` (protocol ping/pong is unreliable through Cloudflare's edge).
- **Graceful shutdown** on `SIGINT`.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| WS upgrade returns `403` | Bot is not a current member of the channel, or wrong channel id. |
| WS upgrade returns `401` | Missing/invalid `Authorization: Bearer` header on the upgrade. |
| `POST /users/:id/api-tokens` returns `403` | Your token isn't an admin's (the `is_admin` flag gates it). |
| Connected, but no messages | Over-filtering — check `event.type === "message"`, your mention logic, and that the sender isn't the bot itself. |
| Receives but can't reply | Use REST (`POST /messages/:id/replies`) with the Bearer header and `Content-Type: application/json`; confirm membership. |
| Replies show as top-level | Use `POST /messages/:id/replies`, not `/channels/:id/messages` without a `threadId`. |
| Two bots never see each other | Expected: bot→bot WS delivery only on explicit @mention. |

## Going further

The reference now covers the bot surface end-to-end — capabilities, the engagement
lifecycle, multi-channel + DM discovery, the broader event router, and both the REST and
WebSocket send paths. From here:

- **Make it a real agent.** Replace the `Echo:` line with a model call. The plumbing
  around it (decide → acknowledge → stream traces → answer) is already where an LLM-backed
  agent's would go.
- **Cap the in-memory sets.** `handled` and `myMessages` grow without bound; a long-running
  bot should use an LRU or TTL.
- **Persist dedup across restarts** if you need exactly-once handling stronger than the
  in-process `handled` set.
