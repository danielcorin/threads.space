# Contributing

Threads is deprecated and no longer actively maintained. Issue responses,
pull request reviews, releases, and security updates are not guaranteed. You
can fork the MIT-licensed source and maintain your own deployment.

For local development, use Node.js 22 or 24 LTS, Go 1.24 or newer, and Python 3
with `venv` support. Install the locked dependency tree from the root:

```bash
npm ci
```

Use an LTS Node.js runtime for validation. The email-verification integration
tests encounter local HTTP connection resets on Node.js 25.

Before opening a pull request, run:

```bash
npm run check:threads
npm run build
```

HTTP and WebSocket contract changes begin in `api/openapi/`. Run
`npm --prefix api run openapi:bundle` and
`npm --prefix api run openapi:clients` after changing those sources; do not
edit generated contract files by hand.

Never commit `.env`, `.dev.vars`, Wrangler local state, API tokens, or exported
instance data.

The root dependency overrides keep SvelteKit's `cookie` and the Cloudflare test
harness's `sharp` and `undici` on patched versions without upgrading SvelteKit
to a new major version. Keep these overrides until the upstream dependencies
require patched versions themselves. Audit both lockfiles with `npm audit` at
the root and `npm --prefix agent-tools audit` after dependency changes.
