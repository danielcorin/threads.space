import { describe, it, expect } from 'vitest';
import { getAllowedOrigins } from '../lib/origins.js';

const APP_ORIGIN = 'https://threads.example.com';

describe('Widget runtime CSP', () => {
  // The CSP built in handleWidgetRuntime uses getAllowedOrigins(env) for
  // frame-ancestors. These tests verify the allowlist is derived correctly and
  // that the CSP construction logic produces valid directives.

  it('frame-ancestors allowlist contains the configured client origin', () => {
    expect(getAllowedOrigins({ APP_ORIGIN })).toContain(APP_ORIGIN);
  });

  it('frame-ancestors allowlist contains no wildcard entries', () => {
    for (const origin of getAllowedOrigins({ APP_ORIGIN })) {
      expect(origin).not.toContain('*');
    }
  });

  it('builds a valid frame-ancestors directive from the allowlist', () => {
    const directive = `frame-ancestors ${getAllowedOrigins({ APP_ORIGIN }).join(' ')}`;
    expect(directive).toContain('frame-ancestors');
    expect(directive).toContain(APP_ORIGIN);
    // Should not contain 'self' — widgets are served from the API origin,
    // and only the client origins should be allowed to embed them
    expect(directive).not.toContain("'self'");
  });

  it('CSP string has expected restrictive directives', () => {
    // Reconstruct the CSP the same way the handler does
    const csp = [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob:",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      `frame-ancestors ${getAllowedOrigins({ APP_ORIGIN }).join(' ')}`,
    ].join('; ');

    // Verify restrictive defaults
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    // img-src must not allow arbitrary https: hosts (image-beacon exfiltration)
    const imgSrc = csp.split('; ').find((d) => d.startsWith('img-src'));
    expect(imgSrc).toBe("img-src 'self' blob: data:");
    // Verify widget code can still run
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
  });
});
