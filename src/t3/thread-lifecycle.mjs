import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError, T3CommandRejected } from "../errors.mjs";

const activeRun = new Set(["preparing", "starting", "running", "waiting"]);
const isSettled = (thread) => thread.settledOverride === "settled" && thread.settledAt != null;
const isArchived = (thread) => thread.archivedAt != null;

// Each action maps to one native T3 command and the shell state proving it applied.
const actions = {
  settle: { type: "thread.settle", reached: isSettled },
  unsettle: { type: "thread.unsettle", extra: { reason: "user" }, reached: (thread) => !isSettled(thread) },
  archive: { type: "thread.archive", reached: isArchived },
  unarchive: { type: "thread.unarchive", reached: (thread) => !isArchived(thread) },
};

// The ID covers the observed starting state: concurrent or retried calls from the
// same state deduplicate in T3, while a later reversal gets a new command.
const commandId = (action, projectId, thread) => `mcp-${action}:${createHash("sha256").update(JSON.stringify([
  projectId, thread.id, actions[action].type, thread.updatedAt ?? null, thread.archivedAt ?? null,
  thread.settledOverride ?? null, thread.settledAt ?? null,
])).digest("hex")}`;

const exactId = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 200) {
    throw new BridgeError(`${label} must be an exact nonempty ID.`);
  }
};

/** Find a thread among active and archived threads of a project this credential can see. */
export async function locateThread(client, projectId, threadId) {
  const shell = await client.shell();
  if (shell.schemaVersion !== 2) throw new BridgeError("Thread lifecycle tools require T3 orchestration protocol 2.", 503);
  const project = shell.projects.find((item) => item.id === projectId);
  if (!project) throw new BridgeError("Project was not found in your T3Code projects. No change was made.", 404);
  let thread = shell.threads.find((item) => item.id === threadId);
  if (!thread) thread = (await client.archivedShell()).threads.find((item) => item.id === threadId);
  if (!thread || thread.deletedAt) throw new BridgeError("Thread was not found in your T3Code projects. No change was made.", 404);
  if (thread.projectId !== projectId) throw new BridgeError("Thread does not belong to project_id. No change was made.", 409);
  return { thread, project };
}

const stateOf = (thread) => ({
  title: thread.title,
  settled: isSettled(thread),
  settled_at: isSettled(thread) ? thread.settledAt : null,
  archived: isArchived(thread),
  archived_at: thread.archivedAt ?? null,
  thread_status: thread.status ?? null,
  latest_run_id: thread.latestRunId ?? null,
});

async function blockers(client, action, thread, { cancelPendingInput, stopBackgroundWork }) {
  if (action === "unarchive") return { blocker: null, effects: [] };
  if (isArchived(thread)) {
    return { blocker: `Thread is archived. Use unarchive_thread before ${action === "settle" ? "settling" : "changing Settled"}.`, effects: [] };
  }
  if (action === "unsettle") return { blocker: null, effects: [] };
  if (thread.lineage?.relationshipToParent === "subagent") {
    return { blocker: `Thread is a subagent of another thread. ${action === "settle" ? "Settle" : "Archive"} its parent thread instead.`, effects: [] };
  }
  const detail = await client.threadDetail(thread.id, null);
  const projection = detail.projection;
  if (!projection || projection.thread?.id !== thread.id || !Array.isArray(projection.runs)
    || !Array.isArray(projection.runtimeRequests)) {
    throw new BridgeError("T3 returned an unexpected thread projection. No change was made.", 502);
  }
  const running = projection.runs.filter((run) => activeRun.has(run.status));
  const queued = projection.runs.filter((run) => run.status === "queued");
  const pending = projection.runtimeRequests.filter((request) => request.status === "pending");
  // Messages T3 itself queued (notifications, delegated completions) are cancelled by Settle.
  const automatic = new Set((projection.messages ?? [])
    .filter((message) => message.notification !== undefined || message.delegatedCompletion !== undefined)
    .map((message) => message.id));
  const messageInput = pending.filter((request) => request.kind === "user_input" && request.responseCapability?.type === "message");
  const background = thread.pendingBackgroundTasks?.length ?? 0;
  const effects = [];
  const verb = action === "settle" ? "settling" : "archiving";

  if (running.length) {
    return { blocker: `Thread is still running (run ${running[0].id}). Stop it with stop_thread before ${verb}.`, effects };
  }
  if (action === "settle") {
    if (pending.some((request) => !messageInput.includes(request))) {
      return { blocker: "Thread is waiting on an approval or question. Answer it before settling.", effects };
    }
    if (queued.some((run) => !automatic.has(run.userMessageId))) {
      return { blocker: "Thread has a queued message. Send it or remove it from the queue in T3Code before settling.", effects };
    }
    if (messageInput.length && !cancelPendingInput) {
      return { blocker: `Thread has ${messageInput.length} unanswered question(s). Answer with answer_thread_input, or repeat with cancel_pending_input: true to let T3 cancel them while settling.`, effects };
    }
    if (messageInput.length) effects.push(`T3 cancels ${messageInput.length} unanswered question(s): ${messageInput.map((request) => request.id).join(", ")}.`);
    if (queued.length) effects.push(`T3 cancels ${queued.length} automatic queued notification run(s).`);
    if (thread.pinnedAt) effects.push("Settling unpins the thread.");
    if (thread.snoozedUntil) effects.push("Settling clears the snooze.");
  } else {
    if (pending.length) {
      return { blocker: "Thread is waiting on an approval or question. Answer it before archiving.", effects };
    }
    if (queued.length) {
      return { blocker: `Thread has ${queued.length} queued run(s) that archiving would cancel. Send or remove them in T3Code first.`, effects };
    }
    effects.push("Archiving closes the thread's terminals and revokes its agent MCP credential.");
  }
  if (background && !stopBackgroundWork) {
    return { blocker: `Thread has ${background} background task(s) that ${verb} would stop. Wait for them, or repeat with stop_background_work: true.`, effects };
  }
  if (background) effects.push(`T3 stops ${background} idle background task(s).`);
  return { blocker: null, effects };
}

/**
 * Apply one Settled or archive transition to an exactly identified thread and
 * report the state read back from T3 afterwards.
 */
export async function changeThreadLifecycle(client, action, threadId, projectId, {
  waitMs = 2000, cancelPendingInput = false, stopBackgroundWork = false,
} = {}) {
  if (!actions[action]) throw new BridgeError("Unsupported thread lifecycle action.");
  exactId(threadId, "thread_id");
  exactId(projectId, "project_id");
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000
    || typeof cancelPendingInput !== "boolean" || typeof stopBackgroundWork !== "boolean") {
    throw new BridgeError("Invalid thread lifecycle options.");
  }
  const { type, extra = {}, reached } = actions[action];
  let { thread } = await locateThread(client, projectId, threadId);
  const base = { thread_id: threadId, project_id: projectId, action };
  if (reached(thread)) {
    return { ...base, state: "already_in_state", changed: false, command_id: null, ...stateOf(thread),
      verification: "observed", effects: [] };
  }
  const { blocker, effects } = await blockers(client, action, thread, { cancelPendingInput, stopBackgroundWork });
  if (blocker) throw new BridgeError(`${blocker} No change was made.`, 409);

  const id = commandId(action, projectId, thread);
  let uncertain = false;
  try {
    await client.rpc("orchestration.dispatchCommand", { type, commandId: id, threadId, ...extra });
  } catch (error) {
    if (error instanceof T3CommandRejected) throw new BridgeError(`${error.message} No change was made.`, 409);
    // A lost reply can follow an applied command; read the state instead of guessing.
    uncertain = true;
  }

  const deadline = Date.now() + waitMs;
  let verified = false;
  for (;;) {
    try {
      ({ thread } = await locateThread(client, projectId, threadId));
      verified = true;
    } catch {
      verified = false;
      break;
    }
    if (reached(thread) || Date.now() >= deadline) break;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  const applied = verified && reached(thread);
  const state = applied ? "applied" : uncertain || !verified ? "outcome_unknown" : "requested";
  return {
    ...base, state, changed: applied, command_id: id, ...stateOf(thread),
    verification: verified ? "observed" : "unavailable", effects,
    ...(state === "outcome_unknown" ? { warning: "The command reply or state check failed. Read the thread again before retrying; a retry from the same state reuses this command ID." } : {}),
    ...(state === "requested" ? { warning: "T3 accepted the command but the new state was not observed yet. Read the thread again before reporting the change." } : {}),
  };
}
