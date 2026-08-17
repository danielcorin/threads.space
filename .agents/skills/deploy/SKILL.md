---
name: deploy
description: Deploy the standalone Threads app to Cloudflare production. Use when the user explicitly asks to deploy, ship, release, or push Threads to Cloudflare.
---

# Deploy Threads to Cloudflare

Threads ships as one Worker per repository deployment. The root `wrangler.jsonc`
is the only production configuration: it combines the Svelte client, HTTP API,
WebSockets, MCP endpoint, D1 database, R2 bucket, Workers AI, Analytics Engine,
and Durable Objects.

Only deploy when the user explicitly requests a production release.

## Prerequisites

1. Confirm `git status --short` is clean and the desired revision is checked out.
2. Confirm Wrangler is authenticated with `npx wrangler whoami`.
3. Confirm the stable `INSTANCE_SECRET` is configured. For a first deployment,
   generate it with `openssl rand -base64 32` and store it in Cloudflare and a
   password manager. Do not rotate it after the instance is in use.
4. Never use `api/wrangler.toml` for production; it is only the local API harness.

## Deploy

The normal release command builds the combined Worker, publishes it, and applies
pending D1 migrations:

```bash
npm run deploy
```

For a release with the complete local validation suite first:

```bash
npm run deploy:local
```

Run the same checks without publishing with `npm run check:local`.

## Verify

Use the URL printed by Wrangler:

```bash
BASE_URL=https://your-instance.example
curl -fsS "$BASE_URL/health"
curl -fsS "$BASE_URL/api/openapi.json" >/dev/null
curl -fsS "$BASE_URL/" >/dev/null
```

Then sign in and spot-check the behavior changed by the release.

## Roll back code

```bash
npx wrangler deployments list
npx wrangler rollback
```

A Worker rollback does not reverse D1 migrations. Migrations must remain safe
for the previous Worker version or be corrected with a forward migration.
