/** Adapt v2 projections to the bridge's existing public response format. */
export function normalizeThreadShell(thread) {
  if (typeof thread.status !== "string") return thread;
  const request = thread.pendingRuntimeRequest;
  return {
    ...thread,
    latestTurn: { state: thread.status === "failed" ? "error" : thread.status },
    session: { status: thread.status === "failed" ? "error" : thread.status, lastError: thread.lastError ?? null },
    hasPendingUserInput: request?.kind === "user_input",
    hasPendingApprovals: Boolean(request && request.kind !== "user_input" && request.kind !== "auth_refresh" && request.kind !== "dynamic_tool_call"),
    backgroundLiveness: thread.pendingBackgroundTasks?.length
      ? thread.pendingBackgroundTasks.every((task) => task.kind === "monitor") ? "monitoring" : "working" : null,
  };
}

export function normalizeThreadDetail(detail) {
  if (!detail.projection) return detail;
  const projection = detail.projection;
  const activities = [];
  for (const request of projection.runtimeRequests ?? []) {
    if (request.status !== "pending" || request.responseCapability?.type === "not_resumable") continue;
    const item = (projection.turnItems ?? []).find((entry) => entry.requestId === request.id
      && (entry.type === "user_input_request" || entry.type === "approval_request"));
    if (!item) continue;
    const input = item.type === "user_input_request";
    activities.push({
      kind: input ? "user-input.requested" : "approval.requested",
      turnId: item.runId, createdAt: request.createdAt,
      summary: item.title ?? item.prompt ?? "Approval requested",
      payload: {
        requestId: request.id,
        ...(input ? { questions: item.questions,
          responseMode: request.responseCapability?.type === "message" ? "message" : "callback" }
          : { requestKind: item.requestKind, detail: item.prompt, appName: item.appName, options: item.options }),
      },
    });
  }
  return {
    ...detail,
    thread: {
      ...projection.thread,
      messages: (projection.messages ?? []).map((message) => ({ ...message, turnId: message.runId })),
      activities,
      checkpoints: (projection.checkpoints ?? []).map((checkpoint) => ({
        ...checkpoint, checkpointTurnCount: checkpoint.appRunOrdinal ?? checkpoint.ordinalWithinScope,
      })),
      session: { lastError: projection.thread.lastError ?? null },
    },
    page: { hasMore: detail.hasMoreHistory === true },
  };
}

export const isV2Shell = (shell) => shell.schemaVersion >= 2;
