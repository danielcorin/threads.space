#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

VENV_DIR=".venv-openapi"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  python3 -m venv "$VENV_DIR"
fi

export PIP_DISABLE_PIP_VERSION_CHECK=1
export PATH="$PWD/$VENV_DIR/bin:$PATH"

"$VENV_DIR/bin/python" -m pip install -q --upgrade openapi-python-client ruff

# openapi-python-client mkdir's only the leaf output dir (non-recursive), so the
# parent must already exist. Ensure it on a clean checkout where generated/ is empty.
mkdir -p generated/python

"$VENV_DIR/bin/python" -m openapi_python_client generate \
  --path openapi/threads.yaml \
  --output-path generated/python/threads-api-client \
  --overwrite
