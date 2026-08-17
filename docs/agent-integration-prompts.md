# Threads agent integration prompts

These prompts are for coding agents that need to implement a real Threads integration
without reading the Threads source repository. They are intentionally not Docker-specific.
Containers can be used to isolate agent processes, but the requested artifact should be
native framework integration code.

## Universal prompt

Use this with a general coding agent such as Codex, Claude Code, Cloud Coder, or a
framework-hosted coding agent.

```text
You are implementing a production-quality Threads integration for <FRAMEWORK>.

Inputs you may use:

- A running Threads API base URL: <THREADS_API_URL>
- Threads published onboarding document: <THREADS_API_URL>/agents.txt
- Threads REST OpenAPI document: <THREADS_API_URL>/openapi.json
- Threads WebSocket event schemas: <THREADS_API_URL>/ws-events.json
- A pre-provisioned bot runtime credential:
  - THREADS_BOT_TOKEN
  - THREADS_BOT_USER_ID
  - THREADS_BOT_USERNAME
  - optional THREADS_CHANNEL_ID / THREADS_HOME_CHANNEL for a test/default channel
- The framework's installed docs, examples, CLI help, and type definitions.

Do not inspect the Threads source repository. Do not implement a generic sidecar that
calls the framework through an OpenAI-compatible `/v1/chat/completions` endpoint unless
the framework has no native messaging/plugin/channel extension surface. The expected
artifact is native integration code for <FRAMEWORK>.

First prove the Threads credential and API base are correct:

1. Fetch `<THREADS_API_URL>/agents.txt`, `/openapi.json`, and `/ws-events.json`.
2. Call `GET /users/me` with `Authorization: Bearer $THREADS_BOT_TOKEN`.
3. Confirm the returned user id/username matches `THREADS_BOT_USER_ID` /
   `THREADS_BOT_USERNAME`.

Build the native integration:

1. Use the framework's native extension mechanism: channel plugin, platform adapter,
   messaging adapter, connector, or equivalent.
2. Hold one authenticated WebSocket connection to `GET /events`.
3. Send app-level keepalives: `{ "type": "ping" }` every 30 seconds.
4. Reconnect with exponential backoff.
5. Accept only `type: "message"` events from humans.
6. Ignore messages from `THREADS_BOT_USER_ID`.
7. Ignore events whose `messageType` exists and is not `human`.
8. In channels, respond only when the bot is mentioned, `autoRespondBotId` equals
   `THREADS_BOT_USER_ID`, or `THREADS_RESPOND_TO_ALL=1`.
9. In DMs, respond to every human message.
10. Preserve trigger metadata: `channelId`, trigger message `id`, optional `threadId`,
    `room.type`, sender id/username, and mention metadata.
11. Submit accepted messages into the framework's normal agent runtime/conversation
    path. Do not bypass the framework's scheduler, memory, tool, or cancellation model.
12. Wrap each accepted turn in Threads' Processes API:
    - Create `POST /processes` with the channel id and trigger message id.
    - Immediately stamp the trigger with
      `POST /messages/:triggerMessageId/process` and `status: "processing"`.
      This drives the visible status indicator on the triggering message; process
      creation alone is not enough for the active chip.
    - Record `reply`, `tool_call`, and token usage activity when available.
    - Close with `PATCH /processes/:processId` to `done`, `error`, or `killed`.
13. Map framework outbound final answers back to Threads REST:
    - Use `POST /channels/:channelId/messages` for answers that should appear in the
      main channel or DM timeline.
    - Preserve `metadata: { "trigger_id": "<triggerMessageId>" }` on final answers.
    - Use `POST /messages/:triggerMessageId/replies` only when the host workflow
      expects the answer in the thread pane.
    - Use `message_type: "response"` for final answers.
14. If the framework exposes progress/tool/thinking hooks, map them to
    `progress`, `tool_output`, or `thinking` messages and include
    `metadata: { "trigger_id": "<triggerMessageId>" }`.
15. If the framework exposes cancellation, listen for Threads `process_kill` events
    and cancel the active run for that trigger/thread.

Security rules:

- Do not print token values, admin passwords, or full environment dumps.
- Do not write secrets into source files or README text. Read them from environment
  variables or the framework's secret/config store.
- If you need to mention a credential in logs, redact it to a short fingerprint.

Verification:

1. Install/enable the native integration in the target framework.
2. Start the framework gateway/runtime with the integration loaded.
3. Confirm the integration connects to Threads `/events` with the bot token.
4. Send a human test message in a channel or DM visible to the bot that asks it to
   reply with `SELF_WIRE_OK`.
5. Verify through the Threads REST API, not only by looking at the UI, that:
   - a process exists for the triggering human message
   - the trigger message was stamped with that process as `status: "processing"`
     while the run was active
   - the trigger's status indicator reaches a terminal state and is not left
     stuck as processing
   - the bot posted a final `message_type: "response"` with
     `metadata.trigger_id` equal to the trigger message id
   - the process was closed as `done`, or as `error` with a useful non-secret
     diagnostic if the provider/runtime failed
6. If the framework exposes tools, send a second test message asking it to run one
   harmless terminal/shell command. Verify at least one real `tool_output` row is
   grouped under the trigger, the full tool input/body is preserved, and the
   process tool-call count increments.
7. If the framework API is insufficient or undocumented, write `BLOCKED.md` with the
   exact missing class, hook, CLI command, type, or lifecycle method.
```

## Hermes prompt

```text
You are implementing Threads as a native Hermes Agent gateway platform.

Use the universal Threads prompt above, plus these Hermes-specific requirements:

- Build a Hermes platform plugin, not an external bridge.
- Use the installed Hermes plugin docs/types for the current version.
- Install into Hermes' user plugin root, commonly:
  - `~/.hermes/plugins/platforms/threads/`
  - `$HERMES_HOME/plugins/platforms/threads/`
  - or the deployment's configured Hermes data/plugin directory.
- Include `plugin.yaml` with `kind: platform`.
- Include an adapter module that follows Hermes'
  `gateway.platforms.base.BasePlatformAdapter` contract.
- Implement `connect()` by opening Threads `/events`, filtering accepted messages,
  and forwarding them into Hermes through the native inbound message path.
- Implement `send(...)` by translating Hermes outbound messages to Threads REST
  replies/messages.
- Implement `edit_message(...)` by patching the previously sent Threads message.
  Hermes uses editable progress bubbles for native tool-progress reporting; if
  the adapter leaves the base `edit_message` in place, Hermes may discard those
  tool-progress events.
- Before handing an accepted turn into Hermes, create a Threads process and
  immediately stamp the triggering message with
  `POST /messages/:id/process` and `status: "processing"` so the Threads status
  indicator appears.
- Configure Hermes for Threads tool progress when possible:
  - `display.platforms.threads.tool_progress: verbose`
  - `display.platforms.threads.tool_preview_length: 0`
  These prevent Hermes from truncating terminal/tool bodies before the Threads
  adapter can report them.
- Set an explicit Hermes `model.max_tokens` output cap when using OpenRouter
  Anthropic models. A cap such as `8192` is a good default for local validation;
  do not let Hermes request a very large native model ceiling unless the operator
  intentionally configured that budget.
- Map Hermes progress-loop sends to `tool_output` or `thinking` only when they
  are real native tool/thinking progress and preserve `metadata.trigger_id`.
  Treat generic status, safety refusal, and error notices as `progress` so they
  do not inflate the process tool-call count.
- Register the platform with `ctx.register_platform(name="threads", ...)`.
- Use env/config for `THREADS_API_URL`, `THREADS_BOT_TOKEN`,
  `THREADS_BOT_USER_ID`, `THREADS_BOT_USERNAME`, and optional `THREADS_HOME_CHANNEL`.
- Leave an operator-facing README explaining install, enable, run, and verification
  steps without printing secrets.
```

## OpenClaw prompt

```text
You are implementing Threads as a native OpenClaw channel plugin.

Use the universal Threads prompt above, plus these OpenClaw-specific requirements:

- Build a channel plugin, not an external bridge.
- Use the installed OpenClaw channel plugin SDK/docs/types for the current version.
- Include `openclaw.plugin.json` with `channels: ["threads"]`.
- Include `package.json` with OpenClaw extension metadata pointing to the built module.
- Implement channel account config from OpenClaw config first, falling back to
  `THREADS_*` environment variables.
- If the selected model is an OpenRouter model with a very large discovered output
  cap, pin its provider catalog metadata to a sane `maxTokens` value such as
  `8192` for validation. For example, configure
  `models.providers.openrouter.models[]` for `anthropic/claude-opus-4.8` and set
  `agents.defaults.model.primary` to `openrouter/anthropic/claude-opus-4.8`.
- Implement inbound by holding one Threads `/events` WebSocket and submitting accepted
  human messages into OpenClaw's native channel ingress/runtime.
- Use stable conversation keys derived from Threads room/channel/thread identity,
  for example `threads:<room.type>:<room.id>` and `event.threadId || event.id`.
- Implement outbound by translating OpenClaw responses to Threads REST replies/messages.
- Use OpenClaw mention/channel helpers when available; do not rely on text parsing alone
  when Threads provides `mentions` and `autoRespondBotId`.
- Wire dispatcher/run callbacks on the object the installed OpenClaw runtime
  actually consumes. In particular, verify tool callbacks fire during a real run;
  a final reply without `tool_output` rows is not a complete Threads integration.
- Use callbacks such as `onToolStart`, `onItemEvent`, `onPlanUpdate`,
  `onCommandOutput`, `onPatchSummary`, and `onReasoningStream` when available.
  De-duplicate repeated lifecycle callbacks, send non-tool status as `progress`,
  send reasoning as `thinking`, and count only real tool/command callbacks as
  Threads `tool_call` activity.
- Enable/pin the plugin using the current OpenClaw plugin install mechanism and verify
  with the framework's plugin inspection command.
- Leave an operator-facing README explaining install, enable, run, and verification
  steps without printing secrets.
```

## What success looks like

A successful implementation is not just a provisioned Threads bot. It is a running
framework-native integration that:

- connects to Threads `/events` with the bot token
- submits accepted user messages into the framework's native runtime
- emits final answers back to Threads as `message_type: "response"`
- wraps every accepted turn in a Threads process
- reports real tool calls as grouped `tool_output` rows when the framework exposes them
- survives reconnects
- avoids loops
- can be installed and restarted by an operator without copying secrets into code

If you have access to the local Threads agent-container harness, the acceptance
commands are:

```bash
cd examples/agent-containers
npm run verify:hermes
npm run verify:openclaw
```

These commands are optional harness conveniences. The generic requirement is the
same on any deployment: verify the integration through public Threads APIs.
