import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { BridgeError } from "../errors.mjs";

const modelSelectionSchema = z.object({
  provider: z.string().min(1).optional(),
  provider_instance_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoning_level: z.string().min(1).optional(),
}).strict();
const runtimeModeSchema = z.enum(["full-access", "approval-required", "auto-accept-edits", "auto"]);
const lifecycleTarget = {
  thread_id: z.string().min(1).max(200),
  project_id: z.string().min(1).max(200),
  wait_ms: z.number().int().min(0).max(10000).optional(),
};
const lifecycleOutput = {
  thread_id: z.string(), project_id: z.string(), action: z.enum(["settle", "unsettle", "archive", "unarchive"]),
  state: z.enum(["applied", "already_in_state", "requested", "outcome_unknown"]),
  changed: z.boolean(), command_id: z.string().nullable(), title: z.string(),
  settled: z.boolean(), settled_at: z.string().nullable(), archived: z.boolean(), archived_at: z.string().nullable(),
  thread_status: z.string().nullable(), latest_run_id: z.string().nullable(),
  verification: z.enum(["observed", "unavailable"]), effects: z.array(z.string()), warning: z.string().optional(),
};
const lifecycleResultNote = "Report the change only when state is applied or already_in_state and verification is observed.";

export function createMcpServer(client) {
  const server = new McpServer(
    { name: "t3code-voice", version: packageJson.version },
    { instructions: "For voice check-ins use list_attention, list_recent_threads and get_thread_updates. Use find_thread to locate a title across projects. Get a cursor from get_thread, then pass it to get_thread_updates for new messages and state changes. Use activity_status for overall progress: turn_state can be completed while background_liveness is working or monitoring. next_turn_model is the configured selection for a future turn; T3Code does not expose the actual model or reasoning level of the current turn. Use list_model_options before requesting a model override. Answer questions with answer_thread_input using exact option values. Read pending_approvals before using respond_thread_approval and ask the user to authorize the exact action. To stop work, use stop_thread with the exact project, thread, and run IDs from get_thread. Never send a STOP prompt as cancellation. Retry using the same IDs; report stopped only when thread_stopped is true and verification is observed. Settled is the user's done marker in T3Code: it is separate from a completed run (thread_status) and from archived. Use settle_thread, unsettle_thread, archive_thread and unarchive_thread only when the user asks, with the exact project and thread IDs from get_thread, and report the observed settled and archived fields. Start coding work only when the user asks." },
  );

  const result = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  });
  const handle = (action) => async (args) => {
    try {
      return result(await action(args));
    } catch (error) {
      const message = error instanceof BridgeError ? error.message : "T3Code bridge request failed.";
      process.stderr.write(`t3code-mcp: ${error instanceof BridgeError ? error.status : "internal"}\n`);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };

  server.registerTool("list_projects", {
    title: "List T3Code projects",
    description: "List all accessible T3Code projects with IDs and the selection used for new threads. If a project has no default, its latest thread selection is used.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(() => client.listProjects()));

  server.registerTool("list_threads", {
    title: "List T3Code threads",
    description: "List recent unarchived threads in a project, including activity_status, background_liveness, attention status and configured next-turn model.",
    inputSchema: { project_id: z.string().min(1), limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(({ project_id, limit }) => client.listThreads(project_id, limit)));

  server.registerTool("list_recent_threads", {
    title: "List recently changed T3Code threads",
    description: "Find recently updated unarchived threads across projects, with project names, activity_status, background_liveness and configured next-turn model. No project ID is needed.",
    inputSchema: { limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(({ limit }) => client.listRecentThreads(limit)));

  server.registerTool("list_attention", {
    title: "Threads needing attention",
    description: "List threads across all owned projects that await an input answer or approval, or ended with an error. Includes pending approval request IDs and action details. Inputs have priority, then approvals, then errors.",
    inputSchema: { limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(({ limit }) => client.listAttention(limit)));

  server.registerTool("find_thread", {
    title: "Find a T3Code thread",
    description: "Search thread titles across every owned project without a project ID. Results include activity_status, background_liveness, settled and archived. Optionally also search user and assistant message text. Set include_archived to find archived threads, for example before unarchive_thread.",
    inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(30).optional(), search_messages: z.boolean().optional(), include_archived: z.boolean().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(({ query, limit, search_messages, include_archived }) => client.findThread(query, limit, search_messages, include_archived)));

  server.registerTool("get_thread", {
    title: "Check a T3Code thread",
    description: "Read latest messages, activity_status, background_liveness, settled and archived state, configured next-turn model, unanswered questions, pending approvals, and a cursor for get_thread_updates. Also reads archived threads. Returns project_id, active_run_id, latest_run_id and runs for exact stop_thread targeting. A completed turn may still have live background work. Approval details include request ID, action, type, options, and thread context.",
    inputSchema: { thread_id: z.string().min(1), message_limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(({ thread_id, message_limit }) => client.getThread(thread_id, message_limit)));

  server.registerTool("get_thread_updates", {
    title: "Check new T3Code thread updates",
    description: "Return messages changed since the cursor from get_thread or the prior get_thread_updates, plus activity_status, background_liveness, pending input, and pending approvals. Background work changes count as state_changed. If resync_required is true, call get_thread for full context.",
    inputSchema: { thread_id: z.string().min(1), cursor: z.string().min(1).max(2048), message_limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(({ thread_id, cursor, message_limit }) => client.getThreadUpdates(thread_id, cursor, message_limit)));

  server.registerTool("get_thread_changes", {
    title: "Check code changes in a T3Code thread",
    description: "Return latest checkpoint changed files and line counts. Set include_diff for a bounded turn diff; use from_turn_count to select the starting checkpoint.",
    inputSchema: { thread_id: z.string().min(1), include_diff: z.boolean().optional(), from_turn_count: z.number().int().min(0).optional(), to_turn_count: z.number().int().min(0).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(({ thread_id, include_diff, from_turn_count, to_turn_count }) => client.getThreadChanges(thread_id, {
    includeDiff: include_diff, fromTurnCount: from_turn_count, toTurnCount: to_turn_count,
  })));

  server.registerTool("list_model_options", {
    title: "List available T3Code models",
    description: "Read the live T3Code provider instance, model and reasoning level combinations. Use exact IDs for start_thread and send_followup overrides.",
    inputSchema: { provider_instance_id: z.string().min(1).optional(), query: z.string().min(1).max(100).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, handle(({ provider_instance_id, query, limit }) => client.listModelOptions({ providerInstanceId: provider_instance_id, query, limit })));

  server.registerTool("answer_thread_input", {
    title: "Answer a T3Code input request",
    description: "Answer every pending question from get_thread using its request_id and question IDs. For choices, use the exact option value; for multi-select, provide an array of values. This resumes the thread or starts its next turn.",
    inputSchema: {
      thread_id: z.string().min(1),
      request_id: z.string().min(1),
      answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, handle(({ thread_id, request_id, answers }) => client.answerThreadInput(thread_id, request_id, answers)));

  server.registerTool("respond_thread_approval", {
    title: "Approve or deny a T3Code request",
    description: "Respond to one pending approval from get_thread or list_attention by exact request_id. Read the action and context first. accept allows this request, acceptForSession or acceptAlways grants a wider scope, decline denies it, and cancel cancels it. Only use the decision explicitly authorized by the user.",
    inputSchema: { thread_id: z.string().min(1), request_id: z.string().min(1),
      decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, handle(({ thread_id, request_id, decision }) => client.respondThreadApproval(thread_id, request_id, decision)));

  server.registerTool("start_thread", {
    title: "Start a T3Code coding thread",
    description: "Create and queue a T3Code thread. runtime_mode defaults to full-access; set approval-required to review requested actions. Optional model_selection sets provider instance, model, and reasoning level for the first turn. Coding may change files. Call only when the user asks to start work.",
    inputSchema: {
      project_id: z.string().min(1),
      prompt: z.string().min(1).max(12_000),
      title: z.string().min(1).max(120).optional(),
      model_selection: modelSelectionSchema.optional(),
      runtime_mode: runtimeModeSchema.default("full-access"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, handle(({ project_id, prompt, title, model_selection, runtime_mode }) => client.startThread(project_id, prompt, title, model_selection, runtime_mode)));

  server.registerTool("send_followup", {
    title: "Send a T3Code follow-up",
    description: "Queue another prompt, even while a thread is running. Optional model_selection chooses an exact provider instance, model, and reasoning level for this turn. Use answer_thread_input for pending questions and respond_thread_approval for pending approvals. Coding may change files.",
    inputSchema: { thread_id: z.string().min(1), prompt: z.string().min(1).max(12_000), model_selection: modelSelectionSchema.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, handle(({ thread_id, prompt, model_selection }) => client.sendFollowup(thread_id, prompt, model_selection)));

  server.registerTool("stop_thread", {
    title: "Stop a T3Code thread run",
    description: "Request native cancellation of one exact run, even with pending approval or input. Read get_thread first; verify project_id and select run_id from runs. Use null only for a thread with no runs. Active stops hold the existing queue; queued stops cancel only the selected queued run. By default dismisses that run's asynchronous input and cancels its leftover approvals after the run becomes terminal. Retries with the same IDs are idempotent and never select a later run. Acceptance is not confirmation: check thread_stopped and verification. Existing files are not rolled back. Other runs, background work, or pending requests can keep thread_stopped false.",
    inputSchema: {
      thread_id: z.string().min(1).max(200),
      project_id: z.string().min(1).max(200),
      run_id: z.string().min(1).max(500).nullable(),
      wait_ms: z.number().int().min(0).max(10000).optional(),
      dismiss_pending_input: z.boolean().optional(),
      cancel_pending_approvals: z.boolean().optional(),
    },
    outputSchema: {
      thread_id: z.string(), project_id: z.string(), run_id: z.string().nullable(),
      state: z.enum(["cancellation_requested", "confirmed_stopped", "already_terminal", "no_active_run", "outcome_unknown"]),
      cancellation_requested: z.boolean(), command_ids: z.array(z.string()),
      run_status: z.string().nullable(), thread_status: z.string(), thread_stopped: z.boolean(),
      pending_request_ids: z.array(z.string()), active_run_ids: z.array(z.string()),
      queued_run_ids: z.array(z.string()), held_queued_run_ids: z.array(z.string()),
      background_work_count: z.number().nullable(), verification: z.enum(["observed", "unavailable"]),
      warning: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, handle(({ thread_id, project_id, run_id, wait_ms, dismiss_pending_input, cancel_pending_approvals }) =>
    client.stopThread(thread_id, project_id, run_id, {
      waitMs: wait_ms, dismissPendingInput: dismiss_pending_input, cancelPendingApprovals: cancel_pending_approvals,
    })));

  server.registerTool("settle_thread", {
    title: "Mark a T3Code thread Settled",
    description: "Mark one thread Settled, T3Code's done marker that moves it to the Settled section. This is not the same as a completed run or archiving. Read get_thread first and pass its exact project_id and thread_id. Refuses before any change while the thread runs, waits on an approval or question, has a queued message, is archived, or is a subagent thread. Unanswered asynchronous questions or background tasks also block it unless cancel_pending_input or stop_background_work is true. Settling unpins the thread and clears any snooze. Calling it on an already Settled thread changes nothing. " + lifecycleResultNote,
    inputSchema: { ...lifecycleTarget, cancel_pending_input: z.boolean().optional(), stop_background_work: z.boolean().optional() },
    outputSchema: lifecycleOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, handle(({ thread_id, project_id, wait_ms, cancel_pending_input, stop_background_work }) => client.settleThread(thread_id, project_id, {
    waitMs: wait_ms, cancelPendingInput: cancel_pending_input, stopBackgroundWork: stop_background_work,
  })));

  server.registerTool("unsettle_thread", {
    title: "Remove Settled from a T3Code thread",
    description: "Return one Settled thread to the active list. T3Code then keeps it active and skips auto-settling until new activity. Pass the exact project_id and thread_id. Archived threads must be unarchived first. Calling it on a thread that is not Settled changes nothing. " + lifecycleResultNote,
    inputSchema: lifecycleTarget,
    outputSchema: lifecycleOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, handle(({ thread_id, project_id, wait_ms }) => client.unsettleThread(thread_id, project_id, { waitMs: wait_ms })));

  server.registerTool("archive_thread", {
    title: "Archive a T3Code thread",
    description: "Archive one thread, hiding it from the thread lists. It stays readable and can be restored with unarchive_thread. Pass the exact project_id and thread_id from get_thread. Refuses before any change while the thread runs, waits on an approval or question, has queued runs, or is a subagent thread. Background tasks also block it unless stop_background_work is true. Archiving closes the thread's terminals and revokes its agent MCP credential. Calling it on an archived thread changes nothing. " + lifecycleResultNote,
    inputSchema: { ...lifecycleTarget, stop_background_work: z.boolean().optional() },
    outputSchema: lifecycleOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, handle(({ thread_id, project_id, wait_ms, stop_background_work }) => client.archiveThread(thread_id, project_id, {
    waitMs: wait_ms, stopBackgroundWork: stop_background_work,
  })));

  server.registerTool("unarchive_thread", {
    title: "Unarchive a T3Code thread",
    description: "Restore one archived thread to the thread lists. Its Settled state is kept. Find it with find_thread include_archived and pass the exact project_id and thread_id. Calling it on a thread that is not archived changes nothing. " + lifecycleResultNote,
    inputSchema: lifecycleTarget,
    outputSchema: lifecycleOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, handle(({ thread_id, project_id, wait_ms }) => client.unarchiveThread(thread_id, project_id, { waitMs: wait_ms })));

  return server;
}
