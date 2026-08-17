// Bundle the OpenAPI source documents into JSON the Worker can `import` (Workers can't
// read the filesystem at runtime). Run after editing openapi/*.yaml:
//
//   npm run openapi:bundle
//
// Drift tests in src/__tests__/openapi-inventory.test.ts fail if the bundled JSON falls
// out of sync with the YAML source, so CI catches a forgotten re-bundle.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));

// threads.yaml is already JSON on disk — copy it verbatim so the bundled file stays
// byte-identical (no formatting churn in git).
copyFileSync(`${root}/openapi/threads.yaml`, `${root}/src/openapi-spec.json`);
console.log('bundled openapi/threads.yaml → src/openapi-spec.json (copy)');

// ws-events.yaml is real YAML — parse and serialize to JSON for import.
const wsEvents = parse(readFileSync(`${root}/openapi/ws-events.yaml`, 'utf8'));
writeFileSync(`${root}/src/ws-events-spec.json`, `${JSON.stringify(wsEvents, null, 2)}\n`);
console.log('bundled openapi/ws-events.yaml → src/ws-events-spec.json (yaml→json)');

// agents.txt lives at the repo root and is served verbatim at GET /agents.txt. Bundle it
// as a JSON string the Worker can import (JSON.stringify handles all escaping).
const agents = readFileSync(`${root}/../agents.txt`, 'utf8');
writeFileSync(`${root}/src/agents-txt.json`, `${JSON.stringify(agents)}\n`);
console.log('bundled ../agents.txt → src/agents-txt.json (string)');
