#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run openapi:clients

test -s generated/types/threads.d.ts

test -f generated/python/threads-api-client/pyproject.toml
test -f generated/python/threads-api-client/threads_api_client/__init__.py

PYTHONPATH="$PWD/generated/python/threads-api-client" \
  "$PWD/.venv-openapi/bin/python" - <<'PY'
import httpx

from threads_api_client import AuthenticatedClient, Client
from threads_api_client.api.users import get_users_me
from threads_api_client.errors import UnexpectedStatus
from threads_api_client.models import Channel, Error, Message

assert Client
assert AuthenticatedClient
assert Channel
assert Message

expected_base_url = "https://threads.example.com/api"
client = Client(base_url=expected_base_url, raise_on_unexpected_status=True)
assert str(client.get_httpx_client().base_url).rstrip("/") == expected_base_url
assert client.raise_on_unexpected_status is True

api_client = AuthenticatedClient(base_url=expected_base_url, token="test-token")
assert api_client.get_httpx_client().headers["Authorization"] == "Bearer test-token"

parsed_error = get_users_me._parse_response(
    client=api_client,
    response=httpx.Response(401, json={"error": "unauthorized"}),
)
assert isinstance(parsed_error, Error)
assert parsed_error.error == "unauthorized"

try:
    get_users_me._parse_response(client=client, response=httpx.Response(599, content=b"boom"))
except UnexpectedStatus as exc:
    assert exc.status_code == 599
    assert exc.content == b"boom"
else:
    raise AssertionError("expected undocumented statuses to raise when configured")
PY

"$PWD/.venv-openapi/bin/python" -m ruff check \
  generated/python/threads-api-client/threads_api_client
