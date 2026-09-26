import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { T3Client } from "../../src/t3/client.mjs";
import { BridgeError } from "../../src/errors.mjs";
import { fakeClient, tokenFile } from "../helpers/t3-fixture.mjs";

test("all account projects are listed and a new thread defaults to full access", async () => {
  const { client, calls, projectId } = fakeClient();
  const result = await client.listProjects();
  assert.equal(result.projects[0].new_thread_model.model, "model-example");
  const started = await client.startThread(projectId, "Inspect the repository", "Review");
  assert.equal(started.project_id, projectId);
  const command = calls.at(-1).body;
  assert.equal(command.type, "thread.turn.start");
  assert.equal(command.runtimeMode, "full-access");
  assert.equal(command.bootstrap.createThread.runtimeMode, "full-access");
  assert.deepEqual(command.modelSelection, { instanceId: "provider-example", model: "model-example" });
});

test("unknown projects cannot start work", async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(client.startThread(randomUUID(), "Work"), BridgeError);
  assert.equal(calls.filter((call) => call.path === "/api/orchestration/dispatch").length, 0);
});

test("recent threads are sorted across owned projects without a project ID", async () => {
  const firstProject = randomUUID();
  const secondProject = randomUUID();
  const shell = {
    projects: [{ id: firstProject, title: "Home" }, { id: secondProject, title: "Work" }],
    threads: [
      { id: "older", projectId: firstProject, title: "Older", updatedAt: "2025-01-01T10:00:00Z", hasPendingUserInput: false },
      { id: "newest", projectId: secondProject, title: "Newest", updatedAt: "2025-01-02T10:00:00Z", hasPendingUserInput: true },
      { id: "middle", projectId: firstProject, title: "Middle", updatedAt: "2025-01-02T08:00:00Z" },
      { id: "archived", projectId: secondProject, title: "Archived", updatedAt: "2025-01-02T11:00:00Z", archivedAt: "2025-01-02T11:00:00Z" },
      { id: "unowned", projectId: randomUUID(), title: "Unowned", updatedAt: "2025-01-02T12:00:00Z" },
    ],
  };
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", tokenFile, fetchImpl: async () => Response.json(shell) });
  const result = await client.listRecentThreads(2);
  assert.deepEqual(result.threads.map((thread) => [thread.id, thread.project_title]), [["newest", "Work"], ["middle", "Home"]]);
  assert.equal(result.threads[0].needs_user_input, true);
  assert.equal(result.threads[0].updated_at, "2025-01-02T10:00:00Z");
});

test("pending input is readable with latest messages and can be answered", async () => {
  const projectId = randomUUID();
  const threadId = randomUUID();
  const requestId = "request-1";
  const dispatched = [];
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773",
    tokenFile,
    fetchImpl: async (url, options) => {
      if (url.pathname === "/api/orchestration/shell") return Response.json({
        projects: [{ id: projectId, title: "My project", defaultModelSelection: null }],
        threads: [{ id: threadId, projectId, title: "Work", updatedAt: "2025-01-02T00:00:00Z", modelSelection: { instanceId: "provider-example", model: "model-example" }, latestTurn: { state: "running" }, hasPendingUserInput: true, hasPendingApprovals: false, session: { status: "running" } }],
      });
      if (url.pathname === `/api/orchestration/threads/${threadId}`) return Response.json({
        thread: {
          messages: [
            { id: "m1", role: "user", text: "Build it", createdAt: "2025-01-02T00:00:00Z" },
            { id: "m2", role: "assistant", text: "Which database?", createdAt: "2025-01-02T00:01:00Z" },
          ],
          activities: [{ id: "a1", kind: "user-input.requested", createdAt: "2025-01-02T00:01:01Z", payload: { requestId, questions: [{ id: "database", header: "Database", question: "Which database?", options: [{ label: "SQLite", description: "Local", value: "sqlite" }], allowCustomAnswer: false, multiSelect: false }] } }],
          session: { lastError: null },
        },
        page: { hasMore: false },
      });
      if (url.pathname === "/api/orchestration/dispatch") {
        dispatched.push(JSON.parse(options.body));
        return Response.json({ sequence: 42 });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  const detail = await client.getThread(threadId, 10);
  assert.equal(detail.messages.at(-1).text, "Which database?");
  assert.equal(detail.pending_user_inputs[0].request_id, requestId);
  assert.equal(detail.pending_user_inputs[0].questions[0].options[0].value, "sqlite");
  await client.answerThreadInput(threadId, requestId, { database: "sqlite" });
  assert.equal(dispatched[0].type, "thread.user-input.respond");
  assert.deepEqual(dispatched[0].answers, { database: "sqlite" });
});

test("start and follow-up commands preserve explicit model selection without changing the next turn silently", async () => {
  const projectId = randomUUID();
  const threadId = randomUUID();
  const commands = [];
  const base = { instanceId: "provider-example", model: "model-example" };
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773", tokenFile,
    rpcImpl: async (_connection, method, input) => {
      if (method === "orchestration.dispatchCommand") {
        commands.push(input);
        return { sequence: commands.length };
      }
      assert.equal(method, "server.getConfig");
      return { providers: [{ instanceId: "provider-example", driver: "codex", enabled: true, installed: true,
        models: [{ slug: "model-example", capabilities: { optionDescriptors: [{ id: "reasoningEffort",
          options: [{ id: "high" }] }] } }] }] };
    },
    fetchImpl: async (url, options) => {
      if (url.pathname === "/api/orchestration/shell") return Response.json({
        projects: [{ id: projectId, title: "Home", defaultModelSelection: base }],
        threads: [{ id: threadId, projectId, title: "Work", updatedAt: "2025-01-02T00:00:00Z",
          modelSelection: base, runtimeMode: "approval-required", hasPendingApprovals: false,
          hasPendingUserInput: false }],
      });
      if (url.pathname === "/api/orchestration/dispatch") {
        commands.push(JSON.parse(options.body));
        return Response.json({ sequence: commands.length });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const override = { provider_instance_id: "provider-example", model: "model-example", reasoning_level: "high" };
  await client.startThread(projectId, "Build it", undefined, override);
  assert.deepEqual(commands[0].modelSelection, { instanceId: "provider-example", model: "model-example",
    options: [{ id: "reasoningEffort", value: "high" }] });
  assert.deepEqual(commands[0].bootstrap.createThread.modelSelection, commands[0].modelSelection);
  await client.sendFollowup(threadId, "Continue");
  assert.equal(Object.hasOwn(commands[1], "modelSelection"), false);
  await assert.rejects(client.sendFollowup(threadId, "Continue", { model: "nonexistent" }), /unavailable/);
  assert.equal(commands.length, 2);
});

test("get_thread reads recent messages and finds a pending question outside its turn window", async () => {
  const projectId = randomUUID();
  const threadId = randomUUID();
  const seenLimits = [];
  const activities = [{ kind: "user-input.requested", createdAt: "2025-01-02T00:00:01Z", payload: { requestId: "older-request", questions: [{ id: "target", question: "Which target?", options: [], allowCustomAnswer: true }] } }];
  const messages = Array.from({ length: 8 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" : "user", text: `Message ${index}`, createdAt: "2025-01-02T00:00:00Z" }));
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773", tokenFile,
    fetchImpl: async (url) => {
      if (url.pathname === "/api/orchestration/shell") return Response.json({ projects: [{ id: projectId }], threads: [{ id: threadId, projectId, updatedAt: "2025-01-02T00:00:00Z", hasPendingUserInput: true }] });
      if (url.pathname === `/api/orchestration/threads/${threadId}`) {
        seenLimits.push(url.searchParams.get("turnLimit"));
        return Response.json({ thread: { messages, activities: url.search ? [] : activities }, page: { hasMore: false } });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  const result = await client.getThread(threadId, 3);
  assert.equal(Object.hasOwn(result, "current_turn_model"), false);
  assert.deepEqual(result.messages.map((message) => message.text), ["Message 5", "Message 6", "Message 7"]);
  assert.equal(result.pending_user_inputs[0].request_id, "older-request");
  assert.deepEqual(seenLimits, ["3", null]);
});

test("get_thread_updates returns only messages changed since its cursor and reports a state change", async () => {
  const projectId = randomUUID();
  const threadId = randomUUID();
  let phase = 0;
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773", tokenFile,
    rpcImpl: async (_connection, method) => {
      assert.equal(method, "orchestration.subscribeThread");
      return [{ kind: "event", event: { sequence: 11 } }, { kind: "synchronized" }];
    },
    fetchImpl: async (url) => {
      if (url.pathname === "/api/orchestration/shell") return Response.json({
        projects: [{ id: projectId }],
        threads: [{ id: threadId, projectId, title: "Work", updatedAt: `2025-01-02T00:00:0${phase}Z`,
          modelSelection: { instanceId: "codex", model: "model-example" },
          latestTurn: { turnId: "turn-1", state: phase ? "completed" : "running" },
          session: { status: phase ? "ready" : "running" }, hasPendingApprovals: Boolean(phase) }],
      });
      if (url.pathname === `/api/orchestration/threads/${threadId}`) return Response.json({
        snapshotSequence: phase ? 12 : 10,
        thread: { messages: [
          { id: "m1", role: "user", text: "Start", createdAt: "2025-01-02T00:00:00Z" },
          ...(phase ? [{ id: "m2", role: "assistant", text: "Done", createdAt: "2025-01-02T00:00:01Z" }] : []),
        ], activities: phase ? [{ id: "a1", kind: "approval.requested", summary: "Command approval requested",
          turnId: "turn-1", createdAt: "2025-01-02T00:00:01Z", payload: { requestId: "approval-1",
            requestKind: "command", requestType: "command_execution_approval", detail: "pwd" } }] : [],
        session: { lastError: null } }, page: { hasMore: false },
      });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const baseline = await client.getThread(threadId, 5);
  phase = 1;
  const update = await client.getThreadUpdates(threadId, baseline.updates_cursor, 5);
  assert.deepEqual(update.messages.map((message) => message.id), ["m2"]);
  assert.equal(update.state_changed, true);
  assert.equal(update.resync_required, false);
  assert.equal(update.pending_approvals[0].request_id, "approval-1");
  assert.equal(update.pending_approvals[0].action, "pwd");
  assert.equal(Object.hasOwn(update, "current_turn_model"), false);
  assert.notEqual(update.updates_cursor, baseline.updates_cursor);
});

test("completed turns keep reporting live background work and its later monitoring transition", async () => {
  const projectId = randomUUID();
  const threadId = randomUUID();
  let backgroundLiveness = null;
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773", tokenFile,
    rpcImpl: async (_connection, method) => {
      assert.equal(method, "orchestration.subscribeThread");
      return [{ kind: "synchronized" }];
    },
    fetchImpl: async (url) => {
      if (url.pathname === "/api/orchestration/shell") return Response.json({
        projects: [{ id: projectId, title: "Example" }],
        threads: [{ id: threadId, projectId, title: "Background task", updatedAt: "2025-01-02T00:00:00Z",
          latestTurn: { turnId: "turn-1", state: "completed" }, session: { status: "ready" },
          backgroundLiveness }],
      });
      if (url.pathname === `/api/orchestration/threads/${threadId}`) return Response.json({
        snapshotSequence: 1, thread: { messages: [], activities: [], session: { lastError: null } },
        page: { hasMore: false },
      });
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  });
  const [listed] = (await client.listRecentThreads(1)).threads;
  assert.equal(listed.activity_status, "completed");
  assert.equal(listed.background_liveness, null);
  const baseline = await client.getThread(threadId, 1);

  backgroundLiveness = "working";
  const working = await client.getThreadUpdates(threadId, baseline.updates_cursor, 1);
  assert.equal(working.turn_state, "completed");
  assert.equal(working.background_liveness, "working");
  assert.equal(working.activity_status, "working");
  assert.equal(working.state_changed, true);

  backgroundLiveness = "monitoring";
  const monitoring = await client.getThreadUpdates(threadId, working.updates_cursor, 1);
  assert.equal(monitoring.background_liveness, "monitoring");
  assert.equal(monitoring.activity_status, "monitoring");
  assert.equal(monitoring.state_changed, true);

  backgroundLiveness = null;
  const completed = await client.getThreadUpdates(threadId, monitoring.updates_cursor, 1);
  assert.equal(completed.activity_status, "completed");
  assert.equal(completed.state_changed, true);
});
