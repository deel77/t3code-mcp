import assert from "node:assert/strict";
import { test } from "node:test";
import { T3Client } from "../../src/t3/client.mjs";
import { tokenFile } from "../helpers/t3-fixture.mjs";

function fixture({ pending = null, active = null } = {}) {
  const calls = [];
  const shell = { schemaVersion: 2, snapshotSequence: 9, projects: [{ id: "project", title: "Project" }], threads: [{
    id: "thread", projectId: "project", title: "Work", updatedAt: "2026-10-04T10:00:00Z",
    modelSelection: { instanceId: "codex", model: "model" }, runtimeMode: "approval-required",
    status: active ? "running" : pending ? "waiting" : "completed", activeRunId: active,
    pendingRuntimeRequest: pending ? { id: "request", kind: pending } : null,
  }] };
  const projection = {
    thread: shell.threads[0], runs: [{ id: "run", ordinal: 1, status: shell.threads[0].status }],
    messages: [{ id: "message", role: "assistant", runId: "run", text: "Which database?", createdAt: "2026-10-04T10:00:00Z" }],
    runtimeRequests: pending ? [{ id: "request", kind: pending, status: "pending", responseCapability: { type: "live" }, createdAt: "2026-10-04T10:00:00Z" }] : [],
    turnItems: pending ? [{ type: pending === "user_input" ? "user_input_request" : "approval_request", requestId: "request", runId: "run", updatedAt: "2026-10-04T10:00:00Z",
      questions: [{ id: "database", question: "Which database?", options: [{ label: "SQLite", value: "sqlite" }], allowCustomAnswer: false }],
      requestKind: "command", prompt: "Run the command", options: [{ decision: "accept", label: "Allow" }],
    }] : [], checkpoints: [],
  };
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", tokenFile,
    fetchImpl: async (url, options) => {
      assert.equal(options.headers["x-t3-orchestration-protocol"], "2");
      if (url.pathname === "/api/orchestration/shell") return Response.json(shell);
      if (url.pathname === "/api/orchestration/threads/thread") return Response.json({ snapshotSequence: 9, projection });
      throw new Error(`Removed HTTP endpoint: ${url.pathname}`);
    },
    rpcImpl: async (_connection, method, input) => { calls.push({ method, input }); return method === "orchestration.subscribeThread" ? [{ kind: "synchronized" }] : {}; },
  });
  return { client, calls, projection };
}

test("v2 reads negotiate the protocol and preserve messages and pending questions", async () => {
  const { client, calls } = fixture({ pending: "user_input" });
  const recent = await client.listRecentThreads();
  assert.equal(recent.threads[0].needs_user_input, true);
  assert.equal(recent.threads[0].turn_state, "waiting");
  const detail = await client.getThread("thread");
  assert.equal(detail.messages[0].text, "Which database?");
  assert.equal(detail.messages[0].turn_id, "run");
  assert.equal(detail.pending_user_inputs[0].request_id, "request");
  await client.answerThreadInput("thread", "request", { database: "sqlite" });
  assert.equal(calls.at(-1).method, "orchestration.dispatchCommand");
  assert.equal(calls.at(-1).input.type, "runtime-request.respond");
  assert.deepEqual({ ...calls.at(-1).input.answers }, { database: "sqlite" });
});

test("v2 approvals use pending runtime requests and RPC responses", async () => {
  const { client, calls } = fixture({ pending: "command" });
  assert.equal((await client.getThread("thread")).needs_approval, true);
  await client.respondThreadApproval("thread", "request", "accept");
  assert.equal(calls.at(-1).input.type, "runtime-request.respond");
  assert.equal(calls.at(-1).input.decision, "accept");
});

test("v2 launch and follow-up use the new commands without changing permission mode", async () => {
  const { client, calls } = fixture({ active: "active-run" });
  await client.startThread("project", "Inspect files", "Review");
  assert.equal(calls.at(-1).method, "orchestration.launchThread");
  assert.equal(calls.at(-1).input.initialMessage.text, "Inspect files");
  assert.equal(calls.at(-1).input.runtimeMode, "full-access");
  assert.deepEqual(calls.at(-1).input.workspaceStrategy, { type: "root" });
  await client.sendFollowup("thread", "Continue");
  assert.equal(calls.at(-1).input.type, "message.dispatch");
  assert.deepEqual(calls.at(-1).input.dispatchMode, { type: "steer_active", targetRunId: "active-run" });
  assert.equal(calls.at(-1).input.runtimeMode, undefined);
});

test("v2 updates use projection messages and ignore resolved runtime requests", async () => {
  const { client, projection } = fixture({ pending: "user_input" });
  projection.runtimeRequests[0].status = "resolved";
  const detail = await client.getThread("thread");
  assert.deepEqual(detail.pending_user_inputs, []);
  projection.messages.push({ id: "new", role: "assistant", text: "Done", updatedAt: "2026-10-04T10:01:00Z" });
  const updates = await client.getThreadUpdates("thread", detail.updates_cursor);
  assert.equal(updates.messages[0].text, "Done");
});
