# MCP tools

The bridge exposes 14 tools. The table and cancellation contract below describe the registered tools in this repository.

| Tool | Purpose |
| --- | --- |
| `list_projects` | List accessible projects and the selection used for a new thread. |
| `list_threads` | List recent threads in one project. |
| `list_recent_threads` | List recently changed threads across projects. |
| `list_attention` | Find threads awaiting input or approval, or showing an error. |
| `find_thread` | Search thread titles across projects, optionally including message text. |
| `get_thread` | Read recent messages, pending requests, status, exact run IDs, and an updates cursor. |
| `get_thread_updates` | Read messages and state changed since a cursor. |
| `get_thread_changes` | Read checkpoint file changes and an optional bounded diff. |
| `list_model_options` | Read live provider, model, and reasoning choices. |
| `answer_thread_input` | Answer a pending question by request and question ID. |
| `respond_thread_approval` | Approve, deny, or cancel one pending approval by request ID. |
| `start_thread` | Start a thread with optional model selection and runtime mode. |
| `send_followup` | Send another prompt with an optional model selection. |
| `stop_thread` | Stop one exact thread run, including work awaiting input or approval, and report whether stopped state was observed. |

`start_thread` defaults to `full-access` in both the client and advertised input schema. Set `runtime_mode` to `approval-required`, `auto-accept-edits`, or `auto` to use another T3Code mode. `send_followup` keeps an existing thread's mode. Changing the mode of an existing thread is not exposed as an MCP tool.

## Stop a thread run

Read `get_thread` first, verify the project and thread, and select `active_run_id` or an exact entry from `runs`. `latest_run_id` is also returned. The stop call requires all three IDs:

```json
{
  "thread_id": "EXACT_THREAD_ID",
  "project_id": "EXPECTED_PROJECT_ID",
  "run_id": "EXACT_RUN_ID_FROM_GET_THREAD",
  "wait_ms": 2000,
  "dismiss_pending_input": true,
  "cancel_pending_approvals": true
}
```

`wait_ms` defaults to 2000 and allows 0 through 10000. It bounds polling after dispatch; individual HTTP and RPC operations retain their own timeouts. Both cleanup options default to true. Use `run_id: null` only for an idle thread with no runs. Unknown or mismatched project, thread, and run IDs fail before dispatch.

| Selected run | Behavior |
| --- | --- |
| Preparing, starting, running, waiting | Send native `run.interrupt` for the selected run and hold the existing queue. Pending input or approval does not block the stop. |
| Queued | Cancel only this queued run. If it becomes active during dispatch, interrupt the same run once. |
| Completed, failed, cancelled, interrupted, rolled back | Do not interrupt again. Clean up eligible pending requests belonging to this run if enabled. |
| Idle with no runs | Return `no_active_run` without dispatch. |

Asynchronous message-capable input is dismissed without submitting an answer. Live input callbacks stop through provider interruption. Leftover approvals belonging to the selected run are cancelled only after the run is observed terminal. Stop never accepts an approval. Non-resumable requests remain visible.

| Response `state` | Meaning |
| --- | --- |
| `cancellation_requested` | A command was acknowledged, but the thread has not been confirmed stopped. |
| `confirmed_stopped` | A post-command read observed a terminal target and no remaining runnable thread work or pending requests. |
| `already_terminal` | No command was needed for the selected terminal run. Other work may remain. |
| `no_active_run` | The thread has no runs and the caller supplied null. |
| `outcome_unknown` | A command reply or verification failed; retry with the same IDs. |

Report stopped only when `thread_stopped` is true and `verification` is `observed`. The selected run being terminal alone is insufficient: another active run, an unheld queued run, a pending request, or background work keeps the flag false. Results include the actual `run_status`, thread status, active/queued/held run IDs, pending request IDs, background-work count, and command IDs. Missing verification always sets `thread_stopped` to false.

Retries with the same project, thread, and run IDs derive the same durable command IDs, including across bridge restarts. A retry never selects a newer run. Held queued messages remain stored; resume them explicitly in T3Code. Confirmation describes the observed instant and does not prevent future work.

Stop does not roll back files or completed external actions. Detached background work and non-resumable requests can require inspection in T3Code. A terminal run with background work is reported as not confirmed stopped; the bridge does not interrupt an old terminal provider session that may now be shared with a newer turn. Sending a `STOP` follow-up or cancelling one approval is not equivalent to stopping a run.

## Approvals, models and progress

`get_thread`, `get_thread_updates`, and `list_attention` expose `pending_approvals`. Each item includes its request ID, type, action text, provider options when available, and project/thread context. T3Code can omit action text or options. `respond_thread_approval` accepts the decisions `accept`, `acceptForSession`, `acceptAlways`, `decline`, and `cancel`; it rejects a stale request or a decision absent from provider-supplied options. Review the exact action before sending a decision.

`next_turn_model` describes the thread's configured selection for another turn. T3Code's current API does not reliably report the model or reasoning level actually used for a running or completed turn. Model overrides for `start_thread` and `send_followup` are validated against T3Code's live catalog and rejected when the combination is unavailable.

`get_thread_updates` uses T3Code's sequenced WebSocket replay. If it returns `resync_required: true`, call `get_thread` for a fresh cursor. A cursor belongs to one thread.

Thread summaries and details include `turn_state`, `session_status`, `background_liveness`, and `activity_status`. `turn_state` is the latest turn's state. T3Code can mark a turn `completed` while background subagents or workflows keep running. `background_liveness` is `working`, `monitoring`, or `null`; `monitoring` means only watch loops remain. `activity_status` puts live background work ahead of the latest turn state, so use it when telling someone whether the thread is finished. `get_thread_updates` sets `state_changed` when background liveness changes, even without a new message.

## Voice check-in flow

1. Call `list_attention` for blocked work or `list_recent_threads` for recent activity.
2. Use `find_thread` when the user gives a title instead of an ID.
3. Call `get_thread` to read messages and pending requests. Retain its `updates_cursor`.
4. Answer questions with `answer_thread_input`. Review the requested action and scope with the user before calling `respond_thread_approval`.
5. Pass the cursor to `get_thread_updates` on the next check. Keep the returned cursor for later checks.
6. When the user asks to stop work, use `stop_thread` with the selected project, thread and run IDs. Check the returned observation before reporting completion.

Tool schemas returned by `tools/list` are the source for exact parameters and limits. Tool results include both JSON text and `structuredContent`. Expected bridge errors return `isError: true` with an explanation. Unexpected internal errors return a generic message.
