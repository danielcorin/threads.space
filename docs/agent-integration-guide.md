# Threads agent integration guide

This guide documents the working path for connecting an external agent to Threads. For a complete, runnable reference implementation, see [`examples/echo-bot`](../examples/echo-bot/).

## Mental model

Threads has three integration surfaces, and they overlap on purpose:

1. **WebSocket** — receive live events and send correlated `message.create` / `reaction.add` actions (each carries an `actionId` you choose; the server acks with a matching `action_result` / `action_error`). There are two endpoints:
   - **`GET /events` — recommended.** One owner-scoped socket that streams events for **every channel and DM the bot is a member of**, including ones it joins later. No per-channel connection management; every event is tagged with the `channelId` and a `room` object it belongs to. This is the preferred path for agents.
   - **`GET /ws/:channelId` — per-channel alternative.** The channel is implied by the connection. It is the path to use when you need ephemeral `typing_start` / `typing_stop` signals.
2. **Webhooks** — receive the same bot-visible channel events as signed HTTP POSTs to URLs registered on the bot user. Useful when an agent can't hold a WebSocket open at all.
3. **REST API** — create messages and thread replies, add reactions, mark read, and discover channels/DMs (`GET /channels`, `GET /dms`). REST returns the created row directly and needs no open socket.

Creating a message or reaction works over **REST** or the **WebSocket action path**. **REST is the simpler default** and is what this guide uses; the WebSocket action path just saves a round-trip when you already hold the socket and want an ack (the [`echo-bot`](../examples/echo-bot/) reference exercises both). Unknown WebSocket message types are still silently ignored.

## Native framework adapters

When an agent framework exposes a native messaging/platform/plugin surface, use that surface instead of putting a generic OpenAI-compatible proxy in front of it. For example:

- Hermes should integrate as a gateway platform adapter (`BasePlatformAdapter`) that opens Threads `/events` and sends via Threads REST.
- OpenClaw should integrate as a channel plugin (`openclaw.plugin.json` with `channels: ["threads"]`) that maps Threads events into OpenClaw's channel ingress and maps outbound responses back to Threads REST.
- For Hermes tool-progress reporting, the adapter must override `edit_message` as
  well as `send`; Hermes uses editable progress bubbles and may drop native tool
  progress when the platform leaves `BasePlatformAdapter.edit_message` unchanged.

The canonical, self-contained recipe for these framework-native targets lives in [`agents.txt`](../agents.txt). Copyable prompts for general coding agents, Hermes, and OpenClaw live in [`docs/agent-integration-prompts.md`](./agent-integration-prompts.md). Keep `agents.txt` complete enough for an isolated coding agent to build the adapter without reading this repository.

## Seamless framework onboarding

A coding agent should not need the Threads source tree to build a correct
integration. Give it these inputs instead:

- the running API base URL and hosted docs: `/agents.txt`, `/openapi.json`, and
  `/ws-events.json`
- a pre-provisioned bot token, bot id, bot username, and optional default channel
- the framework's installed docs, CLI help, examples, and type definitions
- the framework-specific prompt from [`agent-integration-prompts.md`](./agent-integration-prompts.md)
- an acceptance test that posts a real user turn and checks Threads state through
  the public API

The expected artifact is framework-owned integration code: a Hermes platform
adapter, an OpenClaw channel plugin, or the equivalent native extension. Docker is
only useful as an isolation boundary for evaluation; do not bake Docker paths or
Compose assumptions into reusable integration code.

Success means all of the following are true:

- the native adapter/plugin is installed and loaded by the framework
- the bot holds one authenticated `/events` socket and reconnects with keepalive
- accepted human messages enter the framework's normal runtime, not a bypass path
- final answers come back as `message_type: "response"` with `metadata.trigger_id`
- every accepted turn is wrapped in a Threads process and closed cleanly
- real tool calls, when the framework exposes them, appear as grouped
  `tool_output` rows and increment the process tool count
- cancellation and provider/runtime errors are reflected in process state

For the local Hermes/OpenClaw harness, run:

```bash
cd examples/agent-containers
npm run verify:hermes
npm run verify:openclaw
```

Those commands deliberately validate persisted API state rather than the UI: they
post a marker prompt, request one harmless terminal/shell tool call, and assert
that the final response, process row, tool row, and full tool body all exist.

## Framework lessons learned

Hermes-specific:

- Use a gateway platform plugin (`kind: platform`) and implement both `send()` and
  `edit_message()`. Current Hermes gateway builds use editable progress bubbles
  for tool progress; without `edit_message()`, tool progress can be dropped or
  never grouped correctly.
- Set `display.platforms.threads.tool_progress: verbose` and
  `tool_preview_length: 0` for Threads. Otherwise Hermes may truncate terminal
  command bodies before the adapter can report them.
- Set an explicit `model.max_tokens` cap, such as `8192`, when using OpenRouter
  Anthropic models. Without it, Hermes can request the model's large native output
  ceiling and OpenRouter may reject the call even for small prompts.
- Treat provider failures as `progress` or an error final response and close the
  process as `error`; do not count them as tool calls.

OpenClaw-specific:

- Build a channel plugin with `channels: ["threads"]` and use the installed
  OpenClaw channel SDK. A generic bridge hides the channel/runtime callbacks needed
  for the Threads process and tool UI.
- Put tool/progress callbacks on the run/reply options object the dispatcher
  actually consumes for the installed version. Misplaced callbacks can still allow
  final replies while producing no tool rows.
- De-duplicate repeated lifecycle callbacks and do not turn generic notices such
  as `Reply started` into `tool_output`. Count only real tool/command events as
  Threads `tool_call` activity.
- Pin OpenRouter provider metadata for large-output models when needed. For Opus
  through OpenRouter, set the selected model's configured `maxTokens` to a local
  validation value such as `8192`; otherwise OpenClaw can request `128000` output
  tokens and receive a provider-side credit/max-token rejection before tools run.
- Default to visible top-level `response` messages in channels/DMs for local
  validation, while preserving `metadata.trigger_id`; allow deployments to opt
  into thread-pane replies.

## Prerequisites

Provisioning a bot is **self-service for any admin** — a user whose `is_admin`
flag is set — using that admin's **own API token**. No server secret and no
shell access to the Worker are required. The steps below
produce:

- a Threads bot user (`role: "bot"`)
- an API token for that bot user (its runtime credential)
- optional webhook URL registrations for HTTP event delivery
- membership in the target channel(s)/DM(s)

Base URLs:

- API: `https://your-instance.example.com/api` — on a combined client+API
  deployment the REST API is served under `/api`; a standalone API host omits it.
- WebSocket (recommended): `<api-base>/events` — one socket for all of the bot's
  channels; the same base with the scheme swapped to `wss://`.
- WebSocket (per-channel): `<api-base>/ws/<channel-id>`.
- Webhook receiver: your HTTPS endpoint, for example `https://agent.example.com/threads/webhook`.

The commands below assume:

```bash
export THREADS_API="https://your-instance.example.com/api"   # no trailing slash
```

> A worked end-to-end version of this provisioning flow (with a runnable bot)
> lives in [`examples/echo-bot/README.md`](../examples/echo-bot/README.md).

## Admin setup

### 1. Get an admin API token

This is the credential *you* (the admin) use to provision the bot — not a server
secret. Either create one in the UI (**User settings → API tokens**, visible to
admins), or mint one for yourself via the API:

```bash
# log in (sets a session cookie)
curl -sc cookies.txt -X POST "$THREADS_API/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"<your-admin-username>","password":"<your-password>"}'

# mint an explicitly-scoped provisioning token (admin session required)
curl -sb cookies.txt -X POST "$THREADS_API/users/me/api-tokens" \
  -H "Content-Type: application/json" \
  -d '{"name":"bot-admin","scopes":["threads:read","threads:write","users:provision","tokens:manage"]}'
# → {"token":"<ADMIN_TOKEN>","name":"bot-admin"}

export ADMIN_TOKEN="<ADMIN_TOKEN>"
```

Ordinary API tokens default to `threads:read` and `threads:write`. Administrative
automation is denied unless the token was explicitly issued with
`users:provision` and/or `tokens:manage`. Password resets and security-sensitive
account changes require an interactive browser session.

The raw API token is returned only in the creation response. Threads persists a
keyed one-way verifier plus a non-secret identifier, never a recoverable token.
Revocation immediately closes WebSockets authenticated by that token.

### 2. Create the bot user

A bot is just a `user` with `role: "bot"`. Create one with your admin token via
`POST /users` (Bearer auth — no server secret):

```bash
curl -s -X POST "$THREADS_API/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"username":"my-agent","displayName":"My Agent","password":"'"$(openssl rand -hex 24)"'","role":"bot"}'
# → {"id":"<BOT_ID>","username":"my-agent","displayName":"My Agent"}

export BOT_ID="<BOT_ID>"
```

The bot logs in via its token, not its password, so a random throwaway password
is fine.

### 3. Mint the bot's API token

Mint a token **for the bot** (by id) with your admin token. This is the bot's
runtime credential, used for both WebSocket and REST:

```bash
curl -s -X POST "$THREADS_API/users/$BOT_ID/api-tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"my-agent-runtime"}'
# → {"token":"<BOT_TOKEN>","name":"my-agent-runtime"}

export BOT_TOKEN="<BOT_TOKEN>"
```

To register webhook delivery at the same time, include `webhook_urls`:

```bash
curl -s -X POST "$THREADS_API/users/$BOT_ID/api-tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"my-agent-runtime","webhook_urls":["https://agent.example.com/threads/webhook"]}'
# → {"token":"<BOT_TOKEN>","name":"my-agent-runtime","webhooks":[{"id":"<WEBHOOK_ID>","url":"https://agent.example.com/threads/webhook","secret":"<WEBHOOK_SECRET>"}]}
```

The raw `token` is shown **once** — treat it like a password. Verify it
authenticates as the bot:

```bash
curl -s "$THREADS_API/users/me" -H "Authorization: Bearer $BOT_TOKEN"
# → {"id":"<BOT_ID>","username":"my-agent","role":"bot", …}
```

> `POST /users/:id/api-tokens` is the admin-flag-gated endpoint that lets an admin
> mint a token for another user — authorized by the admin's own session/bearer
> credential, no server secret.

Webhook management is self-scoped to the authenticated user:

- `GET /users/me/webhooks` — list URLs, status, failure counts, and last delivery time
- `POST /users/me/webhooks` with `{ "url": "https://agent.example.com/threads/webhook" }` — register one URL and return its signing `secret` once
- `DELETE /users/me/webhooks/<id>` — remove a URL; delete and recreate to rotate the secret

### 4. Add the bot to a channel

The bot must be a **current member** of any channel/DM it receives from or sends to —
otherwise the WebSocket upgrade, webhook delivery eligibility, and message sends fail.
Invite it from the UI, or use its own token to create a channel (it becomes the
first member) and add a human:

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

## Agent runtime flow

### 1. Connect to the event stream

Connect **once** to `/events` with the bot token as a Bearer token. That single
socket then receives events for **every channel and DM the bot is a member of** —
there's no need to open or track a socket per channel, and channels the bot joins
later start streaming automatically (membership is the filter, so the bot can
never see a channel it hasn't joined).

```http
GET /events
Authorization: Bearer <bot-token>
Upgrade: websocket
```

The server sends `{ "type": "events.ready" }` once the socket is live, then streams
events. **Every event is tagged with its `channelId` and a `room` object**
(`{ "id": "<channel-id>", "type": "channel" | "dm" }`), so one handler can route by
channel:

```js
import WebSocket from 'ws';

const api = 'https://your-instance.example.com/api';
const wsUrl = api.replace(/^http/, 'ws') + '/events'; // https→wss, http→ws

const ws = new WebSocket(wsUrl, {
  headers: { Authorization: `Bearer ${botToken}` },
});

ws.on('message', async (raw) => {
  const event = JSON.parse(raw.toString());
  if (event.type === 'events.ready') return;
  // event.channelId / event.room identify which channel this event is for
  console.log(event.room, event);
});
```

Things to know about `/events`:

- **Keepalive** is app-level: send `{ "type": "ping" }`, the server replies
  `{ "type": "pong" }`.
- **Sending** works the same as elsewhere — REST (the default below) or a
  `message.create` / `reaction.add` action over this same socket (include the target
  `channelId` in the action payload, since the socket isn't bound to one channel).
- **Typing signals** (`typing_start` / `typing_stop`) are **not** delivered on
  `/events`; use the per-channel socket if you need them.
- **Backpressure:** a slow consumer may have ephemeral events (presence) dropped,
  and a hopelessly-backed-up socket is closed with code `1013` — reconnect and
  backfill recent history over REST.

> **Per-channel alternative.** `GET /ws/<channel-id>` opens a
> socket bound to a single channel; events on it carry no `room` envelope (the
> channel is implied), and it's the only path that delivers typing signals. It
> is useful for integrations that need those signals. The
> [`echo-bot`](../examples/echo-bot/) reference currently demonstrates this
> per-channel approach; prefer `/events` for new agents.

Webhook delivery is the HTTP alternative: Threads POSTs a signed envelope to each
registered URL for the bot. The event payload lives in `data` and uses the same
shape as the WebSocket event:

```json
{
  "event_id": "evt_...",
  "type": "message",
  "timestamp": 1778190000,
  "bot_user_id": "0...",
  "channel_id": "0...",
  "data": {
    "type": "message",
    "id": "0...",
    "channelId": "0...",
    "userId": "0...",
    "username": "dan",
    "content": "@my-agent can you check this?",
    "threadId": null,
    "createdAt": 1778190000,
    "mentions": [{ "userId": "0...", "username": "my-agent" }],
    "attachments": [],
    "metadata": null,
    "messageType": "human",
    "autoRespondBotId": null,
    "processingMode": "immediate"
  }
}
```

Verify `X-Threads-Signature` before parsing side effects. The signature is
`sha256=<hex HMAC>` over `<X-Threads-Timestamp>.<raw request body>` using the
webhook secret returned at creation. Treat delivery as at-least-once: store the
`event_id`, ignore duplicates, and return any `2xx` response after durable
acceptance.

### 2. Listen for message events

New messages arrive with `type: "message"` on WebSockets, or as `data.type: "message"` inside the webhook envelope. Typical fields:

```json
{
  "type": "message",
  "id": "0...",
  "channelId": "0...",
  "userId": "0...",
  "username": "dan",
  "displayName": "Dan",
  "nameColor": null,
  "userRole": "human",
  "content": "@my-agent can you check this?",
  "threadId": null,
  "createdAt": 1778190000,
  "mentions": [{ "userId": "0...", "username": "my-agent" }],
  "attachments": [],
  "metadata": null,
  "messageType": "human",
  "autoRespondBotId": null,
  "processingMode": "immediate"
}
```

(Full contract: `MessageEvent` in [`api/openapi/ws-events.yaml`](../api/openapi/ws-events.yaml).)

A minimal response policy:

- ignore messages authored by your own bot user id — otherwise you reply to yourself in a loop
- ignore non-human message types unless you explicitly handle them — bots also emit `progress` / `tool_output` / `thinking` traces
- in a **channel**, respond when the bot is mentioned in `mentions`, or when `autoRespondBotId` matches your bot id
- in a **DM**, respond to every human message — a DM is 1:1, so no @mention is needed
- preserve the incoming `channelId`
- preserve the triggering message id in `metadata.trigger_id` on final answers
- send final answers to the surface the host expects: top-level channel/DM timeline
  messages use `POST /channels/<channel-id>/messages`; thread-pane answers use the
  triggering message id as the reply target

The server also enforces its own loop guards: bot→bot messages are delivered only to
explicitly @mentioned bots, and a per-channel circuit breaker cuts a runaway loop. When
that breaker trips it broadcasts a `bot_loop_tripped` event
(`{ type, channelId, trippedAt }`) and then **withholds bot-authored messages in that
channel until a human speaks again** — so a bot can stop receiving events mid-exchange by
design. Treat `bot_loop_tripped` as informational (not a message to answer), and don't
retry-storm when your sends stop landing.

### Explicit reaction policy

Reactions can be valid agent triggers when the integration explicitly accepts them. For `reaction_added`, ignore the bot's own reactions and keep bot-on-bot guards, then apply the same ownership policy used for messages (for example, `autoRespondBotId` matches your bot id or the event is in an allowed DM). Accepted reaction triggers should fetch the reacted-to message, rebuild context from canonical Threads state, and may post a threaded reply to the target/root message. Keep acknowledgment reactions idempotent to avoid loops. Treat `reaction_removed` as context-only by default unless the integration deliberately implements removal-triggered behavior.

### 3. Send final answers via REST

For answers that should be visible in the main channel or DM timeline, send a
top-level `response` message:

```http
POST /channels/<channel-id>/messages
Authorization: Bearer <bot-token>
Content-Type: application/json
```

Payload:

```json
{
  "content": "Here is my response.",
  "message_type": "response",
  "metadata": {
    "trigger_id": "<incoming-message-id>",
    "agent": "my-agent",
    "model": "local-model-name"
  }
}
```

Curl example:

```bash
curl -X POST "$THREADS_API/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer $THREADS_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Here is my response.",
    "message_type": "response",
    "metadata": {"trigger_id":"<incoming-message-id>","agent":"my-agent"}
  }'
```

To place the answer in the thread pane instead, use the thread reply endpoint:

```http
POST /messages/<message-id>/replies
```

This endpoint automatically resolves the correct channel and thread. If
`<message-id>` is already a reply, Threads replies to the root thread. If you
instead create a threaded message manually through `POST /channels/<channel-id>/messages`,
include `threadId`:

```json
{
  "content": "Here is my response.",
  "threadId": "<root-parent-message-id>",
  "message_type": "response",
  "metadata": {
    "trigger_id": "<incoming-message-id>"
  }
}
```

### 4. Optional: send progress/thinking/tool updates

The send-message API accepts these `message_type` values:

- `human`
- `response`
- `progress`
- `tool_output`
- `thinking`

For externally visible final answers from bots, use `response`. Use progress/tool/thinking
types sparingly. On their own they render as loose messages; to make them collapse into a
single, cancelable **tool-call rail** with live status and a tool count, wrap the turn in a
**process** — see the next section.

### 5. Optional: drive the tool-call UI (processes)

The `progress` / `tool_output` / `thinking` traces above become one collapsible **"agent
steps"** rail in the client — the tool-call UI — when you wrap the turn in a **process**. A
process is the container for a single agent turn: it gives the rail a live status
(`queued → running → done | error | killed`), a tool-count/token metrics pill, and a
cancel affordance. The traces are the rows inside it.

Two links bind the rows to the rail:

- Every trace message (and the final `response`) carries
  **`metadata: { "trigger_id": "<triggering-message-id>" }`**. The client groups all
  messages sharing a `trigger_id` into one block, anchored under the triggering message.
- The triggering message is stamped with the process via **`POST /messages/<id>/process`**,
  with `status: "processing"`, which drives its live "processing" chip. Creating
  the process row alone is not enough for the active message chip.

The full sequence for one turn — all with the **bot's** bearer token (the
process-advancing writes are bot-only; reads and cancellation are open to any channel
member):

```bash
# Once at bot startup, before consuming events, reconcile turns abandoned by the
# previous incarnation. This is self-scoped by the bot token and safe to repeat.
curl -s -X POST "$THREADS_API/processes/cleanup-by-bot" \
  -H "Authorization: Bearer $BOT_TOKEN"

# 1. Open a process for this turn, keyed to the triggering message.
curl -s -X POST "$THREADS_API/processes" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"channel_id":"<channel-id>","message_id":"<trigger-message-id>","status":"running"}'
# → {"id":"<PROCESS_ID>","status":"running"}

# 2. Stamp the triggering message so its live "processing" chip appears.
curl -s -X POST "$THREADS_API/messages/<trigger-message-id>/process" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"processId":"<PROCESS_ID>","status":"processing"}'

# 3. For each step: post a trace message tagged with trigger_id, then record the tool
#    call on the process (this drives the "ran N tools" count).
curl -s -X POST "$THREADS_API/channels/<channel-id>/messages" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"↳ Bash\n\n**Input**\n```\ngrep claude\n```","message_type":"tool_output","metadata":{"trigger_id":"<trigger-message-id>"}}'
curl -s -X POST "$THREADS_API/processes/<PROCESS_ID>/activity" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"tool_call"}'

# 4. Post the final answer (also tagged with trigger_id), record the reply + token
#    usage, and close the process.
curl -s -X POST "$THREADS_API/channels/<channel-id>/messages" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"Here is my answer.","message_type":"response","metadata":{"trigger_id":"<trigger-message-id>"}}'
curl -s -X POST "$THREADS_API/processes/<PROCESS_ID>/activity" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" -d '{"type":"reply"}'
curl -s -X POST "$THREADS_API/processes/<PROCESS_ID>/activity" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"token_usage","input_tokens":4200,"output_tokens":1300}'
curl -s -X PATCH "$THREADS_API/processes/<PROCESS_ID>" \
  -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" -d '{"status":"done"}'
```

Notes:

- **Chip label** = the *first line* of a trace's `content`. Put the tool name there
  (e.g. `↳ Bash`) and the input/output in a fenced block below — that block becomes the
  expandable chip body.
- **Thread it** by adding `threadId` to each `POST /channels/:id/messages`; the whole rail
  then renders in the thread pane instead of the channel timeline.
- **Agent-set statuses** for the create call and `PATCH /processes/:id`: `queued`, `running`,
  `done`, `error`, `killed`. On failure, `PATCH … {"status":"error"}` so the rail shows
  the error. Startup reconciliation records the server-owned terminal status `restarted`.
- **Cancellation:** any channel member (or admin) can `DELETE /processes/:id` to stop a
  runaway turn. The server marks it `killed` and fans out a **`process_kill`** event over
  the channel WebSocket *and* any registered webhook — listen for it and abort the turn.
- These are **extension** routes (`POST /processes`, `POST /processes/cleanup-by-bot`,
  `PATCH /processes/{id}`, `POST /processes/{id}/activity`, `DELETE /processes/{id}`,
  `POST /messages/{id}/process`);
  full schemas are in the hosted OpenAPI document.
- A complete, runnable reference that posts exactly this stream is
  [`examples/sim-agent`](../examples/sim-agent/).

## Minimal end-to-end example



```js
import WebSocket from 'ws';

const api = 'https://your-instance.example.com/api';
const botToken = process.env.THREADS_BOT_TOKEN;
const botUserId = process.env.THREADS_BOT_USER_ID;
const botUsername = process.env.THREADS_BOT_USERNAME;

// One socket for every channel/DM the bot belongs to — no per-channel setup.
const wsBase = api.replace(/^http/, 'ws'); // https→wss, http→ws
const ws = new WebSocket(`${wsBase}/events`, {
  headers: { Authorization: `Bearer ${botToken}` },
});

ws.on('message', async (raw) => {
  const event = JSON.parse(raw.toString());
  if (event.type !== 'message') return; // skips events.ready and other types
  if (event.userId === botUserId) return;
  if (event.messageType && event.messageType !== 'human') return;

  const mentioned = event.mentions?.some((m) => m.username === botUsername || m.userId === botUserId);
  const shouldRespond = mentioned || event.autoRespondBotId === botUserId;
  if (!shouldRespond) return;

  const answer = `Echo: ${event.content}`;

  const res = await fetch(`${api}/messages/${event.id}/replies`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: answer,
      message_type: 'response',
      metadata: { agent: botUsername },
    }),
  });

  if (!res.ok) {
    console.error('reply failed', res.status, await res.text());
  }
});
```

## Troubleshooting

### Agent never receives messages

For WebSockets, check:

- the URL is `<api-base>/events` (recommended) or `<api-base>/ws/<channel-id>` (per-channel), with the scheme swapped to `wss://` (e.g. `wss://your-instance.example.com/api/events`)
- `Authorization: Bearer <bot-token>` is present during WebSocket upgrade
- the token belongs to the bot user you expect
- the bot is a current member of the channel the event is for
- you are watching `type: "message"` events (and skipping the initial `events.ready` on `/events`)

For webhooks, check:

- the URL appears in `GET /users/me/webhooks` when called with the bot token
- the endpoint returns a `2xx` response quickly after durable acceptance
- `X-Threads-Signature` is verified against the raw request body, not a re-serialized JSON body
- the bot is a current member of the channel or DM that produced the event

### Agent receives pings but cannot respond

Check:

- for thread replies, call `POST /messages/<incoming-message-id>/replies`
- include `Authorization: Bearer <bot-token>`
- include `Content-Type: application/json`
- use `message_type: "response"` for final bot replies
- the bot still has channel membership
- if you send over the socket instead, use a `message.create` action with an `actionId` and wait for the matching `action_result` / `action_error` ack

### Replies show up as top-level messages instead of thread replies

Use `POST /messages/<incoming-message-id>/replies`. If using `POST /channels/<channel-id>/messages`, include `threadId: "<root-parent-message-id>"`.

### The server ignored my WebSocket send

Both sockets accept a fixed set of inbound types — `mark_read`, `ping`, and the `message.create` / `reaction.add` actions (`/ws/:channelId` additionally accepts `typing_start` / `typing_stop`; on `/events` those are ignored). Anything else is silently dropped. For the action types, include an `actionId` and watch for the matching `action_result` / `action_error`; if you get neither, the type or payload is malformed. On `/events`, `message.create` / `reaction.add` must include the target `channelId` in the payload.

## Current limitations and future improvements

- Webhooks are at-least-once and do not provide replay/backfill after the retry budget expires; store `event_id` values and make handlers idempotent.
- Bot provisioning is admin-mediated: an admin can do it with an explicitly scoped provisioning token (no server secret), but ordinary API tokens and non-admins cannot provision bots.
- WebSocket agents should implement reconnect/backoff; webhook agents should monitor failures and rotate secrets by deleting and recreating registrations.
