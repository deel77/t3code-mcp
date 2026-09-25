# T3Code MCP bridge

A self-hosted MCP server for working with T3Code from an MCP client, including voice conversations. Find threads, read updates, answer questions, review approvals, and start coding turns through Streamable HTTP.

This is an independent project and is not affiliated with the authors of T3Code.

## Requirements

- Node.js 24 or newer.
- A reachable T3Code orchestration API and a credential with `orchestration:read` and `orchestration:operate` scopes.
- A Cloudflare Access application for your MCP hostname, restricted to one email address.
- A tunnel or reverse proxy connecting that hostname to the bridge.

The bridge exposes every project visible to its T3Code credential. It has no separate project allowlist or multi-user isolation. New threads default to `full-access`; choose `runtime_mode: "approval-required"` to review requested actions.

## Get started

```sh
npm ci
cp .env.example .env
```

Edit `.env` with your T3Code address, a token path outside the checkout, and Cloudflare Access settings. See the [configuration reference](docs/configuration.md) for each variable.

If an authorized `t3` CLI is available, obtain a scoped credential:

```sh
node --env-file=.env scripts/refresh-token.mjs
```

The script writes the token with mode `0600`. Set `T3_BINARY` if the CLI is outside `PATH`. You can also provision the scoped token yourself at `T3_TOKEN_FILE`.

Start the bridge:

```sh
node --env-file=.env src/index.mjs
```

When configuration is already exported in the environment, use `npm start` and `npm run refresh-token` instead. These commands do not automatically load `.env`.

Route your MCP hostname through Cloudflare Access to the bridge, then add `https://your-mcp-hostname.example/mcp` in your MCP client. Follow the [deployment guide](docs/deployment.md) for Access setup, systemd services, and connection checks.

## Tools

| Task | Tools |
| --- | --- |
| Browse projects and threads | `list_projects`, `list_threads`, `list_recent_threads`, `find_thread` |
| Check progress | `list_attention`, `get_thread`, `get_thread_updates`, `get_thread_changes` |
| Resolve pending requests | `answer_thread_input`, `respond_thread_approval` |
| Choose a model and start work | `list_model_options`, `start_thread`, `send_followup` |

See the [tool guide](docs/tools.md) for runtime modes, approval decisions, cursors, and model selection limits.

## Project layout

```text
src/
  index.mjs          Application startup
  config.mjs         Environment configuration
  errors.mjs         Errors safe to return to MCP clients
  auth/              Cloudflare Access verification
  http/              HTTP routing and MCP transport lifecycle
  mcp/               Tool schemas, descriptions, and registration
  t3/                T3Code client, RPC, and response interpretation
tests/
  unit/              Client behavior, configuration, and parsing tests
  integration/       MCP calls over a local HTTP server
  helpers/           Shared test fixtures
scripts/             Credential maintenance
deploy/systemd/      Example service and timer units
docs/                Configuration, deployment, tools, and architecture
```

## Development

```sh
npm test
npm run test:unit
npm run test:integration
npm run test:coverage
```

Tests use temporary credentials and simulated T3Code responses. They do not require a running T3Code server or Cloudflare account. GitHub Actions runs the suite on Node.js 24.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture guide](docs/architecture.md) before changing the bridge.

## License

MIT. See [LICENSE](LICENSE).
