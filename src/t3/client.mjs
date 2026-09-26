import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BridgeError } from "../errors.mjs";
import { pendingUserInputs, validateInputAnswers } from "./pending-input.mjs";
import { pendingApprovals } from "./pending-approval.mjs";
import { callT3Rpc } from "./rpc.mjs";
import { describeSelection, modelOptions, nextTurnModel, resolveModelSelection } from "./model-selection.mjs";

const MAX_PROMPT_CHARS = 12_000;
const MAX_TITLE_CHARS = 120;
const REQUEST_TIMEOUT_MS = 12_000;

const requireText = (value, label, maxLength) => {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new BridgeError(`${label} must be 1 to ${maxLength} characters.`);
  }
  return value.trim();
};

const projectSummary = (project, selection) => ({
  id: project.id,
  title: project.title,
  new_thread_model: selection,
});

const newThreadModel = (shell, project) => project.defaultModelSelection
  ?? shell.threads
    .filter((thread) => thread.projectId === project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.modelSelection
  ?? null;

const backgroundLiveness = (thread) => ["working", "monitoring"].includes(thread.backgroundLiveness)
  ? thread.backgroundLiveness : null;
const activityStatus = (thread) => backgroundLiveness(thread)
  ?? (thread.latestTurn?.state === "running" || thread.session?.status === "running" ? "running"
    : thread.latestTurn?.state ?? thread.session?.status ?? null);

const threadSummary = (thread, providers = []) => ({
  id: thread.id,
  project_id: thread.projectId,
  title: thread.title,
  updated_at: thread.updatedAt,
  turn_state: thread.latestTurn?.state ?? null,
  session_status: thread.session?.status ?? null,
  background_liveness: backgroundLiveness(thread),
  activity_status: activityStatus(thread),
  runtime_mode: thread.runtimeMode ?? null,
  needs_approval: Boolean(thread.hasPendingApprovals),
  needs_user_input: Boolean(thread.hasPendingUserInput),
  has_actionable_plan: Boolean(thread.hasActionableProposedPlan),
  next_turn_model: nextTurnModel(thread, providers),
});

const messageSummary = (message) => ({
  id: message.id, role: message.role, turn_id: message.turnId ?? null,
  text: String(message.text).slice(0, 8_000),
  text_truncated: String(message.text).length > 8_000,
  created_at: message.createdAt, updated_at: message.updatedAt ?? message.createdAt,
  streaming: Boolean(message.streaming),
});

const approvalContext = (thread, project, detail) => ({
  project_id: thread.projectId,
  project_title: project?.title ?? null,
  project_workspace_root: project?.workspaceRoot ?? null,
  thread_id: thread.id,
  thread_title: thread.title,
  runtime_mode: thread.runtimeMode ?? null,
  branch: detail?.thread?.branch ?? thread.branch ?? null,
  worktree_path: detail?.thread?.worktreePath ?? thread.worktreePath ?? null,
});

const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decodeCursor = (cursor) => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.thread_id !== "string") throw new Error();
    return value;
  } catch { throw new BridgeError("Invalid updates cursor. Call get_thread to get a fresh cursor.", 400); }
};
const latestMessageMarker = (messages) => messages.reduce((latest, message) => {
  const marker = `${message.updatedAt ?? message.createdAt ?? ""}|${message.id ?? ""}`;
  return marker > latest ? marker : latest;
}, "");
const cursorFor = (thread, detail) => encodeCursor({
  thread_id: thread.id, sequence: detail.snapshotSequence ?? 0,
  message_marker: latestMessageMarker(detail.thread?.messages ?? []),
  turn_state: thread.latestTurn?.state ?? null,
  session_status: thread.session?.status ?? null,
  background_liveness: backgroundLiveness(thread),
  needs_approval: Boolean(thread.hasPendingApprovals),
  needs_user_input: Boolean(thread.hasPendingUserInput),
  updated_at: thread.updatedAt,
});

export class T3Client {
  constructor({ baseUrl, tokenFile, fetchImpl = fetch, rpcImpl = callT3Rpc }) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
      throw new BridgeError("T3_BASE_URL must be a plain private HTTP origin.");
    }
    this.baseUrl = url.origin;
    this.tokenFile = tokenFile;
    this.fetchImpl = fetchImpl;
    this.rpcImpl = rpcImpl;
  }

  rpc(method, input, options) {
    return this.rpcImpl({ baseUrl: this.baseUrl, tokenFile: this.tokenFile, fetchImpl: this.fetchImpl }, method, input, options);
  }

  async providers() {
    const config = await this.rpc("server.getConfig", {});
    if (!Array.isArray(config?.providers)) throw new BridgeError("T3 provider catalog is unavailable.", 502);
    return config.providers;
  }

  async request(path, { method = "GET", body } = {}) {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    if (!token || token.includes("\n")) throw new BridgeError("T3 credential file is invalid.", 500);
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      throw new BridgeError("T3 credential expired or lacks the required scope.", 503);
    }
    if (!response.ok) {
      throw new BridgeError(`T3 request failed with HTTP ${response.status}.`, 502);
    }
    return response.json();
  }

  async shell() {
    const shell = await this.request("/api/orchestration/shell");
    if (!Array.isArray(shell.projects) || !Array.isArray(shell.threads)) {
      throw new BridgeError("T3 returned an unexpected shell response.", 502);
    }
    return shell;
  }

  allowedProject(shell, projectId) {
    const project = shell.projects.find((item) => item.id === projectId);
    if (!project) throw new BridgeError("Project was not found in T3.", 404);
    return project;
  }

  allowedThread(shell, threadId) {
    const thread = shell.threads.find((item) => item.id === threadId);
    if (!thread || !shell.projects.some((project) => project.id === thread.projectId)) {
      throw new BridgeError("Thread was not found in your T3Code projects.", 404);
    }
    return thread;
  }

  async listProjects() {
    const shell = await this.shell();
    return {
      projects: shell.projects.map((project) => projectSummary(project, newThreadModel(shell, project))),
    };
  }

  async listThreads(projectId, limit = 15) {
    const shell = await this.shell();
    this.allowedProject(shell, projectId);
    return {
      threads: this.enrichThreads(shell.threads
        .filter((thread) => thread.projectId === projectId && !thread.archivedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, Math.min(Math.max(limit, 1), 30))),
    };
  }

  async listRecentThreads(limit = 15) {
    const shell = await this.shell();
    const projects = new Map(shell.projects.map((project) => [project.id, project]));
    return {
      threads: this.enrichThreads(shell.threads
        .filter((thread) => !thread.archivedAt && projects.has(thread.projectId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, Math.min(Math.max(limit, 1), 30)), projects),
    };
  }

  enrichThreads(threads, projects = null) {
    return threads.map((thread) => ({ ...threadSummary(thread),
      ...(projects ? { project_title: projects.get(thread.projectId).title } : {}) }));
  }

  async threadDetail(threadId, turnLimit = 12) {
    return this.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}${turnLimit === null ? "" : `?turnLimit=${turnLimit}`}`);
  }

  async detailWithPendingInput(threadId, turnLimit, initialDetail) {
    let detail = initialDetail ?? await this.threadDetail(threadId, turnLimit);
    let pending = pendingUserInputs(detail.thread?.activities);
    if (pending.length === 0) {
      detail = await this.threadDetail(threadId, null);
      pending = pendingUserInputs(detail.thread?.activities);
    }
    return { detail, pending };
  }

  async getThread(threadId, messageLimit = 12) {
    const shell = await this.shell();
    const summary = this.allowedThread(shell, threadId);
    const safeLimit = Math.min(Math.max(messageLimit, 1), 30);
    let detail = await this.threadDetail(threadId, safeLimit);
    let pending = pendingUserInputs(detail.thread?.activities);
    let approvals = pendingApprovals(detail.thread?.activities, approvalContext(summary,
      shell.projects.find((project) => project.id === summary.projectId), detail));
    if ((summary.hasPendingUserInput && pending.length === 0)
      || (summary.hasPendingApprovals && (approvals.length === 0 || detail.page?.hasMore))) {
      detail = await this.threadDetail(threadId, null);
      pending = pendingUserInputs(detail.thread?.activities);
      approvals = pendingApprovals(detail.thread?.activities, approvalContext(summary,
        shell.projects.find((project) => project.id === summary.projectId), detail));
    }
    const messages = Array.isArray(detail.thread?.messages) ? detail.thread.messages : [];
    return {
      ...threadSummary(summary),
      messages: messages.filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-safeLimit)
        .map(messageSummary),
      pending_user_inputs: pending,
      pending_approvals: approvals,
      truncated_history: Boolean(detail.page?.hasMore || messages.length > safeLimit),
      last_error: detail.thread?.session?.lastError ?? null,
      updates_cursor: cursorFor(summary, detail),
    };
  }

  async listAttention(limit = 15) {
    const shell = await this.shell();
    const projects = new Map(shell.projects.map((project) => [project.id, project]));
    const candidates = shell.threads.filter((thread) => !thread.archivedAt && projects.has(thread.projectId));
    const attention = candidates.flatMap((thread) => {
      const reason = thread.hasPendingUserInput ? "input" : thread.hasPendingApprovals ? "approval"
        : thread.latestTurn?.state === "error" || thread.session?.status === "error" ? "error" : null;
      return reason ? [{ thread, reason }] : [];
    }).sort((a, b) => {
      const priority = { input: 0, approval: 1, error: 2 };
      return priority[a.reason] - priority[b.reason] || b.thread.updatedAt.localeCompare(a.thread.updatedAt);
    }).slice(0, Math.min(Math.max(limit, 1), 30));
    const summaries = this.enrichThreads(attention.map(({ thread }) => thread), projects);
    const withInputs = await Promise.all(summaries.map(async (summary, index) => {
      const detail = summary.needs_user_input || summary.needs_approval ? await this.getThread(summary.id, 1) : null;
      return { ...summary, attention_reason: attention[index].reason,
        ...(detail ? { pending_user_inputs: detail.pending_user_inputs,
          pending_approvals: detail.pending_approvals } : {}) };
    }));
    return { threads: withInputs };
  }

  async findThread(query, limit = 10, searchMessages = false) {
    const text = requireText(query, "query", 200).toLowerCase();
    const shell = await this.shell();
    const projects = new Map(shell.projects.map((project) => [project.id, project]));
    const allowed = shell.threads.filter((thread) => !thread.archivedAt && projects.has(thread.projectId));
    const rank = (title) => title.toLowerCase() === text ? 0 : title.toLowerCase().startsWith(text) ? 1 : 2;
    const titleMatches = allowed.filter((thread) => thread.title.toLowerCase().includes(text))
      .sort((a, b) => rank(a.title) - rank(b.title) || b.updatedAt.localeCompare(a.updatedAt));
    let messageMatches = [];
    if (searchMessages && text.length >= 2) {
      const search = await this.rpc("orchestration.searchThreads", { query, limit: Math.min(limit, 30) });
      const allowedIds = new Set(allowed.map((thread) => thread.id));
      messageMatches = (search.matches ?? []).filter((match) => allowedIds.has(match.threadId));
    }
    const ids = [...new Set([...titleMatches.map((thread) => thread.id), ...messageMatches.map((match) => match.threadId)])].slice(0, limit);
    const byId = new Map(allowed.map((thread) => [thread.id, thread]));
    const summaries = this.enrichThreads(ids.map((id) => byId.get(id)), projects);
    return { threads: summaries.map((summary) => ({ ...summary,
      matched_in: titleMatches.some((thread) => thread.id === summary.id) ? "title" : "message",
      message_snippet: messageMatches.find((match) => match.threadId === summary.id)?.snippet ?? null })) };
  }

  async getThreadUpdates(threadId, cursor, messageLimit = 20) {
    const previous = decodeCursor(cursor);
    if (previous.thread_id !== threadId) throw new BridgeError("Updates cursor belongs to another thread.", 400);
    const shell = await this.shell();
    const thread = this.allowedThread(shell, threadId);
    const replay = await this.rpc("orchestration.subscribeThread", {
      threadId, afterSequence: previous.sequence, requestCompletionMarker: true, turnLimit: 5,
    }, { untilSynchronized: true });
    let resyncRequired = replay.some((item) => item?.kind === "snapshot");
    const detail = await this.threadDetail(threadId, resyncRequired ? null : 5);
    const approvalDetail = thread.hasPendingApprovals
      && (detail.page?.hasMore || pendingApprovals(detail.thread?.activities, null).length === 0)
      ? await this.threadDetail(threadId, null) : detail;
    const messages = detail.thread?.messages ?? [];
    if (detail.page?.hasMore && messages.length > 0) {
      const oldest = `${messages[0].updatedAt ?? messages[0].createdAt ?? ""}|${messages[0].id ?? ""}`;
      if (previous.message_marker && previous.message_marker < oldest) resyncRequired = true;
    }
    const changed = messages.filter((message) =>
      `${message.updatedAt ?? message.createdAt ?? ""}|${message.id ?? ""}` > previous.message_marker);
    const safeLimit = Math.min(Math.max(messageLimit, 1), 30);
    const stateChanged = previous.turn_state !== (thread.latestTurn?.state ?? null)
      || previous.session_status !== (thread.session?.status ?? null)
      || previous.background_liveness !== backgroundLiveness(thread)
      || previous.needs_approval !== Boolean(thread.hasPendingApprovals)
      || previous.needs_user_input !== Boolean(thread.hasPendingUserInput);
    return {
      ...threadSummary(thread),
      messages: changed.filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-safeLimit).map(messageSummary),
      state_changed: stateChanged, resync_required: resyncRequired,
      messages_truncated: changed.length > safeLimit || resyncRequired,
      pending_user_inputs: thread.hasPendingUserInput ? pendingUserInputs(detail.thread?.activities) : [],
      pending_approvals: pendingApprovals(approvalDetail.thread?.activities, approvalContext(thread,
        shell.projects.find((project) => project.id === thread.projectId), approvalDetail)),
      last_error: detail.thread?.session?.lastError ?? null,
      updates_cursor: cursorFor(thread, detail),
    };
  }

  async getThreadChanges(threadId, { fromTurnCount, toTurnCount, includeDiff = false } = {}) {
    const shell = await this.shell();
    this.allowedThread(shell, threadId);
    const detail = await this.threadDetail(threadId, 1);
    const checkpoint = detail.thread?.checkpoints?.at(-1);
    const turnCount = toTurnCount ?? checkpoint?.checkpointTurnCount ?? 0;
    const result = { thread_id: threadId,
      checkpoint_turn_count: checkpoint?.checkpointTurnCount ?? null, checkpoint_status: checkpoint?.status ?? null,
      files: checkpoint?.files ?? [] };
    if (includeDiff) {
      const start = fromTurnCount ?? Math.max(0, turnCount - 1);
      if (!Number.isSafeInteger(start) || start < 0 || start > turnCount) throw new BridgeError("Invalid from_turn_count.");
      const diff = await this.rpc("orchestration.getTurnDiff", { threadId, fromTurnCount: start, toTurnCount: turnCount });
      return { ...result, from_turn_count: start, to_turn_count: turnCount,
        diff: typeof diff.diff === "string" ? diff.diff.slice(0, 24_000) : null,
        diff_truncated: typeof diff.diff === "string" && diff.diff.length > 24_000 };
    }
    return result;
  }

  async listModelOptions(filters = {}) {
    return modelOptions(await this.providers(), filters);
  }

  async answerThreadInput(threadId, requestId, submittedAnswers) {
    const shell = await this.shell();
    this.allowedThread(shell, threadId);
    const { pending } = await this.detailWithPendingInput(threadId, 20);
    const request = pending.find((item) => item.request_id === requestId);
    if (!request) throw new BridgeError("This input request is no longer pending. Call get_thread for the current questions.", 409);
    const answers = validateInputAnswers(request, submittedAnswers);
    await this.request("/api/orchestration/dispatch", {
      method: "POST",
      body: {
        type: "thread.user-input.respond",
        commandId: randomUUID(),
        threadId,
        requestId,
        answers,
        createdAt: new Date().toISOString(),
      },
    });
    return {
      thread_id: threadId,
      request_id: requestId,
      state: "answer command accepted",
      response_mode: request.response_mode,
    };
  }

  async respondThreadApproval(threadId, requestId, decision) {
    const shell = await this.shell();
    const thread = this.allowedThread(shell, threadId);
    let detail = await this.threadDetail(threadId, 20);
    let pending = pendingApprovals(detail.thread?.activities, approvalContext(thread,
      shell.projects.find((project) => project.id === thread.projectId), detail));
    if (!pending.some((item) => item.request_id === requestId)) {
      detail = await this.threadDetail(threadId, null);
      pending = pendingApprovals(detail.thread?.activities, approvalContext(thread,
        shell.projects.find((project) => project.id === thread.projectId), detail));
    }
    const request = pending.find((item) => item.request_id === requestId);
    if (!request) throw new BridgeError("This approval request is no longer pending. Call get_thread for current approvals.", 409);
    if (request.options.length && !request.options.some((option) => option.decision === decision)) {
      throw new BridgeError(`Decision '${decision}' is unavailable for this approval request.`, 400);
    }
    await this.request("/api/orchestration/dispatch", { method: "POST", body: {
      type: "thread.approval.respond", commandId: randomUUID(), threadId, requestId,
      decision, createdAt: new Date().toISOString(),
    } });
    return { thread_id: threadId, request_id: requestId, decision, state: "approval response accepted" };
  }

  async startThread(projectId, prompt, title, modelSelection, runtimeMode = "full-access") {
    const shell = await this.shell();
    const project = this.allowedProject(shell, projectId);
    const text = requireText(prompt, "prompt", MAX_PROMPT_CHARS);
    const baseSelection = newThreadModel(shell, project);
    const selection = modelSelection === undefined ? baseSelection
      : resolveModelSelection(modelSelection, baseSelection, await this.providers());
    if (!selection?.instanceId || !selection?.model) {
      throw new BridgeError("Set a default model or create a thread in T3Code for this project before starting a thread here.");
    }
    const threadTitle = title === undefined
      ? text.split("\n", 1)[0].slice(0, MAX_TITLE_CHARS).trim()
      : requireText(title, "title", MAX_TITLE_CHARS);
    const createdAt = new Date().toISOString();
    const threadId = randomUUID();
    const command = {
      type: "thread.turn.start",
      commandId: randomUUID(),
      threadId,
      message: { messageId: randomUUID(), role: "user", text, attachments: [] },
      modelSelection: selection,
      titleSeed: threadTitle,
      runtimeMode,
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId,
          title: threadTitle,
          modelSelection: selection,
          runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    };
    await this.rpc("orchestration.dispatchCommand", command);
    return { thread_id: threadId, project_id: projectId, title: threadTitle, state: "queued", runtime_mode: runtimeMode,
      requested_model: describeSelection(selection) };
  }

  async sendFollowup(threadId, prompt, modelSelection) {
    const shell = await this.shell();
    const thread = this.allowedThread(shell, threadId);
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      throw new BridgeError("Thread has a pending approval or input request. Use get_thread, then answer_thread_input or respond_thread_approval.", 409);
    }
    const selection = modelSelection === undefined ? undefined
      : resolveModelSelection(modelSelection, thread.modelSelection, await this.providers());
    const createdAt = new Date().toISOString();
    await this.request("/api/orchestration/dispatch", {
      method: "POST",
      body: {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId,
        message: {
          messageId: randomUUID(),
          role: "user",
          text: requireText(prompt, "prompt", MAX_PROMPT_CHARS),
          attachments: [],
        },
        ...(selection === undefined ? {} : { modelSelection: selection }),
        runtimeMode: thread.runtimeMode ?? "approval-required",
        interactionMode: "default",
        createdAt,
      },
    });
    return { thread_id: threadId, state: "queued",
      requested_model: selection ? describeSelection(selection) : null };
  }
}
