# Architecture

The bridge uses native JavaScript ES modules on Node.js. There is no build step or bridge database. T3Code owns projects, thread history, pending requests, and model configuration.

## Request flow

```text
MCP client
  -> Cloudflare Access / tunnel
  -> HTTP server + Access assertion verification
  -> MCP tool schema and handler
  -> T3Code client
  -> T3Code HTTP API or WebSocket RPC
```

[`src/index.mjs`](../src/index.mjs) reads configuration and creates the production dependencies. Importing the other modules does not start a listener. `loadConfig(env)` accepts an environment object so configuration tests do not change process-wide state.

[`src/http/server.mjs`](../src/http/server.mjs) owns routing, authentication gating, and transport cleanup. `createHttpServer({ client, verifyAccess })` accepts the T3Code client and verifier. Each authenticated POST gets a stateless MCP server and transport.

[`src/auth/cloudflare-access.mjs`](../src/auth/cloudflare-access.mjs) validates Access configuration and verifies JWTs against the team's published signing keys. The production entrypoint always supplies this verifier. Tests supply their own verifier without adding a production authentication bypass.

[`src/mcp/server.mjs`](../src/mcp/server.mjs) owns tool schemas, descriptions, annotations, and argument mapping. MCP metadata reads the version from `package.json`. The tool handler returns expected `BridgeError` messages and hides unexpected internal errors.

[`src/t3/client.mjs`](../src/t3/client.mjs) owns project visibility checks, thread reads, cursor handling, and commands. It accepts `fetchImpl` and `rpcImpl` for tests. Its neighboring modules interpret pending questions, approvals, and model choices. These modules have no dependency on MCP transport or environment variables.

[`src/t3/rpc.mjs`](../src/t3/rpc.mjs) handles authenticated WebSocket tickets and Effect RPC. Creating a thread requires `orchestration.dispatchCommand` with `bootstrap.createThread` over RPC. The HTTP dispatch endpoint handles commands for existing threads. Preserve this distinction when changing command handling.

[`scripts/refresh-token.mjs`](../scripts/refresh-token.mjs) runs separately from the HTTP server. It obtains and replaces scoped credentials without exposing them to the MCP client.

## Tests

- `tests/unit/` exercises T3Code client behavior using simulated HTTP and RPC responses, plus configuration and response interpretation.
- `tests/integration/` sends actual JSON-RPC requests through a local HTTP MCP server with a simulated T3Code backend. It covers tool discovery, access gating, thread creation, input answers, and approval decisions.
- `tests/helpers/` provides temporary credentials and shared T3Code fixtures.

Automated tests do not prove compatibility with every T3Code deployment. Use the authenticated read checks in the deployment guide after updating the bridge or T3Code.
