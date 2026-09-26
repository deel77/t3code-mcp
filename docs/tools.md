# MCP tools

| Tool | Purpose |
| --- | --- |
| `list_projects` | List accessible projects and the selection used for a new thread. |
| `list_threads` | List recent threads in one project. |
| `list_recent_threads` | List recently changed threads across projects. |
| `list_attention` | Find threads awaiting input or approval, or showing an error. |
| `find_thread` | Search thread titles across projects, optionally including message text. |
| `get_thread` | Read recent messages, pending requests, status, and an updates cursor. |
| `get_thread_updates` | Read messages and state changed since a cursor. |
| `get_thread_changes` | Read checkpoint file changes and an optional bounded diff. |
| `list_model_options` | Read live provider, model, and reasoning choices. |
| `answer_thread_input` | Answer a pending question by request and question ID. |
| `respond_thread_approval` | Approve, deny, or cancel one pending approval by request ID. |
| `start_thread` | Start a thread with optional model selection and runtime mode. |
| `send_followup` | Send another prompt with an optional model selection. |

`start_thread` defaults to `full-access`. Set `runtime_mode` to `approval-required`, `auto-accept-edits`, or `auto` to use another T3Code mode. `send_followup` keeps an existing thread's mode.

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

Tool schemas returned by `tools/list` are the source for exact parameters and limits. Tool results include both JSON text and `structuredContent`. Expected bridge errors return `isError: true` with an explanation. Unexpected internal errors return a generic message.
