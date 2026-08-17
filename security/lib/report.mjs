// Finding collection and reporting.
//
// A fuzzer's output is only useful if every line is either actionable or
// explicitly marked as a coverage gap. Three buckets:
//
//   findings    a probe's oracle fired. Each carries a curl repro.
//   uncovered   a route we could NOT meaningfully test, and why. Reported as
//               loudly as findings — silent skips make a report read like full
//               coverage when it isn't.
//   notes       observations that are not defects but inform the security
//               posture (e.g. an endpoint with no rate limiting).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { curlRepro } from './target.mjs';

export const SEVERITY = { high: 3, medium: 2, low: 1 };

export function createReport(meta) {
  const findings = [];
  const uncovered = [];
  const notes = [];
  const seen = new Set();

  return {
    meta,
    findings,
    uncovered,
    notes,

    /**
     * Record a finding. `dedupeKey` collapses the same defect found through
     * many mutations — 200 mutated bodies hitting one unguarded handler is one
     * bug, not 200. The first example is kept as the repro.
     */
    add({ severity = 'medium', probe, title, detail, route, response, dedupeKey }) {
      const key = dedupeKey ?? `${probe}|${title}|${route ?? ''}`;
      if (seen.has(key)) {
        const existing = findings.find((f) => f.key === key);
        if (existing) existing.occurrences++;
        return;
      }
      seen.add(key);
      findings.push({
        key,
        severity,
        probe,
        title,
        detail,
        route: route ?? null,
        status: response?.status ?? null,
        responseSnippet: response?.text ? response.text.slice(0, 400) : null,
        repro: response?.request ? curlRepro(response.request) : null,
        occurrences: 1,
      });
    },

    skip(route, reason) {
      uncovered.push({ route: typeof route === 'string' ? route : route.key, reason });
    },

    note(text) {
      notes.push(text);
    },
  };
}

function bySeverity(a, b) {
  return (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0) || a.probe.localeCompare(b.probe);
}

export function printReport(report) {
  const { findings, uncovered, notes, meta } = report;

  console.log('\n' + '='.repeat(72));
  console.log('  Threads security fuzz report');
  console.log('='.repeat(72));
  console.log(`  target      ${meta.baseUrl}`);
  console.log(`  environment ${meta.environment}  commit ${meta.commit}`);
  console.log(`  seed        ${meta.seed}   (replay with --seed ${meta.seed})`);
  console.log(`  probes      ${meta.probes.join(', ')}`);
  console.log(`  requests    ${meta.requestCount ?? 'n/a'}`);
  console.log('='.repeat(72));

  if (!findings.length) {
    console.log('\n  No findings. This means the probes\' oracles did not fire — it is');
    console.log('  evidence, not proof. Read the uncovered list below for what was');
    console.log('  NOT exercised.');
  } else {
    console.log(`\n  ${findings.length} finding(s):\n`);
    for (const [i, f] of [...findings].sort(bySeverity).entries()) {
      console.log(`  ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`);
      console.log(`     probe:  ${f.probe}`);
      if (f.route) console.log(`     route:  ${f.route}`);
      if (f.status !== null) console.log(`     status: ${f.status}`);
      console.log(`     ${f.detail}`);
      if (f.occurrences > 1) console.log(`     (${f.occurrences} occurrences collapsed; first shown)`);
      if (f.responseSnippet) console.log(`     body:   ${f.responseSnippet.replace(/\n/g, ' ').slice(0, 200)}`);
      if (f.repro) console.log(`     repro:  ${f.repro}`);
      console.log('');
    }
  }

  if (uncovered.length) {
    console.log(`\n  ${uncovered.length} route(s)/case(s) NOT covered by this run:\n`);
    for (const u of uncovered) console.log(`    - ${u.route}: ${u.reason}`);
    console.log('\n  These are gaps, not passes. Review them by hand.');
  }

  if (notes.length) {
    console.log('\n  Notes:\n');
    for (const n of notes) console.log(`    - ${n}`);
  }

  console.log('');
}

export function writeReport(report, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`  Full report written to ${path}\n`);
}
