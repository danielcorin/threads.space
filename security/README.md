# Security fuzz suite

Black-box security testing against a **deployed, non-production** Threads instance.

```bash
export SECURITY_BASE_URL=https://your-test-instance.example
export SECURITY_USERNAME=admin           # must be an instance admin
export SECURITY_PASSWORD=...

npm run security:fuzz                    # all probes
npm run security:fuzz -- --only authz    # one probe
npm run security:fuzz -- --seed 42       # replay an earlier run exactly
npm run security:fuzz -- --list          # route inventory + destructive-route denylist
npm run security:fuzz -- --help
```

Exits non-zero when anything is found, so it can gate a pipeline.

## Why these probes and not a byte fuzzer

Coverage-guided fuzzers (AFL, libFuzzer) find memory-safety bugs. This is
TypeScript on Cloudflare Workers: there is no memory corruption to find, and
random bytes bounce off Hono's router without reaching anything interesting.

What actually threatens this application at scale is **broken authorization** and
**unvalidated input**, so all three probes are structure-aware and oracle-driven
rather than random.

| Probe   | Attacks                                    | Oracle |
| ------- | ------------------------------------------ | ------ |
| `authz` | Cross-account access (IDOR)                | A non-member gets 2xx on a victim-owned resource, or victim-visible state changes |
| `input` | Missing runtime validation                 | Any 5xx. A 400 is a pass — we hunt the gap between "no" and "crash" |
| `ws`    | Durable Object action boundary             | Unauthorized upgrade, cross-channel action, identity smuggling, post-revocation write |

### Why `authz` is the one that matters most

Threads enforces authorization **per handler, by hand** — roughly 38 call sites
of `requireChannelMembership` / `authenticateForChannel` across ~140 routes. That
pattern fails *open*: a new handler that forgets the check is silently readable
by anyone who knows an id. The sweep replays every route in the inventory against
a resource owned by someone else, so a missing check shows up without anyone
having to think of it.

### Why `input` finds so much

Routes parse bodies like this:

```ts
const body = await request.json<{ content: string; threadId?: string }>();
```

`json<T>()` is a **compile-time assertion**. At runtime `content` can be an
array, a number, `null`, or 64KB of text, and it flows toward D1 unchecked. `zod`
is already a dependency in `api/package.json` but appears in zero route files.

## Safety

This suite writes garbage into channels, sends hostile input, and probes for
cross-account access. Several guardrails keep that contained:

1. **Production guard.** Refuses to run unless `/health` reports a
   non-production `environment`. Same mechanism the post-deploy smoke suite uses.
2. **Destructive-route denylist.** Password resets, MFA disables,
   `POST /processes/kill-all`, and anything that would revoke the suite's own
   access are never called. Run `--list` to see them with reasons.
   They are reported as *uncovered* on every run: review them by hand.
3. **Path-parameter fuzzing never uses real ids.** Hostile path values are
   substituted for every parameter, so a fuzzed `DELETE` can only ever act on a
   resource that does not exist.
4. **Pacing.** Concurrency and per-request delay are capped
   (`SECURITY_CONCURRENCY`, `SECURITY_DELAY_MS`) so a fuzz run doesn't become an
   accidental load test. Payloads are capped at 64KB.
5. **Tagged fixtures + teardown.** Everything created carries a run label
   (`sec-<timestamp>-<rand>`); teardown removes it and reports whatever it
   couldn't.

## Reading the report

- **findings** — the oracle fired. Each carries a `curl` repro with credentials
  redacted. Identical defects found through many mutations collapse into one
  finding with an occurrence count.
- **uncovered** — what was *not* tested, and why. Read this. A clean findings
  list next to twelve uncovered routes is not a clean bill of health.
- **notes** — not defects, but context. Includes the root-cause grouping for
  5xx (dozens of crashing routes are usually a handful of causes) and every
  place a non-member 2xx was suppressed as designed behaviour, with the source
  citation that justifies it (see `SHARED_BY_DESIGN` in `probes/authz.mjs`).

Every run prints its seed. `--seed <n>` replays it exactly.

## Running it locally first

The suite auto-detects whether the API is mounted at `/api/*` (deployed combined
worker) or at the root (`wrangler dev`), so you can rehearse against a local
server before pointing it at a deployed test instance:

```bash
cd api && npm run setup:local && npm run dev    # port 8788
# the seeded admin needs is_admin for the suite to create fixtures:
npx wrangler d1 execute threads --local --command "UPDATE users SET is_admin = 1 WHERE username = 'dan'"

SECURITY_BASE_URL=http://localhost:8788 SECURITY_USERNAME=dan \
  SECURITY_PASSWORD=dan-password-123 npm run security:fuzz
```

Local runs leave fuzz users and channels in the local D1. That database is
throwaway (the test suite wipes it), so reseed with `npm --prefix api run
db:seed:local` when it gets noisy.

## Layout

```
security/
  fuzz.mjs              CLI entry point
  lib/
    target.mjs          config, production guard, HTTP layer, pacing
    routes.mjs          route enumeration + destructive-route denylist
    fixtures.mjs        principals (victim / attacker / bot) and victim-owned resources
    bodies.mjs          minimal valid request bodies, per route
    report.mjs          finding collection, dedupe, output
    rng.mjs             seeded PRNG so findings replay
  probes/
    authz.mjs  input.mjs  ws.mjs
```

Routes come from `CORE_ROUTE_INVENTORY` / `EXTENSION_ROUTE_INVENTORY` in
`api/src/routes/`, which `route-boundary-inventory.test.ts` already asserts
against the real Hono registrations. A route added to the API is fuzzed
automatically — coverage doesn't depend on anyone updating this directory.
