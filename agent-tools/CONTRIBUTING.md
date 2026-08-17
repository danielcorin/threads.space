# Contributing

Install Node.js 22+, Go 1.24+, and dependencies from the parent repository:

```bash
cd ..
npm ci
```

Run the complete validation suite:

```bash
npm --prefix agent-tools/cli run check
npm run check:bridge
```

Contract changes begin in the parent repository's `api/openapi/` directory.
Regenerate and validate the copies with:

```bash
npm --prefix api run openapi:check
```

Do not edit `contracts/` or `cli/generated/` by hand. Bridge changes must pass
both `go test` and `go vet`. A parent-repository release tag represents the app,
contract, CLI, and bridge artifact set from one source commit.
