# Runtime details

Low-level runtime mechanics that complement the high-level
[architecture](../architecture). This page specifies suspend / resume, LLM
error handling, compaction timing, self-check injection, and task report
flow — the details an implementer needs to build the runtime correctly.

Per-topic deep dives:
[dispatcher](./dispatcher) ·
[compaction](./compaction) ·
[self-check](./self-check) ·
[abort & recovery](./abort-recovery) ·
[supervisor](./supervisor) ·
[events](./events).

## 1. Tool-call dispatch & suspension

### 1.1 Single agent conversation loop

Each agent runs as a standard LLM conversation loop:

1. Runtime sends the next LLM request (system prompt + message history +
   pending tool results).
2. LLM responds with either:
   - **Text-only:** the agent is done — extract the final result and return
     to parent.
   - **Tool calls:** one or more tool-call blocks in the response.
3. For each tool call:
   - If it's a **local tool** (filesystem, shell, git MCP, plan MCP):
     execute immediately, collect result.
   - If it's an **agent-dispatch tool** (`run_manager`, `run_coder`,
     `run_researcher`, `run_data_agent`, `run_reviewer`, `run_designer`,
     `run_critic`, `run_inspector`, `run_librarian`): spawn child agent
     (see §1.2).
4. Inject all tool results (keyed by `tool_use_id`) back into the
   conversation.
5. Continue the loop from step 1.

### 1.2 Agent dispatch (suspend / resume)

When an agent issues a tool call that dispatches a child agent:

1. **Save parent state:** the parent `BaseAgent` keeps its message history
   in memory up to and including the current assistant response (with its
   tool-call blocks). This is the *suspension point*.
2. **Spawn child agent:** create a new LLM conversation for the child.
   Pass the task / stage / request as the child's initial context.
3. **Parent is suspended:** no further LLM calls for the parent until the
   child returns.
4. **Child runs to completion:** the child executes its own conversation
   loop (possibly dispatching its own children).
5. **Child returns:** the child's final result (`TaskReport`,
   `StageSummary`, `InspectionReport`) is serialized as the tool-call
   result.
6. **Resume parent:** inject the tool result into the parent's message
   history at the suspension point. Continue the parent's conversation
   loop.

**What is retained on suspension:**

- Full in-memory message history.
- Current assistant-response tool calls and `tool_use_id`s are already part of that message history.
- Agent metadata (type, id, current task / stage info).

This is retained in memory while the child runs. On crash, the runtime
reconstructs durable stage and task state from disk (see §8); suspended
conversation turns are not separately persisted.

### 1.3 Parallel agent dispatch

When an LLM response contains multiple agent-dispatch tool calls (e.g.,
Manager issues `run_coder(task_a)` and `run_researcher(task_b)` in the
same response):

1. **Both children are spawned concurrently** — each in its own LLM
   conversation.
2. **Parent is suspended.**
3. **Resume after the batch completes:** the Dispatcher awaits the allowed
   child promises together and injects one tool-result message containing
   all completed child results.
4. The parent's conversation loop continues normally from that single
   resumed turn.

**Constraints:**

- Maximum 1 dispatch per worker role in a single batch (**enforced by the
  runtime**, not just convention). Worker roles currently include Coder,
  Researcher, Data Agent, Reviewer, Designer, and Critic.
- If the LLM emits duplicate dispatches for the same worker role in one
  response, the runtime rejects the excess calls with an error result.
  Only the first of each role is dispatched.

### 1.4 Mixed tool calls

When an LLM response contains both local tools and agent dispatches:

1. Execute all **local tools immediately** and sequentially — collect
   results.
2. Spawn all **agent-dispatch tools concurrently**.
3. After the allowed child dispatches finish, inject one tool-result
   message containing the local results, duplicate-dispatch rejections,
   and child results.
4. Resume the parent's LLM conversation from that combined result batch.

## 2. LLM call failure handling

### 2.1 Retry strategy

LLM API retries use exponential backoff:

| Parameter       | Default              | Notes                                 |
|-----------------|----------------------|---------------------------------------|
| `initial_delay` | 30000 ms             | Retry backoff starting delay          |
| `max_delay`     | 1200000 ms (20 min)  | Retry backoff ceiling                 |
| `multiplier`    | 1.5                  | Exponential backoff factor            |

**Retryable errors** (retry automatically, invisible to agents):

- HTTP 429 (rate limit)
- HTTP 408 and 5xx server errors
- Network timeouts
- Connection resets

**Repairable request-shape errors** (compact and retry immediately):

- Context window exceeded / HTTP 413
- Orphaned tool-result errors from a provider rejecting the message shape

**Non-retryable errors** (surface as agent failure):

- HTTP 400 (bad request — indicates a prompt issue)
- HTTP 401 / 403 (auth — requires operator intervention)

Retries continue with a cap for non-throttling transient failures. The
backoff starts at 30 seconds, multiplies by 1.5 on each attempt, and caps
at 20 minutes. Provider throttling does not count toward the non-throttle
retry cap; other transient failures terminate the agent after 500
non-throttling attempts (`BaseAgent.transientCap`). Context-overflow and
orphaned-tool-result errors trigger compaction and an immediate retry
instead of backoff.

### 2.2 Invalid tool calls

If the LLM returns a tool call with:

- **Unknown tool name:** return an error result to the LLM:
  `"Error: unknown tool '<name>'. Available tools: [...]"`. The
  conversation continues — the LLM can self-correct.
- **Invalid parameters** (wrong type, missing required field): return a
  validation error to the LLM with details. The conversation continues.
- **Malformed JSON** in tool arguments: return parse error to the LLM.
  The conversation continues.

The runtime never crashes on bad tool calls — it always returns an error
result and lets the LLM retry. If the LLM fails to produce valid tool
calls after 3 consecutive attempts, the agent returns a failed result to
its parent.

### 2.3 Provider failover

Provider failover is handled by `ModelRouter` per chat request. It builds
a candidate chain from the requested model, configured `failover` entries,
model equivalents, and provider/account priorities. Failed retryable
candidates are put on an exponential cooldown (15 seconds × 1.5, capped at
10 minutes) while the router tries the next candidate. When a non-primary
candidate succeeds after the primary was attempted, the router uses a
sticky failover and retries the primary after a separate cooldown (30
seconds × 1.5, capped at 20 minutes).

## 3. Context compaction timing

### 3.1 When compaction triggers

Compaction is checked **between tool-call rounds** — after all pending
tool results have been injected and before the next LLM call. It never
triggers mid-turn or while tool calls are pending.

**Trigger condition:**

```
estimated_tokens(message_history) > threshold_pct × model_context_window
```

Default `threshold_pct`: 80%. Configurable per agent role in
`ProjectConfig.agents.<role>.compaction_threshold_pct` (see
[data/types](../data/types) §2).

### 3.2 Compaction procedure

1. Serialize the current message history.
2. Send a **compaction request** to the LLM (using the same model):
   "Summarize this conversation for continuation. Include: your role,
   current objective, key decisions made, outstanding work, and references
   to disk state you should re-read."
3. Replace the message history with a single user-role compaction summary;
   the system prompt remains the static `router.chat` system prompt supplied
   separately by `BaseAgent`.
4. Continue the conversation loop from this compressed state.

**Survivor reinjection.** After `compactConversation` returns and
**before** `replaceMessages` is called, `BaseAgent` queries the knowledge
loader for every `active` record with `scope == "project"` AND
`survive_compaction == true` (both skills and memories), and appends a
single user-role `--- SURVIVING KNOWLEDGE ---` block to the new message
list. Records whose survivor summaries exceed the survivor hard ceiling
(4096 estimated tokens) are omitted by the loader before the block is
built. Stage- and session-scoped records do **not** survive.
`compaction.ts` itself is intentionally **unchanged** — it remains a pure
history-to-summary function with no MCP / no store access; the integration
lives in `BaseAgent`.

**Planner pre-compaction memory nudge.** When `shouldCompact(state)`
returns true AND the agent's role is `planner`, `BaseAgent` injects ONE
pre-compaction user-role message asking the Planner to call
`create_memory` / `create_skill` for any durable knowledge that must
survive compaction. The Planner's writes then go through the **normal MCP
loop** — there is no synthesized `compaction_persist_memory` tool. The
nudge loop is capped at 5 turns; compaction proceeds either way.
Non-Planner agents skip the nudge.

### 3.3 State reconstruction after compaction

After compaction, the agent's next turn should re-read authoritative state
from disk:

- **Planner:** calls `plan_get()` + `plan_get_history()` to reconstruct
  strategic context.
- **Manager:** reads `tasks.json` + completed task reports under
  `stages/<stage-id>/reports/`.
- **Workers (Coder/Researcher/Inspector):** re-read the task description,
  checklist, and any files they were working on. The compaction summary
  tells them what they've already done and what remains.

The compaction summary explicitly instructs the agent to re-read state —
this is part of the summary template, not left to the LLM's judgment.

## 4. Self-check helper

### 4.1 Counter

`src/runtime/self-check.ts` defines an in-memory counter of **tool-call
rounds** per agent conversation. A round = one LLM response that contains
tool calls, regardless of how many tool calls it contains (parallel calls
count as 1 round).

| Agent      | Default frequency (N) |
|------------|----------------------|
| Planner    | 30                   |
| Manager    | 20                   |
| Coder      | 15                   |
| Researcher | 15                   |
| Data Agent | 15                   |
| Reviewer   | 15                   |
| Designer   | 15                   |
| Critic     | 15                   |
| Inspector  | 15                   |
| Chat       | 0                    |
| Librarian  | 20                   |

The defaults are derived from `ROSTER.selfCheckFrequency`. The current
`BaseAgent` loop does not instantiate `SelfCheckState` or inject
`selfCheckMessage`; live stuck handling comes from compaction limits,
invalid-response limits, planner nudges, and the Supervisor.

### 4.2 Injection mechanism

The helper's intended injection behavior is:

1. Reset the counter to 0.
2. Before the next LLM call, inject this progress prompt:
   > "Self-check: You have completed N tool-call rounds. Briefly assess:
   > are you making progress toward the objective, or are you stuck in a
   > loop? If stuck, finish with a failure result. If making progress,
   > continue."
3. Process the LLM's response normally.

### 4.3 Stuck detection

Because the helper is not wired into `BaseAgent`, the runtime does **not**
parse an LLM self-assessment for keywords. Live stuck handling is instead:

- Context limits trigger compaction; repeated compactions, fallback
  exhaustion, or an oversized atomic tool round terminate the agent.
- The Supervisor can cancel an abortable active agent after repeated stuck
  verdicts.
- Planner text-only turns are nudged up to 15 times before recovery
  restarts the Planner.

### 4.4 Maximum compactions

If an agent's conversation triggers compaction more than **3 times**
(configurable), the runtime terminates the agent as stuck. Workers return
a failed `TaskReport`; Manager returns a `StageSummary` with
`result: "failed"`. This is the ultimate safety net for infinite loops.

## 5. Task report flow

### 5.1 Write sequence

When a worker (Coder/Researcher) finishes a task:

1. Worker writes `TaskReport` JSON to
   `stages/<stage-id>/reports/<task-id>.json` (atomic: write `.tmp`,
   rename).
2. Worker commits its modified files + the report file via `git_commit()`.
3. Worker returns the full `TaskReport` object as the tool-call result to
   the Manager.

The Manager receives the report both as the tool-call return value (for
immediate processing) and on disk (for persistence and crash recovery).

### 5.2 Report size

`TaskReport.tests_run[].output` may be large. Workers should truncate
test output to **10KB per test** and total report to **100KB**. If
truncated, set `output_truncated: true` on the `TaskReport` (see
[data/types](../data/types) §6).

### 5.3 Crash during report write

If the worker crashes after writing the report file but before the git
commit:

- The report file exists on disk (untracked).
- On crash recovery, the Manager re-starts for the stage. It finds the
  report file and reads its `status` field:
  - If `status: "completed"` **and** the report's `commits` list is
    non-empty (changes were committed before crash), mark the task as
    `completed`.
  - If `status: "completed"` but `commits` is empty (report written but
    changes never committed), mark the task as `failed` — the code
    changes were lost on crash. The Manager can retry.
  - If `status: "failed"`, mark the task as `failed` and use the report's
    `failure_reason`.

If the worker crashes before writing the report:

- No report file exists.
- On crash recovery, the task is reset to `pending` and re-dispatched.

## 6. Task lifecycle

### 6.1 Attempt counting

`Task.attempt` starts at **1** when the task is created (representing the
first attempt). After a failure, the Manager checks whether to retry: if
`attempt < max_attempts`, it increments `attempt`, modifies the
description with failure context, and retries; if
`attempt >= max_attempts`, it escalates.

Sequence with `max_attempts = 3`: create (attempt=1) → dispatch → fail →
1 < 3? yes → increment (attempt=2) → modify description → dispatch →
fail → 2 < 3? yes → increment (attempt=3) → dispatch → fail → 3 < 3? no
→ escalate. Total: 3 dispatch attempts.

### 6.2 Retry description modification

When retrying a failed task, the Manager appends to the task description:

```
---
**Retry (attempt N of M):** Previous attempt failed with: "<failure_reason>"
Suggested different approach: <Manager's analysis of what to try differently>
---
```

This is written to `tasks.json` before dispatch so it persists across
crashes.

### 6.3 Task dependencies

Tasks with `dependencies: ["tsk-abc"]` cannot be dispatched until
`tsk-abc` has `status: "completed"`.

- If a dependency task **fails** (all retries exhausted): dependent tasks
  are marked `status: "failed"` with a note `"Dependency tsk-abc failed"`.
  They are not dispatched.
- **Circular dependencies** are a task-decomposition error. The Manager
  should detect cycles when writing `tasks.json` (topological sort). If
  detected, the Manager revises the task breakdown.

### 6.4 Checklist semantics

A task is `"completed"` only if:

- All checklist items with `required: true` have `passed: true` in the
  report.
- Optional items (`required: false`) are reported but don't affect
  completion status.

If required items fail, the worker should report `status: "failed"` with
`failure_reason` explaining which checks failed.

## 7. Inspector lifecycle

### 7.1 Workspace management

Each Inspector invocation creates a directory:
`tmp/inspector-workspace/<report-id>/`. This directory is not
auto-cleaned — previous investigations' workspaces persist across runs.

The Inspector can:

- List previous workspaces to find and reuse tools/scripts.
- Read previous reports from `inspections/` to build on prior findings.
- Promote tools from its workspace to `tools/inspector/` by copying +
  committing.

### 7.2 Report expiration

Reports with `expires_at` set are cleaned up lazily: when any agent reads
the reports directory (listing, searching), expired reports are deleted.
No background timer.

### 7.3 Inspector during abort

If an Inspector was dispatched by the Planner and an abort occurs:

- The Inspector is terminated (same as any other agent in the chain).
- Its partial work in `tmp/inspector-workspace/` remains for future use.
- No report is written for aborted inspections.

If an Inspector was dispatched by Chat (independent):

- It is **not affected** by abort — Chat and its children are independent
  of the Planner hierarchy.

## 8. Crash recovery details

### 8.1 Stale PID detection

`RuntimeState.pid` stores the process ID. On startup:

1. Read `runtime.json`.
2. Check if `pid` matches a running process (`kill(pid, 0)` or
   `/proc/<pid>/`).
3. If process is dead and `status != "idle"` → stale state detected → run
   recovery.
4. If process is alive → another instance is running → refuse to start
   (log error, exit).

### 8.2 Recovery sequence

1. Read `runtime.json` → get `current_stage_id` and `active_agents`.
2. Call `plan_get()` to get the current plan.
3. If `current_stage_id` was set:
   1. Check `stages/<stage-id>/summary.json` — if exists, the stage
      reached a terminal result before the crash. Check whether the stage
      is still in the active plan (not yet archived to history). If so,
      the restarted Planner must call `plan_complete_stage()` for this
      result before any replanning. The summary contains the `result`
      field needed for archival.
   2. Check `stages/<stage-id>/tasks.json` — if exists, Manager was
      running. Reset any `in-progress` tasks to `pending`, reset any
      `aborted` tasks to `pending`.
   3. Check for report files in `stages/<stage-id>/reports/` — if a
      report exists for a `pending` task, read its `status` and `commits`
      fields. If `status: "completed"` and `commits` is non-empty, mark
      the task as `completed`. If `status: "failed"` or `commits` is
      empty, mark the task as `failed` (the worker finished but its
      changes may not have been committed).
4. Start Planner as fresh conversation.
5. Write clean `runtime.json` with new PID.

## 9. Notification delivery

### 9.1 Event bus

The runtime maintains an in-process event bus. Events are published when:

| Event                  | Published by | Contains              |
|------------------------|-------------|----------------------|
| `stage_completed`      | Runtime     | `stage_id`, `summary` |
| `stage_failed`         | Runtime     | `stage_id`, `summary` |
| `escalation`           | Runtime     | `stage_id`, `summary` |
| `task_failed`          | Runtime     | `stage_id`, `task_id`, `summary` |
| `inspector_complete`   | Runtime     | `report_id`, `summary` |
| `plan_updated`         | Runtime     | `summary`             |

See [runtime/events](./events) for the bus implementation.

### 9.2 Chat subscription

Each Chat agent subscribes to the event bus on startup. When an event
arrives:

1. Check the user's notification filter (from `SaivageConfig.notifications.filters`).
2. If the event passes the filter, format a concise notification message.
3. Push via the channel's transport (Telegram bot API, WebSocket).

### 9.3 Offline channels

If a channel is disconnected (WebSocket lost, Telegram timeout):

- Events are buffered in-memory, up to 100 events per channel.
- On reconnection, buffered events are delivered.
- If the buffer overflows, oldest events are dropped with a summary:
  "Missed N notifications while offline."

## 10. Chat transport

### 10.1 Telegram

- Reuse v1's Telegram bot integration (`src/channels/telegram.ts`).
- Long-polling for incoming messages.
- Push notifications via `sendMessage` API.
- One Chat agent instance per Telegram user.

### 10.2 Web UI

- WebSocket connection between browser and server.
- Server pushes events and responses; client sends user messages.
- One Chat agent instance per WebSocket session.
- On disconnection, buffer events until reconnection or session timeout
  (default: 1 hour).

### 10.3 Message flow

```
User message → Channel transport → Chat agent (LLM conversation) → Response → Channel transport → User
```

System events arrive independently:

```
Runtime event → Event bus → Chat agent → Format notification → Channel transport → User
```

## 11. Git edge cases

### 11.1 Conflict handling

Git conflicts are rare (conventions prevent agents from touching each
other's files) but possible. When `git_commit()` returns a conflict
error:

- The worker reports it as a task failure:
  `failure_reason: "Git conflict on files: [...]"`.
- The Manager does **not** retry blindly — it creates a new resolution
  task or escalates to the Planner.
- The Planner may adjust stage assignments to prevent future conflicts.

### 11.2 Untracked files after abort

`git checkout -- .` resets tracked modified files. Untracked files (new
files created by the aborted agent) remain. The rollback stage handles
cleanup: it inspects the working tree for unexpected files and removes
them if appropriate.

### 11.3 Plan commit no-op

`plan_commit()` when nothing has changed since the last commit: returns
`{ sha: "<previous_sha>", noop: true }`. Not an error.

## 12. Note lifecycle

User notes are created by Chat via `create_note()` and consumed by the
Planner. The **runtime** manages the full lifecycle — the Planner never
writes to note files.

### 12.1 Injection

When the Planner resumes (after a Manager returns or an abort), the
runtime:

1. Scans `notes/` for files with no `acknowledged_at` field.
2. Reads each unacknowledged note and injects it into the Planner's
   conversation context as an additional message.
3. Permanent notes are also re-injected after context compaction (the
   runtime re-scans `notes/` for `permanent: true` notes).

### 12.2 Acknowledgment

After the Planner completes its next planning action (any `plan_*` write
call or `run_manager` dispatch), the runtime:

1. Sets `acknowledged_at` to the current timestamp on all notes that were
   injected in this cycle.
2. Writes the updated note files atomically (`.tmp` + rename).

### 12.3 Cleanup

After acknowledgment:

- **Volatile notes** (`permanent: false`): deleted from disk by the
  runtime.
- **Permanent notes** (`permanent: true`): remain on disk indefinitely.
  They are re-injected after context compaction so the Planner doesn't
  lose lasting user direction.

### 12.4 Crash recovery

On restart, unacknowledged notes (no `acknowledged_at`) are re-injected
into the fresh Planner conversation. Acknowledged volatile notes that
weren't deleted before the crash are cleaned up during recovery.
