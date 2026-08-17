#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run openapi:types
npm run openapi:python-client
