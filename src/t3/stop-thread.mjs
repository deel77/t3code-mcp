import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError } from "../errors.mjs";

const active = new Set(["preparing", "starting", "running", "waiting"]);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const commandId = (projectId, threadId, runId, type, requestId = null) =>
  `mcp-stop:${createHash("sha256").update(JSON.stringify([projectId, threadId, runId, type, requestId])).digest("hex")}`;

// Read the unpaged projection. A recent-turn window can omit queued runs or
// a still-pending asynchronous question from the selected run.
async function snapshot(client, projectId, threadId) {
  const shell = await client.shell();
  if (shell.schemaVersion !== 2) throw new BridgeError("stop_thread requires T3 orchestration protocol 2.", 503);
  const summary = client.allowedThread(shell, threadId);
  if (summary.projectId !== projectId) throw new BridgeError("Thread does not belong to project_id. No cancellation was sent.", 409);
  const detail = await client.threadDetail(threadId, null);
  const projection = detail.projection;
  if (!projection || projection.thread?.id !== threadId || projection.thread?.projectId !== projectId
    || !Array.isArray(projection.runs) || !Array.isArray(projection.runtimeRequests)
    || !Array.isArray(projection.turnItems)) {
    throw new BridgeError("T3 returned an unexpected stop projection. No new cancellation was sent.", 502);
  }
  // Re-read the shell after the detailed projection so work starting during
  // that read cannot be hidden by an older terminal summary.
  const latestShell = await client.shell();
  if (latestShell.schemaVersion !== 2) throw new BridgeError("T3 protocol changed during stop verification.", 503);
  const latest = client.allowedThread(latestShell, threadId);
  if (latest.projectId !== projectId) throw new BridgeError("Thread project changed during stop verification.", 409);
  return { summary: latest, projection };
}

function observation(current, runId) {
  const { summary, projection } = current;
  const run = projection.runs.find((item) => item.id === runId);
  const pending = projection.runtimeRequests.filter((request) => request.status === "pending");
  const running = projection.runs.filter((item) => active.has(item.status));
  const queued = projection.runs.filter((item) => item.status === "queued");
  // Require agreement between the shell and the projection. A terminal selected
  // run alone says nothing about a newer turn, live requests, or background work.
  const stopped = (runId === null ? projection.runs.length === 0 : terminal.has(run?.status))
    && running.length === 0 && queued.every((item) => item.queueHeld === true)
    && pending.length === 0 && !summary.pendingRuntimeRequest
    && !summary.activeRunId && !active.has(summary.status) && summary.status !== "queued"
    && Array.isArray(summary.pendingBackgroundTasks) && summary.pendingBackgroundTasks.length === 0;
  return {
    run_status: run?.status ?? null,
    thread_status: summary.status,
    thread_stopped: stopped,
    pending_request_ids: pending.map((item) => item.id),
    active_run_ids: running.map((item) => item.id),
    queued_run_ids: queued.map((item) => item.id),
    held_queued_run_ids: queued.filter((item) => item.queueHeld === true).map((item) => item.id),
    background_work_count: summary.pendingBackgroundTasks?.length ?? null,
  };
}

/** Stop one explicitly selected run; never resolve "latest" again on retry. */
export async function stopThread(client, threadId, projectId, runId, {
  waitMs = 2000, dismissPendingInput = true, cancelPendingApprovals = true,
} = {}) {
  for (const [label, value] of [["thread_id", threadId], ["project_id", projectId]]) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 200) {
      throw new BridgeError(`${label} must be an exact nonempty ID.`);
    }
  }
  if (runId !== null && (typeof runId !== "string" || !runId.trim() || runId !== runId.trim() || runId.length > 500)) {
    throw new BridgeError("run_id must be an exact ID from get_thread, or null for an idle thread.");
  }
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000
    || typeof dismissPendingInput !== "boolean" || typeof cancelPendingApprovals !== "boolean") {
    throw new BridgeError("Invalid stop options.");
  }
  let current = await snapshot(client, projectId, threadId);
  let run = current.projection.runs.find((item) => item.id === runId);
  if (runId === null && current.projection.runs.length) {
    throw new BridgeError("Provide an exact run_id from get_thread. No cancellation was sent.", 409);
  }
  if (runId !== null && !run) throw new BridgeError("Run was not found in the specified thread. No cancellation was sent.", 404);
  if (run && !active.has(run.status) && run.status !== "queued" && !terminal.has(run.status)) {
    throw new BridgeError("Unsupported run state. No cancellation was sent.", 409);
  }

  const commands = [];
  let accepted = false;
  let uncertain = false;
  const dispatch = async (type, extra = {}) => {
    const id = commandId(projectId, threadId, runId, type, extra.requestId);
    commands.push(id);
    try {
      await client.rpc("orchestration.dispatchCommand", {
        type, commandId: id, threadId,
        ...(["run.interrupt", "queued-run.cancel"].includes(type) ? { runId } : {}),
        ...extra,
      });
      accepted = true;
      return true;
    } catch {
      // A lost reply can follow an accepted command. Read state before doing
      // anything else, and never turn a transport error into a success claim.
      uncertain = true;
      return false;
    }
  };

  const initialStatus = run?.status;
  if (run?.status === "queued") await dispatch("queued-run.cancel");
  else if (run && active.has(run.status)) await dispatch("run.interrupt", { holdQueue: true });

  // Only message-capable questions have a supported dismissal command. Live
  // callback input is interrupted through the provider, without manufacturing
  // answers. Remaining approvals are cancelled only after terminalization.
  const dismissible = runId !== null && dismissPendingInput ? current.projection.runtimeRequests.filter((request) =>
    request.status === "pending" && request.kind === "user_input" && request.responseCapability?.type === "message"
    && current.projection.turnItems.some((item) => item.requestId === request.id && item.runId === runId)) : [];
  const approvals = runId !== null && cancelPendingApprovals ? current.projection.runtimeRequests.filter((request) =>
    request.status === "pending" && request.responseCapability?.type !== "not_resumable"
    && current.projection.turnItems.some((item) => item.type === "approval_request"
      && item.requestId === request.id && item.runId === runId)) : [];
  const deadline = Date.now() + waitMs;
  let promoted = false;
  let dismissed = false;
  let approvalsCancelled = false;
  let verified = commands.length === 0;
  for (;;) {
    if (commands.length) {
      try {
        current = await snapshot(client, projectId, threadId);
        verified = true;
      } catch {
        verified = false;
        break;
      }
    }
    run = current.projection.runs.find((item) => item.id === runId);
    // The queue may promote this run between the read and queued-run.cancel.
    // Interrupt only that same ID, once. Never chase a newer run.
    if (initialStatus === "queued" && active.has(run?.status) && !promoted) {
      promoted = true;
      await dispatch("run.interrupt", { holdQueue: true });
      continue;
    }
    if (!dismissed && dismissible.length) {
      dismissed = true;
      for (const request of dismissible) {
        if (current.projection.runtimeRequests.some((item) => item.id === request.id && item.status === "pending")) {
          await dispatch("thread.user-input.dismiss", { requestId: request.id });
        }
      }
      continue;
    }
    if (!approvalsCancelled && terminal.has(run?.status) && approvals.length) {
      approvalsCancelled = true;
      for (const request of approvals) {
        if (current.projection.runtimeRequests.some((item) => item.id === request.id && item.status === "pending")) {
          await dispatch("runtime-request.respond", { requestId: request.id, decision: "cancel" });
        }
      }
      continue;
    }
    if (observation(current, runId).thread_stopped || Date.now() >= deadline || !commands.length) break;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  const observed = observation(current, runId);
  const state = !verified ? "outcome_unknown"
    : observed.thread_stopped && commands.length ? "confirmed_stopped"
    : !commands.length ? runId === null ? "no_active_run" : "already_terminal"
    : uncertain ? "outcome_unknown" : "cancellation_requested";
  return {
    thread_id: threadId, project_id: projectId, run_id: runId, state,
    cancellation_requested: accepted, command_ids: commands,
    ...observed,
    ...(verified ? {} : { thread_stopped: false }),
    verification: verified ? "observed" : "unavailable",
    ...(uncertain ? { warning: "A command reply failed. Retry with the same IDs; cancellation may already have taken effect." } : {}),
  };
}
