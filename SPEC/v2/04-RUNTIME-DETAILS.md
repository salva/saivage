# Saivage v2 — Runtime Details

Low-level runtime mechanics that complement the high-level design in 00-AGENT-SYSTEM.md. This document specifies suspend/resume, LLM error handling, compaction timing, self-check injection, and task report flow — the details an implementer needs to build the runtime correctly.

---

## 1. Tool-Call Dispatch & Suspension

### 1.1 Single Agent Conversation Loop

Each agent runs as a standard LLM conversation loop:

1. Runtime sends the next LLM request (system prompt + message history + pending tool results).
2. LLM responds with either:
   - **Text-only**: the agent is done — extract the final result and return to parent.
   - **Tool calls**: one or more tool-call blocks in the response.
3. For each tool call:
   - If it's a **local tool** (filesystem, shell, git MCP, plan MCP): execute immediately, collect result.
   - If it's an **agent dispatch tool** (`run_manager`, `run_coder`, `run_researcher`, `run_inspector`): spawn child agent (see §1.2).
4. Inject all tool results (keyed by `tool_use_id`) back into the conversation.
5. Continue the loop from step 1.

### 1.2 Agent Dispatch (Suspend/Resume)

When an agent issues a tool call that dispatches a child agent:

1. **Save parent state**: the full message history up to and including the current assistant response (with its tool-call blocks). This is the *suspension point*.
2. **Spawn child agent**: create a new LLM conversation for the child. Pass the task/stage/request as the child's initial context.
3. **Parent is suspended**: no further LLM calls for the parent until the child returns.
4. **Child runs to completion**: the child executes its own conversation loop (possibly dispatching its own children).
5. **Child returns**: the child's final result (TaskReport, StageSummary, InspectionReport) is serialized as the tool-call result.
6. **Resume parent**: inject the tool result into the parent's message history at the suspension point. Continue the parent's conversation loop.

**What is persisted on suspension:**
- Full message history (all turns, including system prompt).
- List of pending tool calls from the current assistant response (with their `tool_use_id`s).
- Agent metadata (type, id, current task/stage info).

This is stored in-memory while the child runs. On crash, the runtime reconstructs from disk state (see 00-AGENT-SYSTEM.md §4.6).

### 1.3 Parallel Agent Dispatch

When an LLM response contains multiple agent-dispatch tool calls (e.g., Manager issues `run_coder(task_a)` and `run_researcher(task_b)` in the same response):

1. **Both children are spawned concurrently** — each in its own LLM conversation.
2. **Parent is suspended**.
3. **Resume on each completion**: when the *first* child completes, its tool result is injected into the parent's conversation, and the parent resumes. The parent can process the result, issue new tool calls (including more dispatches), or wait.
4. When the *second* child completes, its result is injected and the parent resumes again.
5. The runtime tracks which `tool_use_id`s are still pending. The parent's conversation loop continues normally — it receives each result as it arrives.

**Constraints:**
- Maximum 1 Coder + 1 Researcher running concurrently per Manager (**enforced by the runtime**, not just convention).
- If the LLM emits more than one `run_coder()` or more than one `run_researcher()` in a single response, the runtime rejects the excess calls with an error result. Only the first of each type is dispatched.

### 1.4 Mixed Tool Calls

When an LLM response contains both local tools and agent dispatches:

1. Execute all **local tools immediately** — collect results.
2. Spawn all **agent dispatch tools concurrently**.
3. Inject local tool results immediately. For agent dispatches, inject each result as it arrives.
4. Resume the parent's LLM conversation after all local results are ready. Agent dispatch results arrive asynchronously as children complete.

---

## 2. LLM Call Failure Handling

### 2.1 Retry Strategy

All LLM API calls use exponential backoff with jitter:

| Parameter       | Default   | Config path                           |
|-----------------|-----------|---------------------------------------|
| `timeout_ms`    | 120000    | `GlobalConfig.providers[name].timeout_ms` |
| `max_retry_duration_ms` | 600000 (10 min) | `GlobalConfig.providers[name].max_retry_duration_ms` |
| `initial_delay` | 1000 ms   | —                                     |
| `max_delay`     | 60000 ms  | —                                     |
| `multiplier`    | 2         | —                                     |
| `jitter`        | ±20%      | —                                     |

**Retryable errors** (retry automatically, invisible to agents):
- HTTP 429 (rate limit)
- HTTP 500, 502, 503, 529 (server errors)
- Network timeouts
- Connection resets

**Non-retryable errors** (surface as agent failure):
- HTTP 400 (bad request — indicates a prompt issue)
- HTTP 401/403 (auth — requires operator intervention)
- Context window exceeded (requires compaction or task splitting)

Retries continue for retryable errors up to a **maximum retry duration** of 10 minutes per LLM request (configurable). If the duration is exceeded, the error is surfaced as a non-retryable failure — the agent's conversation is terminated with a failure result. This prevents indefinite stalls during provider outages, where neither self-check nor compaction can fire (they trigger only between completed tool-call rounds, not during a stuck request). Provider failover (§2.3) may resolve the issue before the timeout if a failover provider is configured.

### 2.2 Invalid Tool Calls

If the LLM returns a tool call with:
- **Unknown tool name**: return an error result to the LLM: `"Error: unknown tool '<name>'. Available tools: [...]"`. The conversation continues — the LLM can self-correct.
- **Invalid parameters** (wrong type, missing required field): return a validation error to the LLM with details. The conversation continues.
- **Malformed JSON** in tool arguments: return parse error to the LLM. The conversation continues.

The runtime never crashes on bad tool calls — it always returns an error result and lets the LLM retry. If the LLM fails to produce valid tool calls after 3 consecutive attempts, the agent returns a failed result to its parent.

### 2.3 Provider Failover

If a provider becomes persistently unavailable (5+ consecutive retryable errors within 2 minutes), and a `failover` provider is configured in GlobalConfig, the runtime switches to the failover provider for the remainder of the current agent's conversation. The switch is logged. On next agent invocation, the primary provider is tried first again.

---

## 3. Context Compaction Timing

### 3.1 When Compaction Triggers

Compaction is checked **between tool-call rounds** — after all pending tool results have been injected and before the next LLM call. It never triggers mid-turn or while tool calls are pending.

**Trigger condition:**
```
estimated_tokens(message_history) > threshold_pct × model_context_window
```

Default `threshold_pct`: 80%. Configurable per agent role in ProjectConfig (see 01-DATA-MODEL.md).

### 3.2 Compaction Procedure

1. Serialize the current message history.
2. Send a **compaction request** to the LLM (using the same model): "Summarize this conversation for continuation. Include: your role, current objective, key decisions made, outstanding work, and references to disk state you should re-read."
3. Replace the full message history with: `[system_prompt, compaction_summary_message]`.
4. Continue the conversation loop from this compressed state.

### 3.3 State Reconstruction After Compaction

After compaction, the agent's next turn should re-read authoritative state from disk:
- **Planner**: calls `plan_get()` + `plan_get_history()` to reconstruct strategic context.
- **Manager**: reads `tasks.json` + completed task reports under `stages/<stage-id>/reports/`.
- **Workers (Coder/Researcher/Inspector)**: re-read the task description, checklist, and any files they were working on. The compaction summary tells them what they've already done and what remains.

The compaction summary explicitly instructs the agent to re-read state — this is part of the summary template, not left to the LLM's judgment.

---

## 4. Self-Check Injection

### 4.1 Counter

The runtime maintains an in-memory counter of **tool-call rounds** per agent conversation. A round = one LLM response that contains tool calls, regardless of how many tool calls it contains (parallel calls count as 1 round).

| Agent      | Default frequency (N) |
|------------|----------------------|
| Planner    | 30                   |
| Manager    | 20                   |
| Coder      | 15                   |
| Researcher | 15                   |
| Inspector  | 15                   |

Configurable per agent role in ProjectConfig.

### 4.2 Injection Mechanism

When the counter reaches N:
1. Reset the counter to 0.
2. Before the next LLM call, prepend a **system message** to the conversation:
   > "Self-check: You have completed N tool-call rounds. Briefly assess: are you making progress toward the objective, or are you stuck in a loop? If stuck, finish with a failure result. If making progress, continue."
3. The LLM's response is processed normally. If it declares itself stuck or returns a failure result, the runtime treats the agent as failed.
4. If the agent continues normally, the counter resets and the cycle repeats.

### 4.3 Stuck Detection

The runtime does **not** try to parse the LLM's self-assessment for keywords. Instead:
- If the agent's next action after self-check is to **return a final result** (success or failure), the self-check worked.
- If the agent continues making tool calls, it has decided it's making progress — the runtime trusts this.
- The self-check is a prompt injection that nudges the LLM to self-assess. It is not a hard kill mechanism. If an agent truly loops, it will eventually hit context limits → compaction → and after repeated compactions with no progress, it will exceed a maximum compaction count (default: 3 compactions per conversation) and be terminated with a failure result.

### 4.4 Maximum Compactions

If an agent's conversation triggers compaction more than **3 times** (configurable), the runtime terminates the agent as stuck. Workers return a failed TaskReport; Manager returns a StageSummary with `result: "failed"`. This is the ultimate safety net for infinite loops.

---

## 5. Task Report Flow

### 5.1 Write Sequence

When a worker (Coder/Researcher) finishes a task:

1. Worker writes `TaskReport` JSON to `stages/<stage-id>/reports/<task-id>.json` (atomic: write `.tmp`, rename).
2. Worker commits its modified files + the report file via `git_commit()`.
3. Worker returns the full `TaskReport` object as the tool-call result to the Manager.

The Manager receives the report both as the tool-call return value (for immediate processing) and on disk (for persistence and crash recovery).

### 5.2 Report Size

`TaskReport.tests_run[].output` may be large. Workers should truncate test output to **10KB per test** and total report to **100KB**. If truncated, add a note in the report: `"output_truncated": true`.

### 5.3 Crash During Report Write

If the worker crashes after writing the report file but before the git commit:
- The report file exists on disk (untracked).
- On crash recovery, the Manager re-starts for the stage. It finds the report file and reads its `status` field:
  - If `status: "completed"` **and** the report's `commits` list is non-empty (changes were committed before crash), mark the task as `completed`.
  - If `status: "completed"` but `commits` is empty (report written but changes never committed), mark the task as `failed` — the code changes were lost on crash. The Manager can retry.
  - If `status: "failed"`, mark the task as `failed` and use the report's `failure_reason`.

If the worker crashes before writing the report:
- No report file exists.
- On crash recovery, the task is reset to `pending` and re-dispatched.

---

## 6. Task Lifecycle

### 6.1 Attempt Counting

`Task.attempt` starts at **1** when the task is created (representing the first attempt). After a failure, the Manager checks whether to retry: if `attempt < max_attempts`, it increments `attempt`, modifies the description with failure context, and retries; if `attempt >= max_attempts`, it escalates.

Sequence with `max_attempts = 3`: create (attempt=1) → dispatch → fail → 1 < 3? yes → increment (attempt=2) → modify description → dispatch → fail → 2 < 3? yes → increment (attempt=3) → dispatch → fail → 3 < 3? no → escalate. Total: 3 dispatch attempts.

### 6.2 Retry Description Modification

When retrying a failed task, the Manager appends to the task description:

```
---
**Retry (attempt N of M):** Previous attempt failed with: "<failure_reason>"
Suggested different approach: <Manager's analysis of what to try differently>
---
```

This is written to `tasks.json` before dispatch so it persists across crashes.

### 6.3 Task Dependencies

Tasks with `dependencies: ["tsk-abc"]` cannot be dispatched until `tsk-abc` has `status: "completed"`.

- If a dependency task **fails** (all retries exhausted): dependent tasks are marked `status: "failed"` with a note `"Dependency tsk-abc failed"`. They are not dispatched.
- **Circular dependencies** are a task decomposition error. The Manager should detect cycles when writing `tasks.json` (topological sort). If detected, the Manager revises the task breakdown.

### 6.4 Checklist Semantics

A task is `"completed"` only if:
- All checklist items with `required: true` have `passed: true` in the report.
- Optional items (`required: false`) are reported but don't affect completion status.

If required items fail, the worker should report `status: "failed"` with `failure_reason` explaining which checks failed.

---

## 7. Inspector Lifecycle

### 7.1 Workspace Management

Each Inspector invocation creates a directory: `tmp/inspector-workspace/<report-id>/`. This directory is not auto-cleaned — previous investigations' workspaces persist across runs.

The Inspector can:
- List previous workspaces to find and reuse tools/scripts.
- Read previous reports from `inspections/` to build on prior findings.
- Promote tools from its workspace to `tools/inspector/` by copying + committing.

### 7.2 Report Expiration

Reports with `expires_at` set are cleaned up lazily: when any agent reads the reports directory (listing, searching), expired reports are deleted. No background timer.

### 7.3 Inspector During Abort

If an Inspector was dispatched by the Planner and an abort occurs:
- The Inspector is terminated (same as any other agent in the chain).
- Its partial work in `tmp/inspector-workspace/` remains for future use.
- No report is written for aborted inspections.

If an Inspector was dispatched by Chat (independent):
- It is **not affected** by abort — Chat and its children are independent of the Planner hierarchy.

---

## 8. Crash Recovery Details

### 8.1 Stale PID Detection

`RuntimeState.pid` stores the process ID. On startup:
1. Read `runtime.json`.
2. Check if `pid` matches a running process (`kill(pid, 0)` or `/proc/<pid>/`).
3. If process is dead and `status != "idle"` → stale state detected → run recovery.
4. If process is alive → another instance is running → refuse to start (log error, exit).

### 8.2 Recovery Sequence

1. Read `runtime.json` → get `current_stage_id` and `active_agents`.
2. Call `plan_get()` to get the current plan.
3. If `current_stage_id` was set:
   a. Check `stages/<stage-id>/summary.json` — if exists, stage was completed, Planner just needs to process it.
   b. Check `stages/<stage-id>/tasks.json` — if exists, Manager was running. Reset any `in-progress` tasks to `pending`, reset any `aborted` tasks to `pending`.
   c. Check for report files in `stages/<stage-id>/reports/` — if a report exists for a `pending` task, read its `status` and `commits` fields. If `status: "completed"` and `commits` is non-empty, mark the task as `completed`. If `status: "failed"` or `commits` is empty, mark the task as `failed` (the worker finished but its changes may not have been committed).
4. Start Planner as fresh conversation.
5. Write clean `runtime.json` with new PID.

---

## 9. Notification Delivery

### 9.1 Event Bus

The runtime maintains an in-process event bus. Events are published when:

| Event                  | Published by | Contains              |
|------------------------|-------------|----------------------|
| `stage_completed`      | Runtime     | stage_id, summary     |
| `stage_failed`         | Runtime     | stage_id, summary     |
| `escalation`           | Runtime     | stage_id, escalation  |
| `task_failed`          | Runtime     | stage_id, task_id     |
| `inspector_complete`   | Runtime     | report_id, summary    |
| `plan_updated`         | Runtime     | plan snapshot         |

### 9.2 Chat Subscription

Each Chat agent subscribes to the event bus on startup. When an event arrives:
1. Check the user's notification filter (from ProjectConfig).
2. If the event passes the filter, format a concise notification message.
3. Push via the channel's transport (Telegram bot API, WebSocket).

### 9.3 Offline Channels

If a channel is disconnected (WebSocket lost, Telegram timeout):
- Events are buffered in-memory, up to 100 events per channel.
- On reconnection, buffered events are delivered.
- If the buffer overflows, oldest events are dropped with a summary: "Missed N notifications while offline."

---

## 10. Chat Transport

### 10.1 Telegram

- Reuse v1's Telegram bot integration (`src/channels/telegram.ts`).
- Long-polling for incoming messages.
- Push notifications via `sendMessage` API.
- One Chat agent instance per Telegram user.

### 10.2 Web UI

- WebSocket connection between browser and server.
- Server pushes events and responses; client sends user messages.
- One Chat agent instance per WebSocket session.
- On disconnection, buffer events until reconnection or session timeout (default: 1 hour).

### 10.3 Message Flow

```
User message → Channel transport → Chat agent (LLM conversation) → Response → Channel transport → User
```

System events arrive independently:
```
Runtime event → Event bus → Chat agent → Format notification → Channel transport → User
```

---

## 11. Git Edge Cases

### 11.1 Conflict Handling

Git conflicts are rare (conventions prevent agents from touching each other's files) but possible. When `git_commit()` returns a conflict error:

- The worker reports it as a task failure: `failure_reason: "Git conflict on files: [...]"`.
- The Manager does **not** retry blindly — it creates a new resolution task or escalates to the Planner.
- The Planner may adjust stage assignments to prevent future conflicts.

### 11.2 Untracked Files After Abort

`git checkout -- .` resets tracked modified files. Untracked files (new files created by the aborted agent) remain. The rollback stage handles cleanup: it inspects the working tree for unexpected files and removes them if appropriate.

### 11.3 Plan Commit No-Op

`plan_commit()` when nothing has changed since the last commit: returns `{ sha: "<previous_sha>", noop: true }`. Not an error.

---

## 12. Note Lifecycle

User notes are created by Chat via `create_note()` and consumed by the Planner. The **runtime** manages the full lifecycle — the Planner never writes to note files.

### 12.1 Injection

When the Planner resumes (after a Manager returns or an abort), the runtime:
1. Scans `notes/` for files with no `acknowledged_at` field.
2. Reads each unacknowledged note and injects it into the Planner's conversation context as an additional message.
3. Permanent notes are also re-injected after context compaction (the runtime re-scans `notes/` for `permanent: true` notes).

### 12.2 Acknowledgment

After the Planner completes its next planning action (any `plan_*` write call or `run_manager` dispatch), the runtime:
1. Sets `acknowledged_at` to the current timestamp on all notes that were injected in this cycle.
2. Writes the updated note files atomically (`.tmp` + rename).

### 12.3 Cleanup

After acknowledgment:
- **Volatile notes** (`permanent: false`): deleted from disk by the runtime.
- **Permanent notes** (`permanent: true`): remain on disk indefinitely. They are re-injected after context compaction so the Planner doesn't lose lasting user direction.

### 12.4 Crash Recovery

On restart, unacknowledged notes (no `acknowledged_at`) are re-injected into the fresh Planner conversation. Acknowledged volatile notes that weren't deleted before the crash are cleaned up during recovery.
