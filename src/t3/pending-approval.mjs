const decisions = new Set(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]);
const staleRequestFragments = [
  "stale pending approval request",
  "unknown pending approval request",
  "unknown pending permission request",
];

export function pendingApprovals(activities, context) {
  const open = new Map();
  const closed = new Set();
  for (const activity of activities ?? []) {
    const payload = activity?.payload;
    const requestId = payload && typeof payload === "object" ? payload.requestId : null;
    if (typeof requestId !== "string" || !requestId) continue;
    if (activity.kind === "approval.requested") {
      if (closed.has(requestId)) continue;
      open.set(requestId, {
        request_id: requestId,
        turn_id: activity.turnId ?? null,
        created_at: activity.createdAt,
        summary: activity.summary ?? "Approval requested",
        request_kind: typeof payload.requestKind === "string" ? payload.requestKind : null,
        request_type: typeof payload.requestType === "string" ? payload.requestType : null,
        action: typeof payload.detail === "string" ? payload.detail : null,
        app_name: typeof payload.appName === "string" ? payload.appName : null,
        options: Array.isArray(payload.options) ? payload.options.flatMap((option) =>
          option && decisions.has(option.decision) && typeof option.label === "string"
            ? [{ decision: option.decision, label: option.label,
              warning: typeof option.warning === "string" ? option.warning : null }] : []) : [],
        context,
      });
    } else if (activity.kind === "approval.resolved" || (
      activity.kind === "provider.approval.respond.failed"
      && typeof payload.detail === "string"
      && staleRequestFragments.some((fragment) => payload.detail.toLowerCase().includes(fragment))
    )) {
      closed.add(requestId);
      open.delete(requestId);
    }
  }
  return [...open.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
