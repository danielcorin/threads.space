// Per-instance origin configuration.
//
// A standalone instance serves its client and API from one or more public
// origins, configured via the APP_ORIGIN env var (comma-separated to allow
// several front-end hosts). These origins are used for CORS and for widget
// iframe embedding (frame-ancestors + postMessage parentOrigin validation).
//
// Localhost origins are always allowed so local dev works without extra config.

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8788',
];

/**
 * Returns the origins allowed for CORS and widget embedding for this instance:
 * the configured APP_ORIGIN value(s) plus localhost dev origins. Trailing
 * slashes are stripped so values compare cleanly against a request's Origin.
 */
export function getAllowedOrigins(env: { APP_ORIGIN?: string }, requestOrigin?: string): string[] {
  const configured = (env.APP_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const current = requestOrigin?.trim().replace(/\/+$/, '');
  return [...new Set([...configured, ...(current ? [current] : []), ...DEV_ORIGINS])];
}
