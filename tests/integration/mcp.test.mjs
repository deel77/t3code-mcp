import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { T3Client } from "../../src/t3/client.mjs";
import { fakeClient, tokenFile } from "../helpers/t3-fixture.mjs";

import { createHttpServer } from "../../src/http/server.mjs";

test("MCP start_thread uses T3Code's bootstrap dispatch instead of the HTTP engine dispatch", async () => {
  const projectId = randomUUID();
  const dispatched = [];
  const client = new T3Client({
    baseUrl: "http://127.0.0.1:3773", tokenFile,
    fetchImpl: async (url) => {
      if (url.pathname === "/api/orchestration/shell") return Response.json({
        projects: [{ id: projectId, title: "Example project", defaultModelSelection: { instanceId: "provider-example", model: "model-example" } }],
        threads: [],
      });
      if (url.pathname === "/api/orchestration/dispatch") return Response.json({
        error: "Thread does not exist for command thread.turn.start",
      }, { status: 500 });
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
    rpcImpl: async (_connection, method, command) => {
      assert.equal(method, "orchestration.dispatchCommand");
      dispatched.push(command);
      return { sequence: 1 };
    },
  });
  const server = createHttpServer({ client, verifyAccess: async () => true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start_thread", arguments: {
        project_id: projectId, title: "Compare two revisions", prompt: "Compare two revisions",
      } } }),
    });
    const body = await response.json();
    assert.equal(body.result?.isError, undefined, JSON.stringify(body.result?.content));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].bootstrap.createThread.projectId, projectId);
    assert.equal(dispatched[0].runtimeMode, "full-access");
    const explicit = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start_thread", arguments: {
        project_id: projectId, title: "Review", prompt: "Review", runtime_mode: "approval-required",
      } } }),
    });
    const explicitBody = await explicit.json();
    assert.equal(explicitBody.result?.isError, undefined, JSON.stringify(explicitBody.result?.content));
    assert.equal(dispatched[1].runtimeMode, "approval-required");
    assert.equal(dispatched[1].bootstrap.createThread.runtimeMode, "approval-required");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP exposes a pending command approval and accepts a decision for its request ID", async () => {
  const projectId = randomUUID();
  const threadId = randomUUID();
  const requestId = randomUUID();
  const commands = [];
  const activities = [{ id: "approval-1", kind: "approval.requested", summary: "Command approval requested",
    turnId: "turn-1", createdAt: "2025-01-02T10:00:00Z", payload: { requestId,
      requestKind: "command", requestType: "command_execution_approval", detail: "pwd",
      options: [{ decision: "accept", label: "Allow once" }, { decision: "decline", label: "Deny" }] } }];
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", tokenFile,
    fetchImpl: async (url, options) => {
      if (url.pathname === "/api/orchestration/shell") return Response.json({
        projects: [{ id: projectId, title: "Example project", workspaceRoot: "/workspace/example" }],
        threads: [{ id: threadId, projectId, title: "Check directory", updatedAt: "2025-01-02T10:00:00Z",
          runtimeMode: "approval-required", hasPendingApprovals: commands.length === 0 }],
      });
      if (url.pathname === `/api/orchestration/threads/${threadId}`) return Response.json({
        thread: { messages: [], activities: url.searchParams.has("turnLimit") ? [] : commands.length ? [...activities, {
          kind: "approval.resolved", createdAt: "2025-01-02T10:00:01Z", payload: { requestId, decision: "accept" },
        }] : activities, branch: "main", worktreePath: "/workspace/example", session: { lastError: null } },
        page: { hasMore: false }, snapshotSequence: 1,
      });
      if (url.pathname === "/api/orchestration/dispatch") {
        commands.push(JSON.parse(options.body));
        return Response.json({ sequence: 2 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  });
  const server = createHttpServer({ client, verifyAccess: async () => true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await response.json()).result;
  };
  try {
    const detail = await call("get_thread", { thread_id: threadId });
    assert.deepEqual(detail.structuredContent.pending_approvals.map((item) => ({
      request_id: item.request_id, request_kind: item.request_kind, request_type: item.request_type,
      action: item.action, project_id: item.context.project_id,
      project_workspace_root: item.context.project_workspace_root, worktree_path: item.context.worktree_path,
    })), [{ request_id: requestId, request_kind: "command", request_type: "command_execution_approval",
      action: "pwd", project_id: projectId, project_workspace_root: "/workspace/example",
      worktree_path: "/workspace/example" }]);
    const attention = await call("list_attention", { limit: 3 });
    assert.equal(attention.structuredContent.threads[0].pending_approvals[0].request_id, requestId);
    const answer = await call("respond_thread_approval", { thread_id: threadId, request_id: requestId, decision: "accept" });
    assert.equal(answer.structuredContent.decision, "accept");
    assert.deepEqual(commands.map((command) => ({ type: command.type, requestId: command.requestId, decision: command.decision })),
      [{ type: "thread.approval.respond", requestId, decision: "accept" }]);
    const after = await call("get_thread", { thread_id: threadId });
    assert.deepEqual(after.structuredContent.pending_approvals, []);
    const repeated = await call("respond_thread_approval", { thread_id: threadId, request_id: requestId, decision: "accept" });
    assert.equal(repeated.isError, true);
    assert.match(repeated.content[0].text, /no longer pending/);
    assert.equal(commands.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP can deny an approval and rejects decisions the provider did not offer", async () => {
  const projectId = randomUUID();
  const threadId = randomUUID();
  const requestId = randomUUID();
  const commands = [];
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", tokenFile,
    fetchImpl: async (url, options) => {
      if (url.pathname === "/api/orchestration/shell") return Response.json({
        projects: [{ id: projectId }], threads: [{ id: threadId, projectId, hasPendingApprovals: true }],
      });
      if (url.pathname === `/api/orchestration/threads/${threadId}`) return Response.json({
        thread: { activities: [{ kind: "approval.requested", createdAt: "2025-01-02T10:00:00Z",
          payload: { requestId, detail: "delete a file", options: [{ decision: "decline", label: "Deny" }] } }] },
      });
      if (url.pathname === "/api/orchestration/dispatch") {
        commands.push(JSON.parse(options.body));
        return Response.json({ sequence: 2 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  });
  const server = createHttpServer({ client, verifyAccess: async () => true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const call = async (decision) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "respond_thread_approval",
        arguments: { thread_id: threadId, request_id: requestId, decision } } }),
    });
    return (await response.json()).result;
  };
  try {
    const unavailable = await call("accept");
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0].text, /unavailable/);
    assert.equal(commands.length, 0);
    const denied = await call("decline");
    assert.equal(denied.structuredContent.decision, "decline");
    assert.equal(commands[0].decision, "decline");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP MCP requires access verification before listing tools", async () => {
  const { client } = fakeClient();
  const server = createHttpServer({ client, verifyAccess: async (request) => request.headers["cf-access-jwt-assertion"] === "valid-test" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const blocked = await fetch(url, { method: "POST", headers, body });
    assert.equal(blocked.status, 403);
    const allowed = await fetch(url, { method: "POST", headers: { ...headers, "cf-access-jwt-assertion": "valid-test" }, body });
    assert.equal(allowed.status, 200);
    const data = await allowed.json();
    assert.deepEqual(data.result.tools.map((tool) => tool.name), ["list_projects", "list_threads", "list_recent_threads", "list_attention", "find_thread", "get_thread", "get_thread_updates", "get_thread_changes", "list_model_options", "answer_thread_input", "respond_thread_approval", "start_thread", "send_followup"]);
    const recent = await fetch(url, {
      method: "POST",
      headers: { ...headers, "cf-access-jwt-assertion": "valid-test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_recent_threads", arguments: { limit: 1 } } }),
    });
    assert.equal(recent.status, 200);
    const recentData = await recent.json();
    assert.equal(recentData.result.structuredContent.threads.length, 1);
    assert.equal(recentData.result.structuredContent.threads[0].project_title, "My project");
    assert.equal(Object.hasOwn(recentData.result.structuredContent.threads[0], "current_turn_model"), false);
    assert.equal(recentData.result.structuredContent.threads[0].next_turn_model.source, "thread_configuration");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP answer_thread_input forwards an answer payload", async () => {
  const calls = [];
  const server = createHttpServer({
    client: { answerThreadInput: async (...args) => { calls.push(args); return { state: "answer submitted" }; } },
    verifyAccess: async () => true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "answer_thread_input", arguments: { thread_id: "thread-1", request_id: "request-1", answers: { database: "sqlite" } } } }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result.structuredContent.state, "answer submitted");
    assert.deepEqual(calls, [["thread-1", "request-1", { database: "sqlite" }]]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
