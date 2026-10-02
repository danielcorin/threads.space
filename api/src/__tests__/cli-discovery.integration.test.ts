import { describe, expect, it } from 'vitest';
import { BASE_URL } from './helpers.js';

describe('public CLI discovery', () => {
  it('links the running instance contract to source without advertising unpublished artifacts', async () => {
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
        source: 'https://github.com/danielcorin/threads.space/tree/main/agent-tools',
        release: null,
        manifest: null,
        cli: {
          checksums: null,
        },
        bridge: {
          checksums: null,
        },
        contracts: {
          checksums: null,
        },
      },
    });
  });
});
