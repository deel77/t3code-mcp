/** Read startup configuration without opening connections or reading credentials. */
export function loadConfig(env = process.env) {
  if (!env.T3_BASE_URL || !env.T3_TOKEN_FILE) {
    throw new Error("T3_BASE_URL and T3_TOKEN_FILE must be set.");
  }
  const port = Number(env.T3_MCP_PORT ?? 3993);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("T3_MCP_PORT must be an integer between 1 and 65535.");
  }
  const host = env.T3_MCP_HOST ?? "127.0.0.1";
  if (!host.trim()) throw new Error("T3_MCP_HOST must not be empty.");

  return {
    t3: { baseUrl: env.T3_BASE_URL, tokenFile: env.T3_TOKEN_FILE },
    access: {
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      audience: env.CF_ACCESS_AUD,
      allowedEmail: env.CF_ACCESS_ALLOWED_EMAIL,
    },
    http: { host, port },
  };
}
