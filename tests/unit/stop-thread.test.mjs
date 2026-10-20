import assert from "node:assert/strict";
import { test } from "node:test";
import { T3Client } from "../../src/t3/client.mjs";
import { tokenFile } from "../helpers/t3-fixture.mjs";

function fixture({ status = "running", pending = null, effect, fetchEffect, extraRuns = [] } = {}) {
  const calls = [];
  const run = { id: "run-1", status };
  const thread = { id: "thread", projectId: "project", status, latestRunId: "run-1",
    activeRunId: ["running", "waiting", "preparing", "starting"].includes(status) ? run.id : null,
    pendingRuntimeRequest: pending ? { id: "request", kind: pending.kind } : null,
    pendingBackgroundTasks: [], updatedAt: "2026-10-19T00:00:00Z" };
  const shell = { schemaVersion: 2, projects: [{ id: "project" }], threads: [thread] };
  const projection = { thread, runs: [run, ...extraRuns], runtimeRequests: pending ? [pending] : [],
    turnItems: pending ? [{ requestId: pending.id, runId: run.id,
      type: pending.kind === "user_input" ? "user_input_request" : "approval_request" }] : [] };
  const settle = () => {
    run.status = "interrupted";
    thread.status = "interrupted";
    thread.activeRunId = null;
    thread.pendingRuntimeRequest = null;
    for (const request of projection.runtimeRequests) request.status = "cancelled";
  };
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", tokenFile,
    fetchImpl: async (url, options) => {
      assert.equal(options.headers["x-t3-orchestration-protocol"], "2");
      assert.equal(options.headers.authorization, "Bearer test-token");
      if (fetchEffect) await fetchEffect({ url, calls, shell, projection, run });
      if (url.pathname === "/api/orchestration/shell") return Response.json(shell);
      if (url.pathname === "/api/orchestration/threads/thread") {
        assert.equal(url.search, "", "Stop must inspect all runs and requests");
        return Response.json({ projection });
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    },
    rpcImpl: async (_connection, method, command) => {
      assert.equal(method, "orchestration.dispatchCommand");
      calls.push(command);
      if (effect) await effect({ command, run, thread, projection, calls, settle });
      return { sequence: 42 };
    },
  });
  const stop = (options = {}) => client.stopThread("thread", "project", "run-1", { waitMs: 0, ...options });
  return { client, calls, run, thread, shell, projection, stop, settle };
}

for (const status of ["preparing", "starting", "running", "waiting"]) {
  for (const kind of ["user_input", "command"]) {
    test(`stop bypasses prompt gate for ${status} with pending ${kind}`, async () => {
      const { client, stop, calls } = fixture({ status,
        pending: { id: "request", status: "pending", kind, responseCapability: { type: "live" } },
        effect: ({ settle }) => settle(),
      });
      await assert.rejects(client.sendFollowup("thread", "STOP"), /pending approval or input/);
      const result = await stop();
      assert.equal(result.state, "confirmed_stopped");
      assert.equal(result.thread_stopped, true);
      assert.equal(result.run_status, "interrupted");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].type, "run.interrupt");
      assert.equal(calls[0].threadId, "thread");
      assert.equal(calls[0].runId, "run-1");
      assert.equal(calls[0].holdQueue, true);
      assert.equal(calls[0].decision, undefined);
      assert.equal(calls[0].answers, undefined);
    });
  }
}

test("accepted interruption remains requested until terminal state is observed", async () => {
  const result = await fixture().stop();
  assert.equal(result.state, "cancellation_requested");
  assert.equal(result.cancellation_requested, true);
  assert.equal(result.thread_stopped, false);
});

test("bounded waiting observes delayed completion", async () => {
  const f = fixture({ fetchEffect: ({ calls, run, shell }) => {
    if (calls.length) {
      run.status = "completed";
      shell.threads[0].status = "completed";
      shell.threads[0].activeRunId = null;
    }
  } });
  assert.equal((await f.stop({ waitMs: 100 })).state, "confirmed_stopped");
});

test("queued cancellation changes only the exact queued run", async () => {
  const f = fixture({ status: "queued", effect: ({ command, run, thread }) => {
    assert.equal(command.type, "queued-run.cancel");
    run.status = "cancelled";
    thread.status = "cancelled";
  } });
  assert.equal((await f.stop()).state, "confirmed_stopped");
  assert.equal(f.calls.length, 1);
});

test("queue promotion race interrupts the same run without selecting a newer run", async () => {
  const f = fixture({ status: "queued", effect: ({ command, run, thread, settle }) => {
    if (command.type === "queued-run.cancel") {
      run.status = "running";
      thread.status = "running";
      thread.activeRunId = run.id;
      throw new Error("No longer queued");
    }
    settle();
  } });
  const result = await f.stop();
  assert.equal(result.thread_stopped, true);
  assert.deepEqual(f.calls.map((c) => [c.type, c.runId]), [["queued-run.cancel", "run-1"], ["run.interrupt", "run-1"]]);
});

for (const status of ["completed", "failed", "cancelled", "interrupted", "rolled_back"]) {
  test(`terminal ${status} is a no-op even when a newer run is active`, async () => {
    const f = fixture({ status, extraRuns: [{ id: "new-run", status: "running" }] });
    f.thread.activeRunId = "new-run";
    f.thread.status = "running";
    assert.equal((await f.stop()).state, "already_terminal");
    assert.equal((await f.stop()).thread_stopped, false);
    assert.deepEqual(f.calls, []);
  });
}

test("idle thread accepts null without starting or interrupting work", async () => {
  const f = fixture({ status: "idle" });
  f.projection.runs = [];
  const result = await f.client.stopThread("thread", "project", null, { waitMs: 0 });
  assert.equal(result.state, "no_active_run");
  assert.equal(result.thread_stopped, true);
  assert.deepEqual(f.calls, []);
});

test("null cannot select an existing run", async () => {
  const f = fixture();
  await assert.rejects(f.client.stopThread("thread", "project", null), /exact run_id/);
  assert.deepEqual(f.calls, []);
});

test("wrong project, unknown thread, foreign run and unowned thread cannot dispatch", async () => {
  const f = fixture();
  await assert.rejects(f.client.stopThread("thread", "other-project", "run-1"), /does not belong/);
  await assert.rejects(f.client.stopThread("missing", "project", "run-1"), /not found/);
  await assert.rejects(f.client.stopThread("thread", "project", "foreign-run"), /Run was not found/);
  f.shell.projects = [];
  await assert.rejects(f.stop(), /not found/);
  assert.deepEqual(f.calls, []);
});

test("malformed projection or legacy backend fails closed", async () => {
  const f = fixture();
  f.shell.schemaVersion = 1;
  await assert.rejects(f.stop(), /protocol 2/);
  f.shell.schemaVersion = 2;
  f.projection.thread = { id: "different-thread", projectId: "project" };
  await assert.rejects(f.stop(), /unexpected stop projection/);
  assert.deepEqual(f.calls, []);
});

test("repeat and concurrent requests derive the same durable command ID", async () => {
  const f = fixture();
  await Promise.all([f.stop(), f.stop()]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].commandId, f.calls[1].commandId);
  const laterClient = fixture();
  await laterClient.stop();
  assert.equal(laterClient.calls[0].commandId, f.calls[0].commandId);
  f.settle();
  await f.stop();
  assert.equal(f.calls.length, 2, "A retry after terminalization must not dispatch");
});

test("lost acknowledgement with no terminal evidence reports unknown without leaking errors", async () => {
  const f = fixture({ effect: () => { throw new Error("SECRET in auth bearer or provider error"); } });
  const result = await f.stop();
  assert.equal(result.state, "outcome_unknown");
  assert.equal(result.thread_stopped, false);
  assert.equal(result.cancellation_requested, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("lost acknowledgement can still observe terminal state", async () => {
  const f = fixture({ effect: ({ settle }) => { settle(); throw new Error("Reply lost"); } });
  const result = await f.stop();
  assert.equal(result.state, "confirmed_stopped");
  assert.equal(result.verification, "observed");
});

test("read failure after dispatch cannot claim confirmed cancellation", async () => {
  const f = fixture({ fetchEffect: ({ calls }) => { if (calls.length) throw new Error("SECRET"); } });
  const result = await f.stop();
  assert.equal(result.state, "outcome_unknown");
  assert.equal(result.verification, "unavailable");
  assert.equal(result.thread_stopped, false);
});

test("asynchronous input dismissal is exact and never submits an answer", async () => {
  const f = fixture({ status: "completed", pending: { id: "request", kind: "user_input", status: "pending", responseCapability: { type: "message" } },
    effect: ({ command, settle }) => {
      assert.equal(command.type, "thread.user-input.dismiss");
      assert.equal(command.requestId, "request");
      assert.equal(command.answers, undefined);
      settle();
    },
  });
  assert.equal((await f.stop()).state, "confirmed_stopped");
  assert.equal(f.calls.length, 1);
});

test("native interrupt leaving an approval pending cancels it only after the run is terminal", async () => {
  const f = fixture({ pending: { id: "request", kind: "command", status: "pending", responseCapability: { type: "live" } },
    effect: ({ command, run, thread, projection }) => {
      if (command.type === "run.interrupt") {
        run.status = "interrupted";
        thread.status = "interrupted";
        thread.activeRunId = null;
      } else {
        assert.equal(run.status, "interrupted");
        assert.equal(command.type, "runtime-request.respond");
        assert.equal(command.requestId, "request");
        assert.equal(command.decision, "cancel");
        assert.equal(command.answers, undefined);
        assert.equal(command.runId, undefined);
        projection.runtimeRequests[0].status = "resolved";
        thread.pendingRuntimeRequest = null;
      }
    },
  });
  const result = await f.stop();
  assert.equal(result.thread_stopped, true);
  assert.equal(f.calls.length, 2);
});

test("approval cleanup never runs while the selected run is still active", async () => {
  const f = fixture({ pending: { id: "request", kind: "command", status: "pending", responseCapability: { type: "live" } } });
  const result = await f.stop();
  assert.equal(result.thread_stopped, false);
  assert.deepEqual(f.calls.map((command) => command.type), ["run.interrupt"]);
});

test("approval cleanup respects opt-out, ownership and non-resumable requests", async () => {
  const f = fixture({ status: "interrupted", pending: { id: "request", kind: "command", status: "pending", responseCapability: { type: "live" } } });
  assert.equal((await f.stop({ cancelPendingApprovals: false })).thread_stopped, false);
  f.projection.turnItems[0].runId = "different-run";
  assert.equal((await f.stop()).thread_stopped, false);
  f.projection.turnItems[0].runId = "run-1";
  f.projection.runtimeRequests[0].responseCapability.type = "not_resumable";
  assert.equal((await f.stop()).thread_stopped, false);
  assert.deepEqual(f.calls, []);
});

test("terminalization winning the race never interrupts a newer run", async () => {
  const f = fixture({ effect: ({ settle, projection, thread }) => {
    settle();
    projection.runs.push({ id: "newer", status: "running" });
    thread.activeRunId = "newer";
    thread.status = "running";
    throw new Error("Target run already finished");
  } });
  const result = await f.stop();
  assert.equal(result.thread_stopped, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].runId, "run-1");
});

test("input dismissal can be disabled and never dismisses another run's question", async () => {
  const f = fixture({ status: "completed", pending: { id: "request", kind: "user_input", status: "pending", responseCapability: { type: "message" } } });
  assert.equal((await f.stop({ dismissPendingInput: false })).thread_stopped, false);
  f.projection.turnItems[0].runId = "other-run";
  assert.equal((await f.stop()).thread_stopped, false);
  assert.deepEqual(f.calls, []);
});

for (const obstacle of ["request", "background", "unheld-queue", "new-run"]) {
  test(`a terminal target with remaining ${obstacle} does not confirm thread stopped`, async () => {
    const f = fixture({ effect: ({ settle, projection, thread }) => {
      settle();
      if (obstacle === "request") projection.runtimeRequests.push({ id: "still-pending", status: "pending" });
      if (obstacle === "background") thread.pendingBackgroundTasks.push({ kind: "monitor" });
      if (obstacle === "unheld-queue") projection.runs.push({ id: "queued", status: "queued", queueHeld: false });
      if (obstacle === "new-run") projection.runs.push({ id: "new", status: "running" });
    } });
    const result = await f.stop();
    assert.equal(result.thread_stopped, false);
    assert.equal(f.calls.length, 1);
  });
}

test("held queued work is retained and reported", async () => {
  const f = fixture({ extraRuns: [{ id: "queued", status: "queued", queueHeld: true }], effect: ({ settle }) => settle() });
  const result = await f.stop();
  assert.equal(result.thread_stopped, true);
  assert.deepEqual(result.held_queued_run_ids, ["queued"]);
  assert.equal(f.calls.length, 1);
});

test("new work appearing while the projection is read prevents stopped confirmation", async () => {
  let shellReads = 0;
  const f = fixture({ status: "completed", fetchEffect: ({ url, shell }) => {
    if (url.pathname === "/api/orchestration/shell" && ++shellReads === 2) {
      shell.threads[0].activeRunId = "new-run";
      shell.threads[0].status = "running";
    }
  } });
  const result = await f.stop();
  assert.equal(result.run_status, "completed");
  assert.equal(result.thread_stopped, false);
  assert.deepEqual(f.calls, []);
});

test("invalid stop arguments cannot reach the backend", async () => {
  const f = fixture();
  for (const runId of [undefined, "", " run-1", "run-1 "]) {
    await assert.rejects(f.client.stopThread("thread", "project", runId), /run_id/);
  }
  for (const waitMs of [-1, 10001, NaN, 1.5]) await assert.rejects(f.stop({ waitMs }), /Invalid stop options/);
  assert.deepEqual(f.calls, []);
});
