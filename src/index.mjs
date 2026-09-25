import { createAccessVerifier } from "./auth/cloudflare-access.mjs";
import { loadConfig } from "./config.mjs";
import { createHttpServer } from "./http/server.mjs";
import { T3Client } from "./t3/client.mjs";

const config = loadConfig();
const client = new T3Client(config.t3);
const verifyAccess = createAccessVerifier(config.access);
const { host, port } = config.http;

createHttpServer({ client, verifyAccess }).listen(port, host, () => {
  process.stderr.write(`t3code-mcp: listening on ${host}:${port}\n`);
});
