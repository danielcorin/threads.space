#!/usr/bin/env bash
# Run the simulated agent as @sim-bot in LISTEN mode: it holds a
# /ws/presence socket (so the bot shows available / green) and replies to every
# human message in any channel it belongs to — DMs included — with a canned
# tool-call stream (the "sim-bot ran N tools" panel). Ctrl-C to stop.
#
#   ./examples/sim-agent/run.sh                 # listen as sim-bot
#   ./examples/sim-agent/run.sh --delay 1500    # slow the step stream down
#   ./examples/sim-agent/run.sh --channel <id>  # join a specific channel
#   ./examples/sim-agent/run.sh --thread        # thread every reply (thread-pane test)
#
# A human message posted inside a thread is always answered in that thread; the
# --thread flag additionally threads replies to top-level messages.
#
# For a single non-interactive run instead of listening, call the script directly:
#   node examples/sim-agent/sim-agent-run.mjs
set -euo pipefail
cd "$(dirname "$0")"
exec node sim-agent-run.mjs --listen "$@"
