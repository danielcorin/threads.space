# API contract and agent-tool distribution

Threads publishes its application contract, CLI, and local agent bridge from
one repository and source revision. The complete agent-tool source lives in
[`agent-tools/`](../agent-tools); it is first-party code, not a submodule or a
copy fetched during builds.

## Source of truth

The checked-in source contracts are:

- [`api/openapi/threads.yaml`](../api/openapi/threads.yaml) for the HTTP API.
- [`api/openapi/ws-events.yaml`](../api/openapi/ws-events.yaml) for WebSocket
  payloads.

The Worker JSON documents, app TypeScript types, generated external clients,
caller action catalog, hosted MCP adapter, distributable contracts, and CLI all
derive from these files. Do not edit a generated copy to change the contract.

The pre-commit guard requires the corresponding source contract whenever an
HTTP route or WebSocket event boundary changes. Internal implementation changes
that do not alter a boundary do not require a contract edit.

## Local commands

```bash
# Validate and package the public contract.
npm run api:contract:check

# Check generated CLI contracts, tests, types, and build.
npm --prefix agent-tools/cli run check

# Test and vet the Go bridge.
npm run check:bridge

# Build the current platform's native CLI.
npm run cli:artifacts:build -- --target host
```

Native CLI outputs are written to `agent-tools/cli/dist/cli/`. Supported target
IDs and release filenames are:

| Target | Release asset |
| --- | --- |
| Linux x64 | `threads-linux-x64` |
| Linux arm64 | `threads-linux-arm64` |
| macOS Intel | `threads-darwin-x64` |
| macOS Apple Silicon | `threads-darwin-arm64` |
| Windows x64 | `threads-windows-x64.exe` |

## Live instance discovery

Every deployed instance publishes `GET /api/cli.json` (or `/cli.json` on the
standalone API host). It links the instance-local REST and WebSocket contracts
to the matching source tag, release manifest, CLI checksums, and bridge
checksums in `danielcorin/threads.space`.

The discovery document has one public version boundary: top-level
`schemaVersion: 2`. The release manifest's internal schema version is not
exposed through that contract.

## Contract bundle

`npm run api:contract:build` creates:

```text
threads-api-contract/
  openapi/
    threads.yaml
    ws-events.yaml
  manifest.json
  README.md
```

`manifest.json` records the release version or commit SHA, exact source SHA,
commit timestamp, and file inventory. Release builds may set
`THREADS_ARTIFACT_VERSION`, `THREADS_ARTIFACT_GIT_SHA`, or `SOURCE_DATE_EPOCH`
for an explicit reproducible identity.

## Publishing

The root [distribution workflow](../.github/workflows/distribution-artifacts.yml)
runs manually for build verification and on semantic `vX.Y.Z` tags. A tag
builds and publishes one coordinated release containing:

- the versioned API contract archive;
- five native CLI executables;
- four bridge archives containing the exact matching CLI;
- REST and WebSocket contract copies;
- component checksums and source manifests; and
- GitHub build-provenance attestations.

Before tagging, update the matching versions in `agent-tools/package.json`,
`agent-tools/cli/package.json`, and `agent-tools/release.json`. The release job
refuses to publish when those versions differ from the tag.

The workflow verifies checksums, runs both Linux executables, and compares the
CLI embedded in the Linux bridge archive byte-for-byte with the standalone CLI
before publishing.

Download and verify a tagged release with:

```bash
gh release download <tag> \
  --repo danielcorin/threads.space \
  --pattern 'threads-*' \
  --pattern 'THREADS_*_SHA256SUMS'

sha256sum --check THREADS_CLI_SHA256SUMS
sha256sum --check THREADS_AGENT_BRIDGE_SHA256SUMS
sha256sum --check THREADS_CONTRACT_SHA256SUMS

gh attestation verify threads-linux-x64 \
  --repo danielcorin/threads.space
```

On macOS, use `shasum -a 256 --check` for checksum files.
