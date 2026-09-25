# Contributing

## Local setup

Use Node.js 24 or newer:

```sh
npm ci
npm test
```

No T3Code server or Cloudflare account is needed for the tests. To run the bridge itself, follow the [README](README.md).

## Making changes

Keep tool schemas and descriptions in `src/mcp/`, HTTP transport in `src/http/`, and T3Code behavior in `src/t3/`. Read the [architecture guide](docs/architecture.md) for the request flow and the distinction between HTTP dispatch and bootstrap RPC.

When fixing behavior, add a regression test at the client or MCP interface that demonstrates the failure. Changes to tool parameters or results should include integration coverage and an update to `docs/tools.md`. Run `npm test` before opening a pull request; use `npm run test:coverage` to inspect coverage locally.

Use native ESM, two-space indentation, and LF line endings. Follow the surrounding code. Keep dependencies pinned and commit `package-lock.json` when changing them.

## Credentials and examples

Use generic projects, provider IDs, domains, and paths in code, tests, and documentation. Keep tokens, private environment files, logs, and personal deployment details out of commits. `.env.example` documents configuration without containing credentials.

Describe what changed and how you verified it in your pull request. Identify any change to MCP behavior or deployment requirements.
