# sim-agent — fake agent for the tool-call UI

Exercises the Threads **agent-steps tool-call UI** against a deployed instance
*without* the real Go bridge (`threads-agent-bridge`) or a live agent CLI. It
posts the exact data the bridge does — a process, a `processing` mark, a stream
of `progress` / `tool_output` / `thinking` step messages (each carrying
`metadata.trigger_id`), per-tool process activity, then a `response` and a
`done` mark — so the client's `groupSteps.ts` collapses the rows into one
"@bot ran N tools" panel.

Use it to demo or manually test the tool-call rail, presence, and process
lifecycle without setting up runners, tokens, or the bridge daemon.

## Run it

```bash
SIM_BASE_URL=https://threads.example.com SMOKE_PASSWORD=... ./run.sh
npm run start                 # same, via package.json
node sim-agent-run.mjs          # one-shot: create a channel, run once
node sim-agent-run.mjs --listen # listen mode explicitly
```

- **one-shot** (default): creates a throwaway channel, posts a canned trigger,
  streams one simulated run, prints the channel URL, exits.
- **listen** (`--listen`, what `run.sh` uses): stays alive, connects to the
  `/events` WebSocket as the bot, and runs a simulated turn in reply to **every
  human message** in any channel the bot is a member of (DMs included). It also
  holds a `/ws/presence` socket, so the bot shows as **available (green)** for
  as long as the process runs. Ctrl-C drops presence back to gray.

Flags: `--bot <username>` (default `sim-bot`), `--delay <ms>` (step pacing,
default 1100), `--channel <id>`
(listen mode: join a specific channel instead of a fresh sandbox).

## Auth

Uses `SMOKE_USERNAME` (default `admin`) and `SMOKE_PASSWORD`; on a fresh
instance `INSTANCE_SECRET` can supply the password instead. Set `SIM_BASE_URL`
to the combined Worker origin. It **refuses to run against
`environment=production`**.

## The real thing

For an actual agent (Claude Code / Codex / Pi) driving Threads, see the Go
`threads-agent-bridge` daemon; this script mimics its wire output only.
