import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveArtifactMetadata } from './artifact-metadata.mjs';

test('tag builds share one explicit artifact identity', () => {
  assert.deepEqual(resolveArtifactMetadata({
    rootDir: process.cwd(),
    env: {
      GITHUB_SHA: '0123456789abcdef',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v1.2.3',
      SOURCE_DATE_EPOCH: '1784376000',
    },
  }), {
    version: 'v1.2.3',
    gitSha: '0123456789abcdef',
    generatedAt: '2026-07-18T12:00:00.000Z',
  });
});

test('explicit artifact metadata overrides CI defaults', () => {
  assert.deepEqual(resolveArtifactMetadata({
    rootDir: process.cwd(),
    env: {
      GITHUB_SHA: 'ignored',
      THREADS_ARTIFACT_GIT_SHA: 'fedcba9876543210',
      THREADS_ARTIFACT_VERSION: 'bridge-preview',
      THREADS_ARTIFACT_GENERATED_AT: '2026-07-18T13:00:00.000Z',
    },
  }), {
    version: 'bridge-preview',
    gitSha: 'fedcba9876543210',
    generatedAt: '2026-07-18T13:00:00.000Z',
  });
});

test('invalid reproducible-build timestamps fail with an actionable error', () => {
  assert.throws(() => resolveArtifactMetadata({
    rootDir: process.cwd(),
    env: {
      GITHUB_SHA: '0123456789abcdef',
      SOURCE_DATE_EPOCH: 'sometime',
    },
  }), /SOURCE_DATE_EPOCH must be a number/);
});
