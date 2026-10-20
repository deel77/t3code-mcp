import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpServer } from "../../src/http/server.mjs";

test("HTTP stop tool enforces Access, exact targeting schema, options and safe errors", async () => {
  const calls = [];
  const server = createHttpServer({
    verifyAccess: async (request) => request.headers["cf-access-jwt-assertion"] === "test-identity",
    client: { stopThread: async (...args) => {
      calls.push(args);
      if (args[0] === "error") throw new Error("SECRET provider credential");
      return { thread_id: args[0], project_id: args[1], run_id: args[2], state: "cancellation_requested",
        cancellation_requested: true, command_ids: ["command"], run_status: "waiting", thread_status: "waiting",
        thread_stopped: false, pending_request_ids: ["input"], active_run_ids: [args[2]],
        queued_run_ids: [], held_queued_run_ids: [], background_work_count: 0, verification: "observed" };
    } },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = async (args, authenticated = true, method = "tools/call") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(authenticated ? { "cf-access-jwt-assertion": "test-identity" } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method,
        params: method === "tools/list" ? {} : { name: "stop_thread", arguments: args } }),
    });
    return { status: response.status, body: response.status === 403 ? null : await response.json() };
  };
  try {
    const args = { thread_id: "thread", project_id: "project", run_id: "run", wait_ms: 0, dismiss_pending_input: false };
    assert.equal((await post(args, false)).status, 403);
    assert.deepEqual(calls, []);
    for (const invalid of [{ thread_id: "thread" }, { ...args, run_id: undefined }, { ...args, project_id: undefined },
      { ...args, wait_ms: 10001 }, { ...args, thread_id: "" }, { ...args, dismiss_pending_input: "yes" }]) {
      const { body } = await post(invalid);
      assert.ok(body.error || body.result?.isError, "Bad targeting must fail schema validation");
    }
    assert.deepEqual(calls, []);
    const accepted = await post(args);
    assert.equal(accepted.body.result.structuredContent.state, "cancellation_requested");
    assert.deepEqual(calls, [["thread", "project", "run", { waitMs: 0, dismissPendingInput: false, cancelPendingApprovals: undefined }]]);
    const listed = await post({}, true, "tools/list");
    const stop = listed.body.result.tools.find((tool) => tool.name === "stop_thread");
    assert.deepEqual(stop.inputSchema.required, ["thread_id", "project_id", "run_id"]);
    assert.equal(stop.annotations.idempotentHint, true);
    assert.equal(stop.annotations.destructiveHint, true);
    assert.ok(stop.outputSchema.properties.thread_stopped);
    const failed = await post({ ...args, thread_id: "error" });
    assert.equal(failed.body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(failed.body), /SECRET/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
