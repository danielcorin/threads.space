import spec from '../openapi-spec.json';
import wsEventsSpec from '../ws-events-spec.json';
import agentsTxt from '../agents-txt.json';
import agentToolsRelease from '../../../agent-tools/release.json';
import type { ThreadsApp } from './types.js';

// Bundled at build time from openapi/*.yaml (Workers can't read the filesystem at
// runtime; regenerate with `npm run openapi:bundle`). Drift tests in
// src/__tests__/openapi-inventory.test.ts keep the bundled JSON in sync with the YAML.
//
// Two documents are published:
//   GET /openapi.json    — the REST contract (threads.yaml)
//   GET /ws-events.json  — the WebSocket event payload schemas (ws-events.yaml)
//   GET /cli.json        — compatible public agent tools and release provenance
// so an external bot author can generate clients for *both* surfaces from a live
// instance, without access to this repo.

// Scalar API reference shell. Both documents are loaded as switchable sources via
// relative URLs, so this works whether mounted at /api/docs (combined worker) or
// /docs (standalone api dev) — both resolve to the matching JSON on the same origin.
//
// "Try it out" requests target this instance's same-origin /api base (the REST spec's
// `servers` is rewritten below), so the browser attaches the session cookie
// automatically — no proxy is configured (a proxy would make the requests
// cross-origin and drop the cookie). The Authorize panel still covers bearer API
// tokens for non-browser clients.
const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Threads API — Reference</title>
    <style>
      body { margin: 0; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        // Switchable documents: the REST API and the WebSocket event schemas.
        sources: [
          { url: 'openapi.json', title: 'REST API', slug: 'rest' },
          { url: 'ws-events.json', title: 'WebSocket events', slug: 'ws-events' },
        ],
        // No proxyUrl: keep "Try it out" requests same-origin so the session
        // cookie is sent. Bearer tokens can be set via the Authorize panel.
      });
    </script>
  </body>
</html>`;

// Shared headers: public + permissive CORS so external tools (editor.swagger.io,
// code generators) can fetch the documents cross-origin.
const SPEC_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=300',
} as const;

// The public release manifest has its own internal schema version. Keep that
// implementation detail out of the instance discovery contract so consumers
// have one version to negotiate: the top-level /cli.json schemaVersion.
const AGENT_TOOLS_DISCOVERY = {
  version: agentToolsRelease.version,
  source: agentToolsRelease.source,
  release: agentToolsRelease.release,
  manifest: agentToolsRelease.manifest,
  cli: agentToolsRelease.cli,
  bridge: agentToolsRelease.bridge,
  contracts: agentToolsRelease.contracts,
} as const;

export function registerOpenApiRoutes(app: ThreadsApp): void {
  // Raw REST OpenAPI document. `servers` is rewritten to the live origin so "Try it
  // out" targets this instance's API base (/api on the combined worker).
  app.get('/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin;
    const doc = {
      ...spec,
      servers: [{ url: `${origin}/api`, description: 'This instance' }],
    };
    return new Response(JSON.stringify(doc), { headers: SPEC_HEADERS });
  });

  // WebSocket event payload schemas. Served as-is (it carries no `servers` — it
  // documents the JSON exchanged over GET /ws/:channelId and GET /ws/presence, whose
  // upgrade endpoints live in the REST document).
  app.get('/ws-events.json', () =>
    new Response(JSON.stringify(wsEventsSpec), { headers: SPEC_HEADERS }),
  );

  app.get('/cli.json', (c) => {
    const documentUrl = new URL(c.req.url);
    return new Response(JSON.stringify({
      schemaVersion: 2,
      contract: {
        version: spec.info.version,
        openapi: new URL('openapi.json', documentUrl).href,
        websocketEvents: new URL('ws-events.json', documentUrl).href,
        documentation: new URL('docs', documentUrl).href,
        agentGuide: new URL('agents.txt', documentUrl).href,
      },
      tools: AGENT_TOOLS_DISCOVERY,
    }), { headers: SPEC_HEADERS });
  });

  app.get('/docs', () =>
    new Response(DOCS_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
  );

  // Self-contained guide for an agent to connect another agent or itself,
  // served at the conventional web root. Points to the documents above for the
  // full contract. Bundled from the repo root agents.txt via
  // `npm run openapi:bundle`.
  app.get('/agents.txt', () =>
    new Response(agentsTxt, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    }),
  );
}
