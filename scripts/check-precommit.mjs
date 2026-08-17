#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const THREADS_PREFIXES = [
  'api/',
  'agent-tools/',
  'client/',
  'examples/sim-agent/'
];
const THREADS_FILES = new Set([
  '.husky/pre-commit',
  'eslint.config.mjs',
  'package-lock.json',
  'package.json',
  'scripts/artifact-metadata.mjs',
  'scripts/check-precommit.mjs',
  'scripts/check-precommit.test.mjs',
  'scripts/validate-and-deploy.sh'
]);

const BROAD_CHECK_FILES = new Set(['package-lock.json', 'package.json']);
const LINT_CONFIG_FILES = new Set(['eslint.config.mjs']);
const PRECOMMIT_CHECK_FILES = new Set([
  '.husky/pre-commit',
  'scripts/check-precommit.mjs',
  'scripts/check-precommit.test.mjs'
]);
const API_BROAD_TEST_FILES = new Set([
  'api/package.json',
  'api/tsconfig.json',
  'api/vitest.config.ts',
  'api/wrangler.toml',
  'api/src/__tests__/helpers.ts',
  'api/src/__tests__/setup.ts'
]);
const CLIENT_BROAD_TEST_FILES = new Set([
  'client/package.json',
  'client/svelte.config.js',
  'client/tsconfig.json',
  'client/vite.config.ts',
  'client/vite.worker.config.ts',
  'client/vitest.config.ts',
  'wrangler.jsonc'
]);
const API_OPENAPI_FILES = [
  /^scripts\/artifact-metadata\.mjs$/,
  /^scripts\/artifact-metadata\.test\.mjs$/,
  /^api\/vitest\.contract\.config\.ts$/,
  /^api\/openapi\//,
  /^api\/scripts\/build-contract(?:\.test)?\.mjs$/,
  /^api\/scripts\/(?:bundle-specs|check-openapi-clients|generate-openapi-clients|generate-python-client)\.sh$/,
  /^api\/scripts\/(?:bundle-specs|check-openapi-clients)\.mjs$/,
  /^api\/src\/(?:openapi-spec|ws-events-spec|agents-txt)\.json$/,
  /^api\/src\/routes\/.*\.ts$/
];
const CONTRACT_BOUNDARIES = [
  {
    name: 'HTTP API',
    source: 'api/openapi/threads.yaml',
    implementationFiles: [
      /^api\/src\/routes\/(?!(?:openapi|types)\.ts$).*\.ts$/
    ]
  },
  {
    name: 'WebSocket events',
    source: 'api/openapi/ws-events.yaml',
    implementationFiles: [
      /^api\/src\/(?:chat-room|chat-room-actions|presence-room|user-events-room)\.ts$/,
      /^api\/src\/lib\/webhooks\.ts$/,
      /^api\/src\/routes\/(?:channels|kanban|link-previews|messages|pins|push-send)\.ts$/,
      /^api\/src\/services\/(?:messages|processes)\.ts$/
    ]
  }
];
const AGENT_TOOLS_CONTRACT_TESTS = ['caller.integration.test.ts', 'mcp.integration.test.ts'];
const API_CENTRAL_SOURCE_FILES = new Set([
  'api/src/chat-room.ts',
  'api/src/chat-room-actions.ts',
  'api/src/index.ts',
  'api/src/middleware.ts',
  'api/src/types.ts'
]);
const API_SOURCE_TESTS = new Map(
  Object.entries({
    'api/src/auth.ts': [
      'auth.test.ts',
      'auth.integration.test.ts',
      'session-invalidation.integration.test.ts'
    ],
    'api/src/core/kernel.ts': [
      'core-boundary.test.ts',
      'route-boundary-inventory.test.ts',
      'openapi-inventory.test.ts'
    ],
    'api/src/lib/circuit-breaker.ts': ['circuit-breaker.integration.test.ts'],
    'api/src/lib/origins.ts': ['csp.test.ts', 'widget-origin.test.ts'],
    'api/src/lib/web-push.ts': ['web-push.test.ts', 'push.integration.test.ts'],
    'api/src/lib/webhooks.ts': ['webhooks.test.ts', 'webhooks.integration.test.ts'],
    'api/src/presence-room.ts': [
      'presence.integration.test.ts',
      'typing.integration.test.ts'
    ],
    'api/src/read-models/messages.ts': [
      'messages.integration.test.ts',
      'message-links.integration.test.ts',
      'mentions.integration.test.ts',
      'search.integration.test.ts',
      'sync-state.integration.test.ts'
    ],
    'api/src/read-models/processes.ts': ['processes.integration.test.ts'],
    'api/src/routes/auth.ts': [
      'auth.integration.test.ts',
      'auth.test.ts',
      'session-invalidation.integration.test.ts'
    ],
    'api/src/routes/basic.ts': [
      'route-boundary-inventory.test.ts',
      'openapi-inventory.test.ts'
    ],
    'api/src/routes/channels.ts': [
      'channels.integration.test.ts',
      'channel-leave.integration.test.ts',
      'channel-notifications.integration.test.ts',
      'channel-updates.integration.test.ts',
      'folder-reorder.integration.test.ts',
      'folders.integration.test.ts',
      'membership.integration.test.ts'
    ],
    'api/src/routes/dms.ts': [
      'dms.integration.test.ts',
      'dm-bot-permissions.integration.test.ts',
      'dm-hide.integration.test.ts',
      'dm-reorder.integration.test.ts'
    ],
    'api/src/routes/drafts.ts': [
      'drafts.integration.test.ts',
      'drafts-list.integration.test.ts',
      'draft-attachments.integration.test.ts',
      'scheduled-drafts.integration.test.ts'
    ],
    'api/src/routes/link-previews.ts': ['link-previews.integration.test.ts'],
    'api/src/routes/messages.ts': [
      'messages.integration.test.ts',
      'messages-push-policy.test.ts',
      'message-links.integration.test.ts',
      'mentions.integration.test.ts',
      'scheduled-messages.integration.test.ts',
      'jump-to-unread.integration.test.ts'
    ],
    'api/src/routes/non-basic.ts': [
      'route-boundary-inventory.test.ts',
      'openapi-inventory.test.ts'
    ],
    'api/src/routes/openapi.ts': [
      'cli-discovery.integration.test.ts',
      'openapi-inventory.test.ts'
    ],
    'api/src/routes/push.ts': [
      'push.integration.test.ts',
      'push-send.test.ts',
      'messages-push-policy.test.ts',
      'web-push.test.ts'
    ],
    'api/src/routes/push-send.ts': ['push-send.test.ts', 'push.integration.test.ts'],
    'api/src/routes/register.ts': [
      'route-boundary-inventory.test.ts',
      'openapi-inventory.test.ts'
    ],
    'api/src/routes/saved-drafts.ts': ['saved-drafts.integration.test.ts'],
    'api/src/routes/search.ts': [
      'search.integration.test.ts',
      'search-filter-only.integration.test.ts',
      'search-has-filter.integration.test.ts',
      'user-search.integration.test.ts'
    ],
    'api/src/routes/sync-state.ts': ['sync-state.integration.test.ts'],
    'api/src/routes/users.ts': [
      'users.integration.test.ts',
      'user-search.integration.test.ts'
    ],
    'api/src/routes/webhooks.ts': [
      'webhooks.test.ts',
      'webhooks.integration.test.ts'
    ],
    'api/src/routes/widget-data.ts': [
      'widget-data.integration.test.ts',
      'widget-origin.test.ts',
      'widgets.integration.test.ts'
    ],
    'api/src/routes/widgets.ts': [
      'widgets.integration.test.ts',
      'widget-data.integration.test.ts',
      'widget-origin.test.ts'
    ],
    'api/src/services/processes.ts': ['processes.integration.test.ts'],
    'api/src/user-events-room.ts': [
      'events.integration.test.ts',
      'sync-state.integration.test.ts',
      'ws-action-errors.integration.test.ts'
    ],
    'api/src/utils.ts': ['utils.test.ts']
  })
);

const DRY_RUN = process.argv.includes('--dry-run');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const ROOT = process.cwd();

function normalizePath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isThreadsPath(file) {
  const normalized = normalizePath(file);
  return (
    THREADS_FILES.has(normalized) ||
    THREADS_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function fileExists(file) {
  return existsSync(path.join(ROOT, file));
}

function walkFiles(dir) {
  const absoluteDir = path.join(ROOT, dir);
  if (!existsSync(absoluteDir)) return [];

  const files = [];
  for (const entry of readdirSync(absoluteDir)) {
    const file = path.posix.join(dir, entry);
    const absoluteFile = path.join(ROOT, file);
    if (statSync(absoluteFile).isDirectory()) {
      files.push(...walkFiles(file));
    } else {
      files.push(file);
    }
  }
  return files;
}

function stripPrefix(file, prefix) {
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

function isLintable(file) {
  return /\.(?:cjs|js|mjs|svelte|ts|tsx)$/.test(file) && fileExists(file);
}

function isShellScript(file) {
  return (file.endsWith('.sh') || file === '.husky/pre-commit') && fileExists(file);
}

function isApiTest(file) {
  return /^api\/src\/__tests__\/[^/]+\.test\.ts$/.test(file) ||
    /^api\/src\/__tests__\/[^/]+\.integration\.test\.ts$/.test(file);
}

function isApiSmokeTest(file) {
  return /^api\/src\/__tests__\/smoke\/[^/]+\.smoke\.test\.ts$/.test(file);
}

function isClientTest(file) {
  return /^client\/src\/.+\.test\.ts$/.test(file);
}

function isApiSource(file) {
  return /^api\/src\/.+\.(?:json|ts)$/.test(file) && !file.includes('/__tests__/');
}

function isClientSource(file) {
  return /^client\/src\/.+\.(?:js|svelte|ts)$/.test(file) && !isClientTest(file);
}

function isClientCheckFile(file) {
  return (
    CLIENT_BROAD_TEST_FILES.has(file) ||
    /^client\/src\//.test(file) ||
    /^client\/static\//.test(file)
  );
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

function enforceContractFirst(changedFiles) {
  const staged = new Set(changedFiles);
  const violations = CONTRACT_BOUNDARIES.flatMap((boundary) => {
    if (staged.has(boundary.source)) return [];

    const changedBoundaryFiles = changedFiles.filter((file) =>
      matchesAny(file, boundary.implementationFiles)
    );
    return changedBoundaryFiles.length > 0
      ? [{ ...boundary, changedBoundaryFiles }]
      : [];
  });

  if (violations.length === 0) return;

  console.error('\nContract-first guard failed.');
  for (const violation of violations) {
    console.error(`\n${violation.name} boundary changes require ${violation.source}:`);
    for (const file of violation.changedBoundaryFiles) {
      console.error(`  ${file}`);
    }
  }
  console.error(
    '\nUpdate and stage each listed source contract with its implementation change. ' +
    'Use git commit --no-verify only when the wire contract is intentionally unchanged.'
  );
  process.exit(1);
}

function readText(file) {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

function importSpecifiersForSource(testFile, sourceFile, packagePrefix) {
  const testDir = path.posix.dirname(testFile);
  const relative = path.posix.relative(testDir, sourceFile);
  const relativeWithDot = relative.startsWith('.') ? relative : `./${relative}`;
  const noTsExtension = relativeWithDot.replace(/\.(?:svelte\.)?ts$/, '.js');
  const noExtension = relativeWithDot.replace(/\.(?:js|json|svelte|ts)$/, '');
  const specifiers = new Set([relativeWithDot, noExtension]);

  if (relativeWithDot.endsWith('.ts') || relativeWithDot.endsWith('.svelte.ts')) {
    specifiers.add(noTsExtension);
  }

  if (packagePrefix === 'client' && sourceFile.startsWith('client/src/lib/')) {
    const alias = `$lib/${sourceFile.slice('client/src/lib/'.length)}`;
    specifiers.add(alias);
    specifiers.add(alias.replace(/\.(?:js|svelte|ts)$/, ''));
    if (alias.endsWith('.ts') || alias.endsWith('.svelte.ts')) {
      specifiers.add(alias.replace(/\.(?:svelte\.)?ts$/, '.js'));
    }
  }

  return [...specifiers];
}

function testImportsSource(testFile, sourceFile, packagePrefix) {
  if (!fileExists(testFile)) return false;
  const contents = readText(testFile);
  return importSpecifiersForSource(testFile, sourceFile, packagePrefix).some((specifier) =>
    contents.includes(`'${specifier}'`) || contents.includes(`"${specifier}"`)
  );
}

function testFileByName(testFiles, testName) {
  return testFiles.find((file) => path.posix.basename(file) === testName);
}

function addNamedApiTests(plan, testFiles, testNames) {
  for (const testName of testNames) {
    const file = testFileByName(testFiles, testName);
    if (file) plan.apiTests.add(stripPrefix(file, 'api/'));
  }
}

function candidateClientTestFiles(sourceFile) {
  const dir = path.posix.dirname(sourceFile);
  const ext = path.posix.extname(sourceFile);
  const base = path.posix.basename(sourceFile, ext);
  const candidates = new Set();

  if (sourceFile.endsWith('.svelte')) {
    candidates.add(`${dir}/${base}.test.ts`);
    candidates.add(`${dir}/${base}.svelte.test.ts`);
  } else if (sourceFile.endsWith('.ts')) {
    const testBase = sourceFile.slice(0, -'.ts'.length);
    candidates.add(`${testBase}.test.ts`);
    candidates.add(`${testBase}.svelte.test.ts`);
  } else if (sourceFile.endsWith('.js')) {
    candidates.add(`${sourceFile.slice(0, -'.js'.length)}.test.ts`);
  }

  return [...candidates].filter(fileExists);
}

function featureTerms(file) {
  const stem = path.posix.basename(file).replace(/\.(?:json|svelte|ts)$/, '');
  const terms = new Set([stem]);

  for (const part of stem.split(/[^a-zA-Z0-9]+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    terms.add(lower);
    if (lower.endsWith('ies')) terms.add(`${lower.slice(0, -3)}y`);
    if (lower.endsWith('es')) terms.add(lower.slice(0, -2));
    if (lower.endsWith('s')) terms.add(lower.slice(0, -1));
  }

  if (stem === 'dms') terms.add('dm');
  if (stem === 'widget-data') terms.add('widget');

  return [...terms].filter((term) => term.length > 1);
}

function addFeatureApiTests(plan, testFiles, sourceFile) {
  const terms = featureTerms(sourceFile);
  const matched = testFiles.filter((testFile) => {
    const name = path.posix.basename(testFile).toLowerCase();
    return terms.some((term) => name.includes(term.toLowerCase()));
  });

  for (const file of matched) {
    plan.apiTests.add(stripPrefix(file, 'api/'));
  }
}

function planChecks(changedFiles) {
  const apiTestFiles = walkFiles('api/src/__tests__')
    .filter((file) => isApiTest(file))
    .sort();
  const clientTestFiles = walkFiles('client/src')
    .filter((file) => isClientTest(file))
    .sort();
  const plan = {
    apiAllTests: false,
    apiOpenapi: false,
    apiSmoke: false,
    apiTests: new Set(),
    clientAllTests: false,
    clientCheck: false,
    clientTests: new Set(),
    agentToolsCheck: false,
    precommitCheck: false,
    fullLint: false,
    lintFiles: new Set(),
    shellFiles: new Set(),
    notes: []
  };

  for (const file of changedFiles) {
    if (BROAD_CHECK_FILES.has(file)) {
      plan.apiAllTests = true;
      plan.apiOpenapi = true;
      plan.clientAllTests = true;
      plan.clientCheck = true;
      plan.agentToolsCheck = true;
      continue;
    }

    if (LINT_CONFIG_FILES.has(file)) {
      plan.fullLint = true;
      continue;
    }

    if (PRECOMMIT_CHECK_FILES.has(file)) {
      plan.precommitCheck = true;
    }

    if (isLintable(file)) {
      plan.lintFiles.add(file);
    }

    if (isShellScript(file)) {
      plan.shellFiles.add(file);
    }

    if (API_BROAD_TEST_FILES.has(file)) {
      plan.apiAllTests = true;
    }

    if (CLIENT_BROAD_TEST_FILES.has(file)) {
      plan.clientAllTests = true;
      plan.clientCheck = true;
    }

    if (matchesAny(file, API_OPENAPI_FILES)) {
      plan.apiOpenapi = true;
      plan.agentToolsCheck = true;
      for (const test of AGENT_TOOLS_CONTRACT_TESTS) plan.apiTests.add(test);
    }

    if (/^agent-tools\//.test(file)) {
      plan.agentToolsCheck = true;
      for (const test of AGENT_TOOLS_CONTRACT_TESTS) plan.apiTests.add(test);
    }

    if (/^api\/migrations\//.test(file)) {
      addNamedApiTests(plan, apiTestFiles, ['migrations.test.ts']);
    }

    if (isApiSmokeTest(file)) {
      plan.apiSmoke = true;
    } else if (isApiTest(file) && fileExists(file)) {
      plan.apiTests.add(stripPrefix(file, 'api/'));
    } else if (API_CENTRAL_SOURCE_FILES.has(file)) {
      plan.apiAllTests = true;
    } else if (API_SOURCE_TESTS.has(file)) {
      addNamedApiTests(plan, apiTestFiles, API_SOURCE_TESTS.get(file));
    } else if (isApiSource(file)) {
      const apiTestsBefore = plan.apiTests.size;
      for (const testFile of apiTestFiles) {
        if (testImportsSource(testFile, file, 'api')) {
          plan.apiTests.add(stripPrefix(testFile, 'api/'));
        }
      }
      addFeatureApiTests(plan, apiTestFiles, file);
      if (plan.apiTests.size === apiTestsBefore && !plan.apiAllTests) {
        plan.apiAllTests = true;
        plan.notes.push(`${file}: no targeted API test match; running all API tests.`);
      }
    }

    if (isClientCheckFile(file)) {
      plan.clientCheck = true;
    }

    if (isClientTest(file) && fileExists(file)) {
      plan.clientTests.add(stripPrefix(file, 'client/'));
    } else if (isClientSource(file)) {
      for (const testFile of candidateClientTestFiles(file)) {
        plan.clientTests.add(stripPrefix(testFile, 'client/'));
      }
      for (const testFile of clientTestFiles) {
        if (testImportsSource(testFile, file, 'client')) {
          plan.clientTests.add(stripPrefix(testFile, 'client/'));
        }
      }
    }

  }

  if (plan.fullLint) {
    plan.lintFiles.clear();
  }
  if (plan.apiAllTests) {
    plan.apiTests.clear();
  }
  if (plan.clientAllTests) {
    plan.clientTests.clear();
  }

  return plan;
}

function plannedCommands(plan) {
  const commands = [];

  if (plan.fullLint) {
    commands.push({ label: 'Lint all Threads code', args: [NPM, 'run', 'lint'] });
  } else if (plan.lintFiles.size > 0) {
    commands.push({
      label: 'Lint changed files',
      args: [NPM, 'exec', '--', 'eslint', ...[...plan.lintFiles].sort()]
    });
  }

  if (plan.shellFiles.size > 0) {
    commands.push({
      label: 'Check shell script syntax',
      args: ['bash', '-n', ...[...plan.shellFiles].sort()]
    });
  }

  if (plan.precommitCheck) {
    commands.push({
      label: 'Test pre-commit selection and contract guard',
      args: [NPM, 'run', 'check:precommit:test']
    });
  }

  if (plan.apiAllTests) {
    commands.push({ label: 'Run all API tests', args: [NPM, '--prefix', 'api', 'test'] });
  } else if (plan.apiTests.size > 0) {
    commands.push({
      label: 'Run targeted API tests',
      args: [
        NPM,
        '--prefix',
        'api',
        'exec',
        '--',
        'vitest',
        'run',
        '--root',
        'api',
        ...[...plan.apiTests].sort()
      ]
    });
  }

  if (plan.apiSmoke && process.env.SMOKE_BASE_URL && process.env.SMOKE_PASSWORD) {
    commands.push({ label: 'Run API smoke tests', args: [NPM, '--prefix', 'api', 'run', 'test:smoke'] });
  } else if (plan.apiSmoke) {
    plan.notes.push(
      'API smoke tests require SMOKE_BASE_URL and SMOKE_PASSWORD; skipping because no deployed smoke instance is configured.'
    );
  }

  if (plan.apiOpenapi) {
    commands.push({ label: 'Check API OpenAPI output', args: [NPM, '--prefix', 'api', 'run', 'openapi:check'] });
  }

  if (plan.agentToolsCheck) {
    commands.push({
      label: 'Check first-party agent tools and contracts',
      args: [NPM, '--prefix', 'agent-tools/cli', 'run', 'check']
    });
  }

  if (plan.clientCheck) {
    commands.push({ label: 'Check client types', args: [NPM, '--prefix', 'client', 'run', 'check'] });
  }

  if (plan.clientAllTests) {
    commands.push({ label: 'Run all client unit tests', args: [NPM, '--prefix', 'client', 'run', 'test:unit'] });
  } else if (plan.clientTests.size > 0) {
    commands.push({
      label: 'Run targeted client unit tests',
      args: [
        NPM,
        '--prefix',
        'client',
        'exec',
        '--',
        'vitest',
        'run',
        '--root',
        'client',
        ...[...plan.clientTests].sort()
      ]
    });
  }

  return commands;
}

function quoteArg(arg) {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandText(args) {
  return args.map((arg) => quoteArg(arg)).join(' ');
}

function runCommand(command) {
  console.log(`\n==> ${command.label}`);
  console.log(`$ ${commandText(command.args)}`);

  if (DRY_RUN) return;

  const result = spawnSync(command.args[0], command.args.slice(1), { stdio: 'inherit' });
  if (result.error) {
    console.error(`Failed to run ${command.label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getStagedFiles() {
  if (process.env.THREADS_PRECOMMIT_CHANGED_FILES) {
    return process.env.THREADS_PRECOMMIT_CHANGED_FILES
      .split(/\r?\n/)
      .map((file) => normalizePath(file.trim()))
      .filter(Boolean);
  }

  const result = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--no-renames', '-z'],
    { encoding: 'buffer' }
  );

  if (result.error) {
    console.error(`Failed to inspect staged files: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .toString('utf8')
    .split('\0')
    .map((file) => normalizePath(file))
    .filter(Boolean);
}

const stagedFiles = getStagedFiles();

if (stagedFiles.length === 0) {
  console.log('No staged files; skipping Threads pre-commit checks.');
  process.exit(0);
}

const threadsFiles = stagedFiles.filter(isThreadsPath);

if (threadsFiles.length === 0) {
  console.log('No staged Threads code changes; skipping Threads pre-commit checks.');
  process.exit(0);
}

console.log('Staged Threads changes:');
for (const file of threadsFiles) {
  console.log(`  ${file}`);
}

enforceContractFirst(threadsFiles);

const plan = planChecks(threadsFiles);
const commands = plannedCommands(plan);

if (commands.length === 0) {
  console.log('No test or typecheck target selected for these changes.');
  process.exit(0);
}

if (plan.notes.length > 0) {
  console.log('\nPlanning notes:');
  for (const note of plan.notes) {
    console.log(`  ${note}`);
  }
}

console.log('\nSelected checks:');
for (const command of commands) {
  console.log(`  ${command.label}: ${commandText(command.args)}`);
}

for (const command of commands) {
  runCommand(command);
}
