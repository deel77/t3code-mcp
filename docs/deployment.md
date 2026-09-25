# Deployment

## Cloudflare Access and routing

1. Create a self-hosted Access application for your MCP hostname.
2. Add an Allow policy restricted to the email set in `CF_ACCESS_ALLOWED_EMAIL`.
3. Copy the Access team domain and application audience tag into the bridge configuration.
4. Configure Managed OAuth if your MCP client uses it.
5. Route the hostname to the bridge with a Cloudflare Tunnel or reverse proxy. When the tunnel runs on the bridge host, use `http://127.0.0.1:3993`.
6. Add `https://your-mcp-hostname.example/mcp` to the MCP client and complete sign-in.

The bridge verifies the Access assertion's signature, issuer, audience, expiry, and email on each MCP request. Keep the listener reachable only by the tunnel or trusted reverse proxy. If they run on another host, bind to an appropriate private address.

The endpoint accepts `POST /mcp`. Other paths return `404`; other methods return `405`. Requests without a valid Access assertion return `403` at the bridge. Cloudflare may reject requests before they reach it.

## Run under systemd

The examples in [`deploy/systemd/`](../deploy/systemd/) use `/opt/t3code-mcp` for the checkout, `/var/lib/t3code-mcp` for credentials, and a dedicated `t3code-mcp` account. Adapt the account, paths, Node executable, and private T3Code address to your host.

1. Install dependencies in the application directory with `npm ci --omit=dev`.
2. Provision the token and make it readable by the bridge account. The refresh service must run as an account whose `t3` CLI can create pairing credentials.
3. Create `/etc/t3code-mcp/access.env` with `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `CF_ACCESS_ALLOWED_EMAIL`. Restrict access to the file.
4. Copy `t3code-mcp.service.example` to `/etc/systemd/system/t3code-mcp.service` and edit it for your installation.
5. If using automatic credential refresh, also install `t3code-mcp-token.service.example` as `t3code-mcp-token.service` and copy `t3code-mcp-token.timer`.
6. Reload and start the services:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now t3code-mcp.service
   sudo systemctl enable --now t3code-mcp-token.timer
   ```

Skip the timer command if another process manages credentials. Its daily check refreshes the token only when needed.

## Verify the deployment

Check the service and recent logs:

```sh
systemctl status t3code-mcp.service
journalctl -u t3code-mcp.service -n 50 --no-pager
```

An unauthenticated local POST should return `403`:

```sh
curl -i -X POST http://127.0.0.1:3993/mcp
```

Through an authenticated MCP client, scan for all 13 tools, then call `list_projects`, `list_model_options`, and `list_recent_threads`. Read an existing thread with `get_thread`, and pass its `updates_cursor` to `get_thread_updates`. Start a turn only when you intend T3Code to do work.

## Application updates

Run `npm ci` and `npm test` in the new checkout before deploying it. The server entrypoint is `src/index.mjs`; credential maintenance uses `scripts/refresh-token.mjs`. Keep the full `src/` directory, `package.json`, and installed dependencies together. Keep credentials and deployment-specific configuration outside the checkout.

Restart `t3code-mcp.service` after replacing application files. Repeat the access rejection and authenticated read checks above. Keep a copy of the deployed application and service units until the new deployment is verified.
