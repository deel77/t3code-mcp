import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { T3Client } from "../../src/t3/client.mjs";

const tempDir = await mkdtemp(join(tmpdir(), "t3code-mcp-test-"));
export const tokenFile = join(tempDir, "token");
await writeFile(tokenFile, "test-token\n");
after(() => rm(tempDir, { recursive: true, force: true }));

export function fakeClient() {
  const calls = [];
  const projectId = randomUUID();
  const threadId = randomUUID();
  const shell = {
    projects: [{ id: projectId, title: "My project", defaultModelSelection: null }],
    threads: [{ id: threadId, projectId, title: "Prior work", updatedAt: "2025-01-02T00:00:00Z", modelSelection: { instanceId: "provider-example", model: "model-example" }, latestTurn: { state: "completed" }, session: null }],
  };
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773",
    tokenFile,
    rpcImpl: async (_connection, method, input) => {
      assert.equal(method, "orchestration.dispatchCommand");
      calls.push({ path: "orchestration.dispatchCommand", body: input });
      return { sequence: 1 };
    },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer test-token");
      calls.push({ path: url.pathname, body: options.body && JSON.parse(options.body) });
      if (url.pathname === "/api/orchestration/shell") return Response.json(shell);
      if (url.pathname === "/api/orchestration/dispatch") return Response.json({ sequence: 1 });
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  });
  return { client, calls, projectId };
}
