# Configuration

The bridge reads its configuration from the process environment. Copy [`.env.example`](../.env.example) for local use, then load it explicitly with `node --env-file=.env src/index.mjs`. Node does not expand shell expressions such as `$HOME` in this file, so use an absolute token path.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `T3_BASE_URL` | Yes | None | T3Code HTTP origin, such as `http://127.0.0.1:3773`. |
| `T3_TOKEN_FILE` | Yes | None | Path to the scoped T3Code access token. |
| `CF_ACCESS_TEAM_DOMAIN` | Yes | None | HTTPS team domain, such as `https://example-team.cloudflareaccess.com`. |
| `CF_ACCESS_AUD` | Yes | None | Access application audience tag, 64 hexadecimal characters. |
| `CF_ACCESS_ALLOWED_EMAIL` | Yes | None | The single email address authorized by the bridge. |
| `T3_MCP_HOST` | No | `127.0.0.1` | Address on which the HTTP server listens. |
| `T3_MCP_PORT` | No | `3993` | Listener port, an integer between 1 and 65535. |
| `T3_BINARY` | No | `t3` | T3Code CLI executable used by the token refresh script. |

`T3_BASE_URL` must use HTTP and cannot contain credentials, a query, or a fragment. The client uses its origin. Use a private address; this connection does not provide TLS. The public MCP connection should use HTTPS through Cloudflare Access.

Keep the token outside the checkout, readable only by the bridge account. The client rereads it for requests, so rotating the file does not require a server restart. Never put the token itself in `.env` or a systemd unit.

## Credential maintenance

`npm run refresh-token` creates a short-lived pairing credential using the authorized T3Code CLI and exchanges it for `orchestration:read orchestration:operate` scopes. It writes the token atomically with mode `0600`, and stores its expiry in a sibling `.expires-at` file.

The script keeps a nonempty token when the recorded expiry is more than seven days away. It needs only `T3_BASE_URL`, `T3_TOKEN_FILE`, and optionally `T3_BINARY`. Cloudflare Access settings are only needed by the HTTP server.
