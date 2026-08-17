import { Hono, type Context } from 'hono';
import { authenticateRoutes, registerAuthenticatedRoutes, registerPublicRoutes, type HonoEnv } from './routes/register.js';
import { registerOpenApiRoutes } from './routes/openapi.js';
import { handleScheduledDelivery } from './routes/saved-drafts.js';
import { drainWebhookDeliveries } from './lib/webhooks.js';
import { getAllowedOrigins } from './lib/origins.js';
import { handleMcpRequest, MCP_PATH } from './mcp.js';
import type { Env } from './types.js';
import { errorResponse } from './utils.js';

export { ChatRoom } from './chat-room.js';
export { PresenceRoom } from './presence-room.js';
export { UserEventsRoom } from './user-events-room.js';

const app = new Hono<HonoEnv>();

// --- CORS ---
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Mcp-Method, Mcp-Name',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    'Access-Control-Allow-Credentials': 'true',
    // Uploads are long-cacheable and can be fetched both as same-site navigations
    // and cross-origin previews. Keep browser/proxy caches from reusing a
    // no-Origin response for a later CORS fetch.
    Vary: 'Origin',
  };
  const origin = request.headers.get('Origin');
  if (origin && getAllowedOrigins(env, new URL(request.url).origin).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function addCorsHeaders(response: Response, cors: Record<string, string>): Response {
  // WebSocket upgrades (101) and other non-standard statuses can't be reconstructed
  if (response.status < 200 || response.status > 599) return response;
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers: newHeaders });
}

/**
 * Record an unhandled failure to the console and the error_logs table (read
 * back by GET /errors). Best-effort: a logging failure must never replace the
 * error it was trying to report.
 */
function logServerError(c: Context<HonoEnv>, e: unknown): void {
  const errMsg = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack ?? '' : '';
  console.error(`[500] ${c.req.method} ${c.req.path} — ${errMsg}\n${stack}`);
  c.executionCtx.waitUntil(
    c.env.DB.prepare('INSERT INTO error_logs (method, path, error_message, stack) VALUES (?, ?, ?, ?)')
      .bind(c.req.method, c.req.path, errMsg, stack)
      .run()
      .catch(() => {})
  );
}

// Thrown Errors never reach the middleware below. Hono's compose() catches any
// `err instanceof Error` at the throwing handler's own dispatch level and hands
// it to this app-level handler, re-throwing everything else (see
// node_modules/hono/dist/compose.js). So a real exception — the SyntaxError from
// request.json() on a malformed body, a TypeError, a D1 failure — only lands
// here, while the codebase's `throw errorResponse(...)` pattern (a Response, not
// an Error) is re-thrown and caught by the middleware.
//
// Registering this was a fix, not a refactor: without it, Hono's DEFAULT handler
// served a bare text/plain "Internal Server Error" and nothing was ever written
// to error_logs. Dozens of routes were faulting on malformed input with the
// table sitting empty, which made GET /errors read like an all-clear.
app.onError((err, c) => {
  logServerError(c, err);
  // D1 raises D1_TYPE_ERROR when a bound parameter is not a primitive it can
  // store. readJsonObject guarantees the BODY is an object; it cannot guarantee
  // the type of each field, so `{"name": ["a","b"]}` still reached .bind() and
  // faulted. That is a bad request, not a server fault: answering 500 told the
  // caller to retry something that can never succeed. Still logged above with a
  // full stack, so a genuine server-side binding bug remains visible in
  // GET /errors rather than being hidden by the friendlier status.
  if (err instanceof Error && /D1_TYPE_ERROR/.test(err.message)) {
    return addCorsHeaders(
      errorResponse('Request contained a field of an unsupported type', 400),
      corsHeaders(c.req.raw, c.env),
    );
  }
  return addCorsHeaders(errorResponse('Internal server error', 500), corsHeaders(c.req.raw, c.env));
});

// Global CORS + error handling middleware
app.use('*', async (c, next) => {
  const cors = corsHeaders(c.req.raw, c.env);

  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    await next();
    // Covers both the handler's own response and one produced by app.onError
    // above, since compose() resolves next() normally after handling an error.
    c.res = addCorsHeaders(c.res, cors);
  } catch (e) {
    // Authorization helpers signal failure by throwing a Response; compose()
    // re-throws non-Error values, so those arrive here rather than in onError.
    if (e instanceof Response) {
      return addCorsHeaders(e, cors);
    }
    logServerError(c, e);
    return addCorsHeaders(errorResponse('Internal server error', 500), cors);
  }
});

// Public, unauthenticated API reference (GET /openapi.json, GET /docs). Mounted
// at the app level rather than in the versioned route set since it documents the
// API rather than being part of it.
registerOpenApiRoutes(app);

// Instance metadata: which revision is deployed and which migration the
// database has reached. App-level like /docs — it describes the deployment,
// not the API.
app.get('/health', async (c) => {
  // wrangler's bookkeeping table; absent when migrations were applied another
  // way (e.g. the test harness replays the .sql files directly).
  const latestMigration = await c.env.DB
    .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
    .first<{ name: string }>()
    .then((row) => row?.name ?? null)
    .catch(() => null);
  // `environment` lets tooling distinguish production from smoke instances.
  // The smoke suite refuses to run unless this is non-production. Mirrors the Wrangler
  // [vars] ENVIRONMENT; 'dev' when unset (local server).
  return c.json({ status: 'ok', commit: c.env.GIT_SHA ?? 'dev', environment: c.env.ENVIRONMENT ?? 'dev', latestMigration });
});

// Stateless Streamable HTTP MCP endpoint. Authentication and Origin validation
// live in the adapter because MCP accepts bearer API tokens but intentionally
// rejects browser session cookies.
app.all(MCP_PATH, (c) => handleMcpRequest(
  c.req.raw,
  c.env,
  async (request) => app.fetch(request, c.env, c.executionCtx),
));

registerPublicRoutes(app);

const authed = new Hono<HonoEnv>();
authed.use('*', authenticateRoutes);
registerAuthenticatedRoutes(authed);
app.route('/', authed);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduledDelivery(env, ctx);
    await drainWebhookDeliveries(env, ctx);
    // Sessions are 30-day rows that were never pruned — sweep expired ones.
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < unixepoch()').run()
      .catch((err) => console.error('Session prune failed:', err));
    await env.DB.prepare('DELETE FROM user_email_verifications WHERE expires_at < unixepoch()').run()
      .catch((err) => console.error('Email verification prune failed:', err));
    await env.DB.prepare('DELETE FROM mfa_challenges WHERE expires_at < unixepoch()').run()
      .catch((err) => console.error('MFA challenge prune failed:', err));
    await env.DB.prepare('DELETE FROM mfa_enrollments WHERE expires_at < unixepoch()').run()
      .catch((err) => console.error('MFA enrollment prune failed:', err));
  },
} satisfies ExportedHandler<Env>;
