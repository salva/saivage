# F23 — Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F23-supervisor-priority-incomplete.md](SPEC/v2/review-2026-05/F23-supervisor-priority-incomplete.md)
- [SPEC/v2/review-2026-05/F23/01-analysis-r1.md](SPEC/v2/review-2026-05/F23/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F23/02-design-r1.md](SPEC/v2/review-2026-05/F23/02-design-r1.md)
- [SPEC/v2/review-2026-05/F23/03-plan-r1.md](SPEC/v2/review-2026-05/F23/03-plan-r1.md)
- Spot-checks: [src/runtime/supervisor.ts](src/runtime/supervisor.ts), [src/agents/types.ts](src/agents/types.ts), [src/server/server.ts](src/server/server.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), [src/agents/chat.ts](src/agents/chat.ts), [src/agents/base.ts](src/agents/base.ts)

## Findings

### Analysis

The roster facts are correct: `AgentRole` has eight roles, while the supervisor priority list currently covers only five ([src/agents/types.ts](src/agents/types.ts#L20-L28), [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L14-L20)). The analysis also correctly separates the static priority-list gap from the web chat registration gap.

The missing functional detail is chat cancellation semantics. `ChatAgent.run()` resolves from a channel-close callback, not from the inherited `BaseAgent.cancel()` path ([src/agents/chat.ts](src/agents/chat.ts#L192-L238)). `BaseAgent.cancel()` only sets `cancelled = true` ([src/agents/base.ts](src/agents/base.ts#L209-L210)). That means registering chat in `runtime.agentRegistry` is not by itself enough to make chat an abortable peer of workers, inspector, or planner. This matters because the recommended design places `chat` before `planner`; a cancelled-but-still-open chat session could keep winning selection and prevent the planner last-resort path from ever firing.

### Design

Proposal B's `Record<AgentRole, number>` is a good root-cause fix for the supervisor-side roster drift. It uses TypeScript to force future `AgentRole` additions to declare an abort priority, which is exactly the right level of structure for this consumer.

However, the design treats chat registration as sufficient. The proposed priority order includes `chat` immediately before `planner` ([SPEC/v2/review-2026-05/F23/02-design-r1.md](SPEC/v2/review-2026-05/F23/02-design-r1.md#L38-L48)), and the new `selectAbortTarget` picks the first live registry entry after sorting ([SPEC/v2/review-2026-05/F23/02-design-r1.md](SPEC/v2/review-2026-05/F23/02-design-r1.md#L50-L58)). Without a concrete chat abort lifecycle, this can create a new failure mode: chat becomes visible to the supervisor but cannot be completed, deregistered, or skipped after cancellation.

### Plan

The supervisor edit and ordering tests are executable for worker-like agents, but the chat portion needs a real lifecycle plan. The statement that no chat-registration test is mandatory because registry membership is the only behavioral contract is not correct for this issue ([SPEC/v2/review-2026-05/F23/03-plan-r1.md](SPEC/v2/review-2026-05/F23/03-plan-r1.md#L130-L132)). The behavioral contract is that a selected abort target can actually stop being the selected live target, otherwise `chat` can starve `planner` despite the planner-as-last-resort test.

## Required changes

1. Revise the analysis/design/plan to define the chat abort contract explicitly. If `chat` remains in `ABORT_PRIORITY`, the plan must make chat genuinely abortable, for example by overriding `ChatAgent.cancel()` to call `super.cancel()` and close/resolve its channel so the server wrapper reaches `runtime.agentRegistry.delete(ctx.agentId)`. If the intended behavior is not to close user chat sockets from the supervisor, then do not include `chat` in the abort priority list in this issue; document that constraint instead.
2. Add focused test coverage for the chosen chat lifecycle. A small fake `ChatChannel` unit test is enough if it proves that a registered chat session is removed from `runtime.agentRegistry` after supervisor cancellation or channel closure. Also cover the planner-starvation edge case: after chat is cancelled or removed, planner must become selectable as the last resort instead of being masked by the same chat entry forever.
3. Update the test strategy and validation commands to include the new chat lifecycle test. The current full-ordering registry-only test can remain, but it is not sufficient to validate the server/chat registration sub-task.

## Strengths

- The core diagnosis is accurate and grounded in the real role union and supervisor code.
- Proposal B is appropriately architecture-first: it removes the drift-prone list and replaces it with a complete type-checked map, without compatibility shims or new configuration.
- The ordering rationale correctly treats planner cancellation as the most expensive last resort.

VERDICT: CHANGES_REQUESTED