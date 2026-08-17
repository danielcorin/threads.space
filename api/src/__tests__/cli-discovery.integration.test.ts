import { describe, expect, it } from 'vitest';
import { BASE_URL } from './helpers.js';

describe('public CLI discovery', () => {
  it('links the running instance contract to auditable public CLI source', async () => {
    const response = await fetch(`${BASE_URL}/cli.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({
      schemaVersion: 2,
      contract: {
        version: '0.0.1',
        openapi: `${BASE_URL}/openapi.json`,
        websocketEvents: `${BASE_URL}/ws-events.json`,
        documentation: `${BASE_URL}/docs`,
        agentGuide: `${BASE_URL}/agents.txt`,
      },
      tools: {
        version: 'v0.2.2',
        source: 'https://github.com/danielcorin/threads.space/tree/v0.2.2/agent-tools',
        release: 'https://github.com/danielcorin/threads.space/releases/tag/v0.2.2',
        manifest: 'https://github.com/danielcorin/threads.space/releases/download/v0.2.2/threads-agent-tools-manifest.json',
        cli: {
          checksums: 'https://github.com/danielcorin/threads.space/releases/download/v0.2.2/THREADS_CLI_SHA256SUMS',
        },
        bridge: {
          checksums: 'https://github.com/danielcorin/threads.space/releases/download/v0.2.2/THREADS_AGENT_BRIDGE_SHA256SUMS',
        },
        contracts: {
          checksums: 'https://github.com/danielcorin/threads.space/releases/download/v0.2.2/THREADS_CONTRACT_SHA256SUMS',
        },
      },
    });
  });
});
