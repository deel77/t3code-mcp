import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const tokenFile = process.env.T3_TOKEN_FILE;
const t3Binary = process.env.T3_BINARY ?? "t3";
const baseUrl = process.env.T3_BASE_URL;

async function refresh() {
  if (!baseUrl || !tokenFile) throw new Error("T3_BASE_URL and T3_TOKEN_FILE must be set.");
  const expiryFile = `${tokenFile}.expires-at`;
  let expiresAt = 0;
  let hasToken = false;
  try { expiresAt = Date.parse(await readFile(expiryFile, "utf8")); } catch {}
  try { hasToken = Boolean((await readFile(tokenFile, "utf8")).trim()); } catch {}
  if (hasToken && Number.isFinite(expiresAt) && expiresAt - Date.now() > 7 * 24 * 60 * 60 * 1000) {
    process.stdout.write("T3Code MCP credential remains valid.\n");
    return;
  }
  const pairing = JSON.parse(execFileSync(t3Binary, [
    "auth", "pairing", "create", "--ttl", "5m", "--label", "T3Code MCP bridge", "--json",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  if (typeof pairing.credential !== "string" || !pairing.credential) throw new Error("Pairing credential was missing.");
  const response = await fetch(new URL("/oauth/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: pairing.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate",
      client_label: "T3Code MCP bridge",
      client_device_type: "bot",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`T3Code credential exchange failed: HTTP ${response.status}.`);
  const token = await response.json();
  if (typeof token.access_token !== "string" || token.scope !== "orchestration:read orchestration:operate" || !Number.isFinite(token.expires_in)) {
    throw new Error("T3Code issued an unexpected credential response.");
  }
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  const tempFile = `${tokenFile}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${token.access_token}\n`, { mode: 0o600, flag: "wx" });
  await rename(tempFile, tokenFile);
  await writeFile(expiryFile, new Date(Date.now() + token.expires_in * 1000).toISOString(), { mode: 0o600 });
  process.stdout.write("T3Code MCP credential refreshed with orchestration scopes.\n");
}

refresh().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
