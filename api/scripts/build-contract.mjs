#!/usr/bin/env node

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveArtifactMetadata } from '../../scripts/artifact-metadata.mjs';

const CONTRACT_FILES = [
  'openapi/threads.yaml',
  'openapi/ws-events.yaml',
];

function contractReadme(metadata) {
  return `# Threads API contract

Version: \`${metadata.version}\`
Git revision: \`${metadata.gitSha}\`

This bundle is the versioned source contract for the Threads app and external
integrations such as \`threads-agent-bridge\`.

## Contents

- \`openapi/threads.yaml\` — the complete HTTP API contract.
- \`openapi/ws-events.yaml\` — WebSocket client and server event schemas.
- \`manifest.json\` — the pinned source revision and bundle inventory.

Generate clients from the bundled files rather than a private repository checkout.
For example, a Go consumer can run \`oapi-codegen\` against
\`openapi/threads.yaml\` and pin \`manifest.json.version\` in its repository.

The compatible open-source \`threads\` CLI and local agent bridge are published
from the same \`danielcorin/threads.space\` source tag as this contract.
A running instance exposes its pinned source, release, checksums, and contract
links at \`GET /api/cli.json\`.
`;
}

export async function buildContract({
  rootDir,
  outputDir = path.join(rootDir, 'dist', 'api-contract'),
  metadata = resolveArtifactMetadata({ rootDir }),
}) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.join(outputDir, 'openapi'), { recursive: true });

  for (const relativePath of CONTRACT_FILES) {
    await copyFile(
      path.join(rootDir, 'api', relativePath),
      path.join(outputDir, relativePath),
    );
  }

  const manifest = {
    name: 'threads-api-contract',
    version: metadata.version,
    gitSha: metadata.gitSha,
    generatedAt: metadata.generatedAt,
    files: CONTRACT_FILES,
  };
  await writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(path.join(outputDir, 'README.md'), contractReadme(metadata));
  return { outputDir, manifest };
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (scriptPath === import.meta.url) {
  const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const { outputDir, manifest } = await buildContract({ rootDir });
  console.log(`Built ${manifest.name}@${manifest.version} in ${path.relative(rootDir, outputDir)}`);
}
