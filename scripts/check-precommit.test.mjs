import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = path.join(rootDir, 'scripts', 'check-precommit.mjs');

function runPrecommit(changedFiles, extraEnv = {}) {
  const childEnv = { ...process.env };
  delete childEnv.SMOKE_BASE_URL;
  delete childEnv.SMOKE_PASSWORD;
  return spawnSync(process.execPath, [scriptPath, '--dry-run'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...childEnv,
      ...extraEnv,
      THREADS_PRECOMMIT_CHANGED_FILES: changedFiles.join('\n'),
    },
  });
}

test('rejects an HTTP boundary change without the HTTP source contract', () => {
  const result = runPrecommit(['api/src/routes/auth.ts']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Contract-first guard failed/);
  assert.match(result.stderr, /api\/openapi\/threads\.yaml/);
  assert.match(result.stderr, /api\/src\/routes\/auth\.ts/);
});

test('accepts an HTTP boundary change with the HTTP source contract', () => {
  const result = runPrecommit([
    'api/src/routes/auth.ts',
    'api/openapi/threads.yaml',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Check API OpenAPI output/);
});

test('rejects a WebSocket boundary change without the event source contract', () => {
  const result = runPrecommit(['api/src/chat-room-actions.ts']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /api\/openapi\/ws-events\.yaml/);
  assert.match(result.stderr, /api\/src\/chat-room-actions\.ts/);
});

test('accepts a WebSocket boundary change with the event source contract', () => {
  const result = runPrecommit([
    'api/src/chat-room-actions.ts',
    'api/openapi/ws-events.yaml',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Check API OpenAPI output/);
});

test('requires both contracts for a boundary that serves HTTP and emits events', () => {
  const result = runPrecommit([
    'api/src/routes/messages.ts',
    'api/openapi/threads.yaml',
  ]);

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /HTTP API boundary changes require/);
  assert.match(result.stderr, /WebSocket events boundary changes require/);
});

test('allows internal API implementation changes without a contract edit', () => {
  const result = runPrecommit(['api/src/read-models/messages.ts']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Contract-first guard failed/);
});

test('changes to the pre-commit guard select its own test suite', () => {
  const result = runPrecommit(['scripts/check-precommit.mjs']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Test pre-commit selection and contract guard/);
  assert.match(result.stdout, /npm run check:precommit:test/);
});

test('an agent-tools change runs contract and integration checks', () => {
  const result = runPrecommit(['agent-tools/cli/src/index.ts']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Check first-party agent tools and contracts/);
  assert.match(result.stdout, /caller\.integration\.test\.ts/);
  assert.match(result.stdout, /mcp\.integration\.test\.ts/);
});

test('a smoke-test change skips deployment smoke tests without an explicit target', () => {
  const result = runPrecommit(['api/src/__tests__/smoke/post-deploy.smoke.test.ts']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /smoke tests require SMOKE_BASE_URL and SMOKE_PASSWORD/);
  assert.doesNotMatch(result.stdout, /Run API smoke tests/);
});

test('a smoke-test change runs deployment smoke tests when a target is configured', () => {
  const result = runPrecommit(
    ['api/src/__tests__/smoke/post-deploy.smoke.test.ts'],
    { SMOKE_BASE_URL: 'https://smoke.example.com', SMOKE_PASSWORD: 'test-password' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Run API smoke tests/);
});
