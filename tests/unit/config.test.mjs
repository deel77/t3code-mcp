import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../../src/config.mjs";

const required = {
  T3_BASE_URL: "http://127.0.0.1:3773",
  T3_TOKEN_FILE: "/tmp/example-token",
};

test("configuration uses a loopback listener and keeps credentials as file references", () => {
  const config = loadConfig(required);
  assert.deepEqual(config.http, { host: "127.0.0.1", port: 3993 });
  assert.deepEqual(config.t3, { baseUrl: required.T3_BASE_URL, tokenFile: required.T3_TOKEN_FILE });
});

test("configuration forwards explicit listener and Access settings", () => {
  const access = {
    CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    CF_ACCESS_AUD: "a".repeat(64),
    CF_ACCESS_ALLOWED_EMAIL: "person@example.com",
  };
  const config = loadConfig({ ...required, ...access, T3_MCP_HOST: "192.0.2.1", T3_MCP_PORT: "4000" });
  assert.deepEqual(config.http, { host: "192.0.2.1", port: 4000 });
  assert.deepEqual(config.access, {
    teamDomain: access.CF_ACCESS_TEAM_DOMAIN,
    audience: access.CF_ACCESS_AUD,
    allowedEmail: access.CF_ACCESS_ALLOWED_EMAIL,
  });
});

test("configuration rejects missing T3 settings and invalid listener values", () => {
  assert.throws(() => loadConfig({}), /T3_BASE_URL and T3_TOKEN_FILE/);
  assert.throws(() => loadConfig({ T3_BASE_URL: required.T3_BASE_URL }), /T3_TOKEN_FILE/);
  for (const port of ["", "0", "-1", "65536", "3993.5", "invalid"]) {
    assert.throws(() => loadConfig({ ...required, T3_MCP_PORT: port }), /T3_MCP_PORT/);
  }
  assert.throws(() => loadConfig({ ...required, T3_MCP_HOST: " " }), /T3_MCP_HOST/);
});
