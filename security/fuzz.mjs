#!/usr/bin/env node
// Threads security fuzz suite — black-box, against a deployed non-production instance.
//
//   npm run security:fuzz -- --help
//
// Three probes, each with an explicit oracle (see the header of each file):
//   authz  security/probes/authz.mjs  — cross-account access, the IDOR hunt
//   input  security/probes/input.mjs  — malformed input, "any 5xx is a bug"
//   ws     security/probes/ws.mjs     — Durable Object action boundary
//
// Exits non-zero when anything is found, so it can gate a pipeline.

import { assertNonProduction, login, detectApiPrefix, currentApiPrefix, BASE_URL, USERNAME, PASSWORD } from './lib/target.mjs';
import { loadRoutes } from './lib/routes.mjs';
import { setup, teardown, runLabel } from './lib/fixtures.mjs';
import { createReport, printReport, writeReport } from './lib/report.mjs';
import { makeRng, randomSeed } from './lib/rng.mjs';

import * as authzProbe from './probes/authz.mjs';
import * as inputProbe from './probes/input.mjs';
import * as wsProbe from './probes/ws.mjs';

const PROBES = { authz: authzProbe, input: inputProbe, ws: wsProbe };

function parseArgs(argv) {
  const args = { seed: null, iterations: 12, only: Object.keys(PROBES), report: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--iterations') args.iterations = Number(argv[++i]);
    else if (arg === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--report') args.report = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
  }
  const unknown = args.only.filter((p) => !PROBES[p]);
  if (unknown.length) throw new Error(`Unknown probe(s): ${unknown.join(', ')}. Available: ${Object.keys(PROBES).join(', ')}`);
  return args;
}

function usage() {
  console.log(`
Threads security fuzz suite

  npm run security:fuzz -- [options]

Options
  --only <probes>     Comma-separated: authz, input, ws  (default: all)
  --seed <n>          Replay a previous run exactly. Printed at the top of every run.
  --iterations <n>    Mutations per route for the input probe (default 12)
  --report <path>     Write the full JSON report here
  --list              Print the route inventory and the destructive-route denylist, then exit
  --help              This message

Environment (falls back to the SMOKE_* vars the post-deploy suite already uses)
  SECURITY_BASE_URL   required — instance origin, e.g. https://your-test-instance.example
  SECURITY_USERNAME   admin login (default "admin")
  SECURITY_PASSWORD   required
  SECURITY_CONCURRENCY, SECURITY_DELAY_MS, SECURITY_REQUEST_TIMEOUT_MS   pacing

Safety
  Refuses to run unless /health reports a non-production environment. This suite
  writes garbage into channels and probes for cross-account access; it must never
  point at real user data. Routes that destroy data or revoke the suite's own
  access are denylisted — run --list to see them.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const { all, testable, excluded } = loadRoutes();

  if (args.list) {
    console.log(`\n${all.length} routes in the inventory; ${testable.length} will be exercised.\n`);
    console.log(`Denylisted (${excluded.length}) — never called, reported as uncovered every run:\n`);
    for (const r of excluded) console.log(`  ${r.key}\n    ${r.reason}\n`);
    return;
  }

  const seed = Number.isFinite(args.seed) && args.seed !== null ? args.seed : randomSeed();
  const rng = makeRng(seed);

  console.log(`\n  Target      ${BASE_URL || '(unset)'}`);
  console.log(`  Account     ${USERNAME}${PASSWORD ? '' : ' (SECURITY_PASSWORD unset!)'}`);
  console.log(`  Seed        ${seed}`);
  console.log(`  Probes      ${args.only.join(', ')}\n`);

  // Guard first, before anything is created or sent.
  const health = await assertNonProduction();
  console.log(`  /health     environment=${health.environment} commit=${health.commit} migration=${health.latestMigration}\n`);

  const run = runLabel();
  console.log(`  Run label   ${run}  (all fixtures are tagged with this)\n`);

  const victimToken = await login(USERNAME, PASSWORD);
  await detectApiPrefix(victimToken);
  console.log(`  API mount   ${BASE_URL}${currentApiPrefix() || '/'} (auto-detected)\n`);

  console.log('  Building fixtures (private channel, message, board, widget, attacker account)...');
  const base = await setup(run, victimToken);

  const ctx = { ...base, routes: testable, iterations: args.iterations };

  const report = createReport({
    baseUrl: BASE_URL,
    environment: health.environment,
    commit: health.commit,
    seed,
    probes: args.only,
    routesTested: testable.length,
    routesTotal: all.length,
  });

  for (const item of ctx.unavailable) {
    report.skip(item.label, `fixture could not be created — ${item.reason}`);
  }
  for (const r of excluded) {
    report.skip(r, `DENYLISTED — ${r.reason}`);
  }

  for (const name of args.only) {
    console.log(`  Running probe: ${name}...`);
    try {
      await PROBES[name].run(ctx, report, rng);
    } catch (err) {
      // One probe blowing up must not discard the findings of the others.
      console.error(`  ! probe "${name}" aborted: ${err instanceof Error ? err.message : String(err)}`);
      report.skip(name, `probe aborted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n  Tearing down fixtures...');
  const { leftovers, serverErrors } = await teardown(ctx);
  if (leftovers.length) {
    report.note(`Cleanup left these behind (tagged "${run}") — remove by hand: ${leftovers.join('; ')}`);
  }
  for (const e of serverErrors) {
    report.add({
      severity: 'medium',
      probe: 'teardown',
      title: 'Admin delete path returns a server error',
      detail:
        `${e.method} ${e.path} (deleting the ${e.label} fixture) returned ${e.response.status}. This route is ` +
        `denylisted from the sweep as too destructive to call blindly, so teardown is the only place it runs — ` +
        `which makes this the one signal you get that it faults on real data.`,
      route: `${e.method} ${e.path}`,
      response: e.response,
    });
  }

  printReport(report);
  if (args.report) writeReport(report, args.report);

  if (report.findings.length) {
    console.log(`  ${report.findings.length} finding(s) — exiting 1.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});
