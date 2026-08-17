# Contributing

Use Node.js 22 or newer and install the locked dependency tree from the root:

```bash
npm ci
```

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
