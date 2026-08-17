# Contributing

Run the complete local verification suite from the application repository root:

```bash
npm ci
npm --prefix agent-tools/cli run check
```

API changes begin in `api/openapi/threads.yaml` or
`api/openapi/ws-events.yaml` at the application repository root. Regenerate and
validate the committed copies with:

```bash
npm --prefix api run openapi:check
```

Do not edit `agent-tools/contracts/` or `agent-tools/cli/generated/` by hand.
