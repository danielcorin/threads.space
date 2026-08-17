# Deploying one Threads instance

The repository deploys one combined client + API Cloudflare Worker. It owns one
D1 database, one R2 bucket, and three Durable Object classes. Every deployment
is an independent Threads instance.

## One-click deployment

Use the **Deploy to Cloudflare** button in the root README. Cloudflare reads
`wrangler.jsonc`, provisions the declared resources, prompts for secrets, runs
the root deploy command, applies the fresh D1 baseline, and returns the Worker
URL.

The only required value is `INSTANCE_SECRET`. Generate a high-entropy value:

```sh
openssl rand -base64 32
```

Keep it in the Cloudflare secret store and your password manager. A fresh
instance is claimed by signing in as `admin` with this value. Change that
password immediately after login. The bootstrap login is disabled forever once
the database contains a human user.

## Command-line deployment

Authenticate Wrangler, then run from the repository root:

```sh
npm install
npx wrangler secret put INSTANCE_SECRET
npm run deploy
```

The root config is the production source of truth. `api/wrangler.toml` is only
an API-only local/test harness and must not be used for production deployment.

## Optional integrations

Set only the features you use:

```sh
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

Plain variables such as `AUTH_EMAIL_FROM`, `VAPID_SUBJECT`, and `APP_ORIGIN` can
be added to `wrangler.jsonc`. `APP_ORIGIN` is normally unnecessary because the
Worker accepts its request origin; set it when a fixed custom-domain origin is
desired.

- Without Resend, email verification and invitations report that email is not
  configured. Feedback email is sent only when both `RESEND_API_KEY` and an
  instance-owned `FEEDBACK_EMAIL_TO` are configured.
- Without VAPID keys, Web Push is disabled.
- Without a separate `MFA_ENCRYPTION_KEY`, a stable key is derived from
  `INSTANCE_SECRET`.

Do not rotate `INSTANCE_SECRET` after users, API tokens, webhooks, or MFA
credentials exist. Rotation invalidates derived credential verifiers and makes
existing encrypted MFA secrets unreadable. If separation is required from day
one, configure `CREDENTIAL_MASTER_KEY` and `MFA_ENCRYPTION_KEY` before use.

## Updating

Pull the desired revision and rerun:

```sh
npm install
npm run deploy
```

The deploy publishes first so Wrangler can provision resources on a brand-new
account, then applies migrations. The migration command is idempotent; Wrangler
records applied D1 migrations.

## Verification

```sh
curl -fsS https://<instance>/health
curl -fsS https://<instance>/api/openapi.json >/dev/null
```

Then sign in, create a channel, add a second user or bot from Admin settings,
and send a message. For a non-production smoke instance, the API smoke suite can
also be pointed at it with `SMOKE_BASE_URL`, `SMOKE_USERNAME`, and
`SMOKE_PASSWORD`.
