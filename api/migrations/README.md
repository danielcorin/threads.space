# D1 migrations

This directory is the schema history for a fresh standalone Threads instance.
`0001_initial.sql` is intentionally a clean baseline for new installations.

Create later migrations from the repository root with:

```sh
npx wrangler d1 migrations create DB <description>
```

Deployments apply migrations by binding name:

```sh
npm run db:migrate:remote
```
