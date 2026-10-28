import assert from "node:assert/strict";
import { test } from "node:test";
import { T3CommandRejected } from "../../src/errors.mjs";
import { T3Client } from "../../src/t3/client.mjs";
import { rejectionDetail } from "../../src/t3/rpc.mjs";
import { tokenFile } from "../helpers/t3-fixture.mjs";

// A stateful stand-in for T3: protocol-2 shells list only unarchived threads,
// archived threads come from the archived snapshot RPC, and commands apply
// T3's own transitions unless the test overrides the dispatch.
function fixture({ thread: overrides = {}, runs = [], requests = [], messages = [], dispatch, applyDelayReads = 0 } = {}) {
  const calls = [];
  const detailQueries = [];
  const thread = { id: "thread", projectId: "project", title: "Shopping list", status: "completed",
    latestRunId: "run-1", activeRunId: null, pendingBackgroundTasks: [], updatedAt: "2026-10-28T10:00:00.000Z",
    archivedAt: null, settledOverride: null, settledAt: null, pinnedAt: null, snoozedUntil: null, deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null }, ...overrides };
  const other = { ...thread, id: "other-thread", projectId: "other-project", title: "Other" };
  const projects = [{ id: "project", title: "Home" }, { id: "other-project", title: "Other" }];
  let pendingReads = 0;
  let pendingApply = null;
  const apply = (command) => {
    const now = "2026-10-28T11:00:00.000Z";
    if (command.type === "thread.settle") Object.assign(thread, { settledOverride: "settled", settledAt: now, pinnedAt: null, snoozedUntil: null, updatedAt: now });
    if (command.type === "thread.unsettle") Object.assign(thread, { settledOverride: "active", settledAt: null, updatedAt: now });
    if (command.type === "thread.archive") Object.assign(thread, { archivedAt: now, updatedAt: now });
    if (command.type === "thread.unarchive") Object.assign(thread, { archivedAt: null, updatedAt: now });
  };
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", tokenFile,
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer test-token");
      if (pendingApply && pendingReads-- <= 0) { apply(pendingApply); pendingApply = null; }
      if (url.pathname === "/api/orchestration/shell") {
        return Response.json({ schemaVersion: 2, projects, archivedThreads: [],
          threads: [thread, other].filter((item) => item.archivedAt === null) });
      }
      if (url.pathname === "/api/orchestration/threads/thread") {
        detailQueries.push(url.search);
        return Response.json({ projection: { thread, runs, runtimeRequests: requests, messages, turnItems: [] } });
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    },
    rpcImpl: async (_connection, method, input) => {
      if (method === "orchestration.getArchivedShellSnapshot") {
        return { schemaVersion: 2, projects, threads: [thread, other].filter((item) => item.archivedAt !== null) };
      }
      assert.equal(method, "orchestration.dispatchCommand");
      calls.push(input);
      if (dispatch) return dispatch(input, { thread, apply });
      if (applyDelayReads) { pendingApply = input; pendingReads = applyDelayReads; } else apply(input);
      return { sequence: calls.length };
    },
  });
  return { client, calls, thread, other, detailQueries };
}

test("settle sends the native command and reports the observed Settled state", async () => {
  const { client, calls } = fixture({ thread: { pinnedAt: "2026-10-01T00:00:00Z" } });
  const result = await client.settleThread("thread", "project", { waitMs: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "thread.settle");
  assert.equal(calls[0].threadId, "thread");
  assert.match(calls[0].commandId, /^mcp-settle:[0-9a-f]{64}$/);
  assert.equal(result.state, "applied");
  assert.equal(result.changed, true);
  assert.equal(result.settled, true);
  assert.equal(result.archived, false);
  assert.equal(result.thread_status, "completed", "A completed run and Settled are separate fields");
  assert.equal(result.verification, "observed");
  assert.ok(result.effects.some((effect) => /unpins/.test(effect)));
});

test("repeating each action is a no-op without dispatch", async () => {
  for (const [action, overrides] of [
    ["settleThread", { settledOverride: "settled", settledAt: "2026-10-27T00:00:00Z" }],
    ["unsettleThread", {}],
    ["unsettleThread", { settledOverride: "active" }],
    ["archiveThread", { archivedAt: "2026-10-27T00:00:00Z" }],
    ["unarchiveThread", {}],
  ]) {
    const { client, calls } = fixture({ thread: overrides });
    const result = await client[action]("thread", "project", { waitMs: 0 });
    assert.equal(result.state, "already_in_state", action);
    assert.equal(result.changed, false);
    assert.equal(result.command_id, null);
    assert.equal(calls.length, 0, `${action} must not dispatch`);
  }
});

test("settle, unsettle and settle again use distinct command IDs; same-state retries reuse one", async () => {
  const f = fixture();
  const first = await f.client.settleThread("thread", "project", { waitMs: 0 });
  const back = await f.client.unsettleThread("thread", "project", { waitMs: 0 });
  assert.equal(back.settled, false);
  assert.equal(f.calls[1].type, "thread.unsettle");
  assert.equal(f.calls[1].reason, "user");
  const again = await f.client.settleThread("thread", "project", { waitMs: 0 });
  assert.equal(again.state, "applied");
  assert.equal(new Set([first.command_id, back.command_id, again.command_id]).size, 3);

  const lost = fixture({ dispatch: () => { throw new Error("socket closed"); } });
  const a = await lost.client.settleThread("thread", "project", { waitMs: 0 });
  const b = await lost.client.settleThread("thread", "project", { waitMs: 0 });
  assert.equal(a.state, "outcome_unknown");
  assert.equal(a.changed, false);
  assert.match(a.warning, /Read the thread again/);
  assert.equal(a.command_id, b.command_id, "T3 deduplicates a retry from the same observed state");
});

test("archive moves the thread to the archived list and unarchive restores it", async () => {
  const f = fixture({ thread: { settledOverride: "settled", settledAt: "2026-10-27T00:00:00Z" } });
  const archived = await f.client.archiveThread("thread", "project", { waitMs: 0 });
  assert.equal(archived.state, "applied");
  assert.equal(archived.archived, true);
  assert.equal(archived.settled, true);
  assert.equal(f.calls[0].type, "thread.archive");
  assert.ok(archived.effects.some((effect) => /terminals/.test(effect)));
  const read = await f.client.getThread("thread", 1);
  assert.equal(read.archived, true, "get_thread reads archived threads");
  assert.equal(read.settled, true);
  const found = await f.client.findThread("shopping", 5, false, true);
  assert.equal(found.threads[0].archived, true);
  assert.equal((await f.client.findThread("shopping", 5)).threads.length, 0, "archived threads stay hidden by default");
  assert.equal((await f.client.settleThread("thread", "project", { waitMs: 0 })).state, "already_in_state");
  await assert.rejects(f.client.unsettleThread("thread", "project", { waitMs: 0 }), /archived\. Use unarchive_thread.*No change was made/);
  const unsettledArchive = fixture({ thread: { archivedAt: "2026-10-27T00:00:00Z" } });
  await assert.rejects(unsettledArchive.client.settleThread("thread", "project", { waitMs: 0 }), /archived\. Use unarchive_thread before settling/);
  assert.equal(unsettledArchive.calls.length, 0);
  const restored = await f.client.unarchiveThread("thread", "project", { waitMs: 0 });
  assert.equal(restored.state, "applied");
  assert.equal(restored.archived, false);
  assert.equal(restored.settled, true, "Unarchive keeps Settled");
  assert.equal(f.calls.at(-1).type, "thread.unarchive");
  assert.equal(f.calls.length, 2);
});

test("exact targeting rejects foreign, unknown and malformed IDs before dispatch", async () => {
  const f = fixture();
  await assert.rejects(f.client.settleThread("other-thread", "project"), /does not belong to project_id/);
  await assert.rejects(f.client.archiveThread("thread", "other-project"), /does not belong to project_id/);
  await assert.rejects(f.client.settleThread("thread", "missing"), /Project was not found/);
  await assert.rejects(f.client.settleThread("missing", "project"), /Thread was not found/);
  await assert.rejects(f.client.settleThread(" thread", "project"), /exact nonempty ID/);
  await assert.rejects(f.client.settleThread("thread", "project", { waitMs: 10001 }), /Invalid/);
  await assert.rejects(f.client.settleThread("thread", "project", { cancelPendingInput: "yes" }), /Invalid/);
  const deleted = fixture({ thread: { deletedAt: "2026-10-27T00:00:00Z" } });
  await assert.rejects(deleted.client.archiveThread("thread", "project"), /Thread was not found/);
  const child = fixture({ thread: { lineage: { parentThreadId: "parent", relationshipToParent: "subagent" } } });
  await assert.rejects(child.client.settleThread("thread", "project"), /subagent.*parent/);
  assert.deepEqual([...f.calls, ...deleted.calls, ...child.calls], []);
});

test("settle and archive refuse running, blocked and queued threads before dispatch", async () => {
  const cases = [
    [{ runs: [{ id: "run-1", status: "running" }] }, "settleThread", /still running.*stop_thread/],
    [{ runs: [{ id: "run-1", status: "waiting" }] }, "archiveThread", /still running/],
    [{ requests: [{ id: "approval", status: "pending", kind: "command", responseCapability: { type: "live" } }] }, "settleThread", /approval or question/],
    [{ requests: [{ id: "approval", status: "pending", kind: "command", responseCapability: { type: "live" } }] }, "archiveThread", /approval or question/],
    [{ runs: [{ id: "run-2", status: "queued", userMessageId: "message" }], messages: [{ id: "message" }] }, "settleThread", /queued message/],
    [{ runs: [{ id: "run-2", status: "queued", userMessageId: "message" }] }, "archiveThread", /queued run/],
    [{ requests: [{ id: "question", status: "pending", kind: "user_input", responseCapability: { type: "message" } }] }, "settleThread", /cancel_pending_input/],
    [{ thread: { pendingBackgroundTasks: [{ kind: "monitor" }] } }, "settleThread", /stop_background_work/],
    [{ thread: { pendingBackgroundTasks: [{ kind: "agent" }] } }, "archiveThread", /stop_background_work/],
  ];
  for (const [setup, action, message] of cases) {
    const f = fixture(setup);
    await assert.rejects(f.client[action]("thread", "project", { waitMs: 0 }), (error) =>
      message.test(error.message) && /No change was made/.test(error.message) && error.status === 409);
    assert.equal(f.calls.length, 0, `${action} must not dispatch: ${message}`);
  }
});

test("explicit opt-ins allow T3 to cancel questions, notification runs and background work", async () => {
  const f = fixture({
    thread: { pendingBackgroundTasks: [{ kind: "monitor" }] },
    requests: [{ id: "question", status: "pending", kind: "user_input", responseCapability: { type: "message" } }],
    runs: [{ id: "run-2", status: "queued", userMessageId: "notice" }],
    messages: [{ id: "notice", notification: { kind: "completion" } }],
  });
  const result = await f.client.settleThread("thread", "project", { waitMs: 0, cancelPendingInput: true, stopBackgroundWork: true });
  assert.equal(result.state, "applied");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.detailQueries, [""], "Preconditions read every run and request");
  assert.ok(result.effects.some((effect) => /unanswered question\(s\): question\./.test(effect)));
  assert.ok(result.effects.some((effect) => /notification/.test(effect)));
  assert.ok(result.effects.some((effect) => /background/.test(effect)));
});

test("a T3 rejection is reported with its reason and is not treated as uncertain", async () => {
  const f = fixture({ dispatch: () => { throw new T3CommandRejected("orchestration.dispatchCommand", "Thread thread is still running. Stop it before settling."); } });
  await assert.rejects(f.client.settleThread("thread", "project", { waitMs: 0 }), (error) =>
    /T3 rejected .*still running.*No change was made/.test(error.message) && error.status === 409);
});

test("accepted commands stay requested until the new state is observed", async () => {
  const slow = fixture({ applyDelayReads: 1000 });
  const pending = await slow.client.archiveThread("thread", "project", { waitMs: 0 });
  assert.equal(pending.state, "requested");
  assert.equal(pending.changed, false);
  assert.equal(pending.archived, false);
  const delayed = fixture({ applyDelayReads: 2 });
  const observed = await delayed.client.archiveThread("thread", "project", { waitMs: 2000 });
  assert.equal(observed.state, "applied");
});

test("only tagged T3 dispatch errors become bounded rejection text", () => {
  assert.equal(rejectionDetail({ _tag: "OrchestrationV2DispatchCommandError", message: "Failed", detail: "Thread x is not archived.\n" }), "Thread x is not archived.");
  assert.equal(rejectionDetail({ _tag: "OrchestrationV2DispatchCommandError", message: "m".repeat(400) }).length, 300);
  assert.equal(rejectionDetail({ _tag: "TimeoutError", message: "timed out" }), null);
  assert.equal(rejectionDetail(new Error("socket token=abc")), null);
  assert.equal(rejectionDetail(undefined), null);
});
