import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpServer } from "../../src/http/server.mjs";

const tools = {
  settle_thread: "settleThread", unsettle_thread: "unsettleThread",
  archive_thread: "archiveThread", unarchive_thread: "unarchiveThread",
};

test("HTTP lifecycle tools enforce Access, exact targeting, annotations and safe errors", async () => {
  const calls = [];
  const client = Object.fromEntries(Object.entries(tools).map(([tool, method]) => [method, async (...args) => {
    calls.push([method, ...args]);
    if (args[0] === "error") throw new Error("SECRET provider credential");
    return { thread_id: args[0], project_id: args[1], action: tool.replace("_thread", ""), state: "applied",
      changed: true, command_id: "mcp-command", title: "Shopping list", settled: tool === "settle_thread",
      settled_at: tool === "settle_thread" ? "2026-10-28T11:00:00.000Z" : null, archived: tool === "archive_thread",
      archived_at: tool === "archive_thread" ? "2026-10-28T11:00:00.000Z" : null, thread_status: "completed",
      latest_run_id: "run-1", verification: "observed", effects: [] };
  }]));
  const server = createHttpServer({ client,
    verifyAccess: async (request) => request.headers["cf-access-jwt-assertion"] === "test-identity" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = async (name, args, authenticated = true, method = "tools/call") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(authenticated ? { "cf-access-jwt-assertion": "test-identity" } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method,
        params: method === "tools/list" ? {} : { name, arguments: args } }),
    });
    return { status: response.status, body: response.status === 403 ? null : await response.json() };
  };
  try {
    const args = { thread_id: "thread", project_id: "project", wait_ms: 0 };
    for (const name of Object.keys(tools)) {
      assert.equal((await post(name, args, false)).status, 403);
      for (const invalid of [{ thread_id: "thread" }, { project_id: "project" }, { ...args, thread_id: "" },
        { ...args, wait_ms: 10001 }, { ...args, wait_ms: 1.5 }]) {
        const { body } = await post(name, invalid);
        assert.ok(body.error || body.result?.isError, `${name} must reject ${JSON.stringify(invalid)}`);
      }
    }
    assert.deepEqual(calls, []);
    for (const invalid of [{ ...args, cancel_pending_input: "yes" }, { ...args, stop_background_work: 1 }]) {
      const { body } = await post("settle_thread", invalid);
      assert.ok(body.error || body.result?.isError);
    }
    assert.deepEqual(calls, []);

    const settled = await post("settle_thread", { ...args, cancel_pending_input: true });
    assert.equal(settled.body.result.structuredContent.settled, true);
    assert.equal(settled.body.result.structuredContent.thread_status, "completed");
    await post("unsettle_thread", args);
    await post("archive_thread", { ...args, stop_background_work: true });
    await post("unarchive_thread", args);
    assert.deepEqual(calls, [
      ["settleThread", "thread", "project", { waitMs: 0, cancelPendingInput: true, stopBackgroundWork: undefined }],
      ["unsettleThread", "thread", "project", { waitMs: 0 }],
      ["archiveThread", "thread", "project", { waitMs: 0, stopBackgroundWork: true }],
      ["unarchiveThread", "thread", "project", { waitMs: 0 }],
    ]);

    const listed = (await post(null, {}, true, "tools/list")).body.result.tools;
    for (const name of Object.keys(tools)) {
      const tool = listed.find((item) => item.name === name);
      assert.ok(tool, `${name} is advertised`);
      assert.deepEqual(tool.inputSchema.required, ["thread_id", "project_id"]);
      assert.equal(tool.annotations.idempotentHint, true);
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.destructiveHint, name === "archive_thread");
      assert.ok(tool.outputSchema.properties.settled && tool.outputSchema.properties.archived);
      assert.ok(tool.outputSchema.properties.verification);
    }
    assert.ok(listed.find((item) => item.name === "find_thread").inputSchema.properties.include_archived);
    assert.ok(listed.find((item) => item.name === "settle_thread").inputSchema.properties.cancel_pending_input);
    assert.equal(listed.find((item) => item.name === "unarchive_thread").inputSchema.properties.cancel_pending_input, undefined);

    const failed = await post("archive_thread", { ...args, thread_id: "error" });
    assert.equal(failed.body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(failed.body), /SECRET/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
