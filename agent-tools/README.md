# Threads Agent Tools

First-party API contracts and distributable agent tooling included directly in
the [`threads.space`](https://github.com/danielcorin/threads.space) source tree.
This directory is ordinary repository content, not a submodule or external
checkout.

No binary releases are currently published; build the tools from source using
the development instructions below.

## Components

- [`contracts/`](./contracts) contains the REST OpenAPI document and WebSocket
  event schemas consumed by the CLI.
- [`cli/`](./cli) contains the contract-derived `threads` command-line client.
- [`bridge/`](./bridge) contains the local daemon that connects Threads events
  to Codex, Claude Code, and Pi. Bridge archives bundle the matching CLI.

The application OpenAPI files under `../api/openapi/` are the source of truth.
Contract checks regenerate this directory and fail if the copies drift.

## Development

From the application repository root:

```bash
npm ci
npm --prefix agent-tools/cli run check
npm run check:bridge
```

Or run both component suites from this directory with `npm run check`.

## Releases

A semantic tag on the parent repository builds one coordinated release with:

- standalone `threads` executables for macOS arm64/x64, Linux arm64/x64, and
  Windows x64;
- `threads-agent-bridge` archives for macOS arm64/x64 and Linux arm64/x64;
- REST and WebSocket contract snapshots;
- component checksums, source manifests, and GitHub build attestations.

See [repository releases](https://github.com/danielcorin/threads.space/releases).
Verify an artifact with:

```bash
gh attestation verify threads-darwin-arm64 --repo danielcorin/threads.space
```
