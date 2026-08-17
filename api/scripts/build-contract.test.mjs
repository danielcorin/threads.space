import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildContract } from './build-contract.mjs';

test('buildContract creates a clean, deterministic contract bundle', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'threads-contract-'));
  const outputDir = path.join(rootDir, 'dist', 'api-contract');
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(rootDir, { recursive: true, force: true });
  });

  await mkdir(path.join(rootDir, 'api', 'openapi'), { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(rootDir, 'api', 'openapi', 'threads.yaml'), '{"openapi":"3.1.0"}\n');
  await writeFile(path.join(rootDir, 'api', 'openapi', 'ws-events.yaml'), 'openapi: 3.1.0\n');
  await writeFile(path.join(outputDir, 'stale.txt'), 'remove me');

  const metadata = {
    version: 'v1.2.3',
    gitSha: '0123456789abcdef',
    generatedAt: '2026-07-18T12:00:00.000Z',
  };
  await buildContract({ rootDir, outputDir, metadata });

  const manifestPath = path.join(outputDir, 'manifest.json');
  const firstManifest = await readFile(manifestPath, 'utf8');
  assert.deepEqual(JSON.parse(firstManifest), {
    name: 'threads-api-contract',
    version: 'v1.2.3',
    gitSha: '0123456789abcdef',
    generatedAt: '2026-07-18T12:00:00.000Z',
    files: [
      'openapi/threads.yaml',
      'openapi/ws-events.yaml',
    ],
  });
  assert.equal(
    await readFile(path.join(outputDir, 'openapi', 'threads.yaml'), 'utf8'),
    '{"openapi":"3.1.0"}\n',
  );
  assert.equal(
    await readFile(path.join(outputDir, 'openapi', 'ws-events.yaml'), 'utf8'),
    'openapi: 3.1.0\n',
  );
  await assert.rejects(readFile(path.join(outputDir, 'stale.txt'), 'utf8'), { code: 'ENOENT' });

  const readme = await readFile(path.join(outputDir, 'README.md'), 'utf8');
  assert.match(readme, /Threads API contract/);
  assert.match(readme, /v1\.2\.3/);
  assert.match(readme, /threads-agent-bridge/);

  await buildContract({ rootDir, outputDir, metadata });
  assert.equal(await readFile(manifestPath, 'utf8'), firstManifest);
});
