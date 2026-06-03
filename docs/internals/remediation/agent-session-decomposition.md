# Agent Session Decomposition

## Problem

`BaseAgent` currently owns too many responsibilities:

- Conversation loop.
- LLM request/retry/backoff.
- Tool schema assembly and role filtering.
- Dispatcher integration.
- Compaction and survivor reinjection.
- Stash handling.
- Channel draining.
- Diagnostics and dashboard snapshots.
- Final-response validation hooks.
- Terminal-tool detection.

This makes every role inherit a large implicit runtime. Small behavior changes
can affect compaction, diagnostics, retry, and tool calls at once.

## Dispatcher Relationship

`runtime/dispatcher.ts` owns tool-call routing: it separates local MCP calls from
dispatch (child-agent) calls, enforces a max-1-per-worker-role concurrency limit
per batch, and creates child agents through `ChildSpawner`. The agent loop calls
`this.dispatcher.processToolCalls()` and builds tool-result blocks from the
returned `DispatchResult`.

BaseAgent does not own tool execution — the Dispatcher does. Any extraction that
touches tool-call processing should keep the Dispatcher as the execution owner and
avoid wrapping it in another layer. The migration strategy below treats
dispatch-call construction and tool-result-block building as BaseAgent
responsibilities that move with the message handling, not as a new ToolRoundExecutor.

## Goal

Keep agent subclasses simple while splitting session mechanics into focused
components. The split should remove meaningful complexity from `BaseAgent`, not
create a class for every small helper method.

## Target Structure

### `AgentSession`

Small facade used by role classes:

- `runLoop()`
- `injectUserMessage()`
- `cancel()`
- `snapshot()`
- `activityStatus()`

It coordinates lower-level components but does not implement all details.

### `ConversationState`

Owns messages and metadata:

- Message append/replace.
- Token accounting state.
- Round IDs.
- Message timestamps and provider sources.

### `LlmTurnRunner`

Owns one model turn:

- Retry/backoff through `RetryPolicy`.
- Context-overflow recovery (compact and retry).
- Response normalization.
- Provider source metadata.

Note: channel draining happens in the main `runLoop()` before the LLM call, not
inside the turn runner.

### `RetryPolicy`

Owns retry decisions:

- Transient vs throttling behavior.
- Context-overflow repair path.
- Backoff schedule.
- Retry diagnostics.

### `ToolCatalog`

Optional extraction if tool assembly remains noisy after `ConversationState`,
`RetryPolicy`, and `CompactionController` are extracted. It should not be done
first.

Builds tools for a role:

- MCP tool entries.
- Synthetic `read_stash`.
- Dispatch tool schemas.
- Role presentation filtering.

Tool execution itself remains owned by `runtime/dispatcher.ts`. Do not add a
`ToolRoundExecutor` wrapper unless the extraction removes more code than it adds.

### `CompactionController`

Owns compaction:

- Threshold decisions.
- Planner pre-compaction memory hook.
- Summarizer fallback handling.
- Survivor reinjection.
- Context reset notification.

Dashboard projection can stay close to `ConversationState` or `AgentSession`.
Do not add a separate `ConversationViewBuilder` unless snapshot rendering
becomes independently complex.

## Role Class Shape

Role classes should mostly do this:

- Build initial message.
- Choose prompt key and eager context.
- Call `session.runLoop()`.
- Interpret the terminal result as `AgentResult`.

They should not know retry internals, provider message block ordering, stash
thresholds, or dashboard projection details.

## Migration Strategy

1. Extract pure helper functions first, without changing behavior.
2. Add `ConversationState` and move message arrays/timestamps/round IDs into it.
3. Add `RetryPolicy` around existing `callLLM` logic.
4. Add `CompactionController` around existing compaction logic.
5. Order further extractions (ToolCatalog, etc.) by how much code they remove from
   the loop. Skip any that add abstraction without reducing cognitive load.
6. Narrow the dependencies extracted components receive instead of passing the
   whole `AgentContext` everywhere.
7. Rename `BaseAgent` to a compatibility wrapper or collapse it into
   `AgentSession` after subclasses no longer depend on protected internals.

## Validation

- Golden tests for `validateFinalResponse()` repair and
  `detectTerminalToolCall()` terminal-tool behavior before/after extraction.
- Existing compaction tests continue to pass.
- Stub router tests prove retry/backoff behavior is unchanged.
- Tool-catalog tests prove roles see the same tools as before.

## Design Constraint

Do not use this refactor to harden role permissions. Tool filtering remains a
simple prompt-shaping affordance. Compliance and artifact checks are separate
runtime observation concerns.

## AgentContext Narrowing

`AgentContext` currently bundles 13 fields (6 required, 7 optional). Extracted
components should receive focused interfaces instead of the whole bag:

- `ConversationState` needs `project.projectRoot` (for stash paths) and
  `compactionConfig` (for thresholds). It does not need `mcpRuntime` or
  `noteManager`.
- `RetryPolicy` needs `router`, `modelSpec`, and abort/cancel signals. It does
  not need `project` or `stageId`.
- `CompactionController` needs `router`, `modelSpec`, `project.projectRoot`,
  and `role`. It does not need `mcpRuntime` or `channelId`.
- Compliance checks need `role`, `stageId`, and tool call history. They do not
  need `router` or `mcpRuntime`.

Define narrow interfaces during extraction. `AgentContext` can stay as a
convenience type for code that actually needs everything, but new components
should declare their own interfaces.
