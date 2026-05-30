# F23 - Review (r3)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F23-supervisor-priority-incomplete.md](SPEC/v2/review-2026-05/F23-supervisor-priority-incomplete.md)
- [SPEC/v2/review-2026-05/F23/04-review-r2.md](SPEC/v2/review-2026-05/F23/04-review-r2.md)
- [SPEC/v2/review-2026-05/F23/01-analysis-r3.md](SPEC/v2/review-2026-05/F23/01-analysis-r3.md)
- [SPEC/v2/review-2026-05/F23/02-design-r3.md](SPEC/v2/review-2026-05/F23/02-design-r3.md)
- [SPEC/v2/review-2026-05/F23/03-plan-r3.md](SPEC/v2/review-2026-05/F23/03-plan-r3.md)
- Spot-checks: [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L101), [src/channels/oneshot.ts](src/channels/oneshot.ts#L31-L40), [src/server/cli.ts](src/server/cli.ts), [src/agents/chat.ts](src/agents/chat.ts#L222-L233), [src/server/server.ts](src/server/server.ts#L694-L710)

## Findings

### Analysis

r3 fixes the r2 factual blockers. The analysis now explicitly removes the nonexistent `src/cli/run.ts` consumer and identifies the real CLI entrypoint as [src/server/cli.ts](src/server/cli.ts), which my spot-check confirms does not construct `ChatAgent`. The `new ChatAgent` call-site sweep also matches the analysis: source construction sites are WebSocket [src/server/server.ts](src/server/server.ts#L694) and Telegram [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89), plus existing tests.

The `OneShotChannel` claim is corrected. r3 no longer includes it in the honest-cancel proof, and the current source supports that treatment: `onClose` and `close` are no-ops while lifecycle is controlled through `onDone` [src/channels/oneshot.ts](src/channels/oneshot.ts#L31-L40). Since no source `new OneShotChannel` call exists, excluding it from the F23 chat-abort proof is sufficient for this issue.

The Telegram registration gap is now accurately analyzed. The current Telegram path constructs a `ChatAgent` and launches `chatAgent.run().catch(...)` without `runtime.agentRegistry.set` or a `finally` cleanup [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L101). That is exactly the missing lifecycle surface the r3 docs add to the implementation plan.

### Design

Proposal B remains the right design and now covers all required surfaces: typed `Record<AgentRole, number>` priority enforcement, WebSocket registration, Telegram registration, and an honest `ChatAgent.cancel()` path. The r2 issue with registering only the WebSocket construction site is fixed by the explicit Telegram scope in [SPEC/v2/review-2026-05/F23/02-design-r3.md](SPEC/v2/review-2026-05/F23/02-design-r3.md#L58-L69) and by the replacement of both bare `chatAgent.run().catch(...)` launch sites.

Leaving `OneShotChannel` unchanged is acceptable for F23 because the corrected design no longer relies on it for `ChatAgent` cancellation semantics. The design also avoids backward-compatibility shims and unnecessary configurability: it replaces the drift-prone array in place and uses the type system to force future roster updates.

### Plan

The plan is executable. It now includes the Telegram lifecycle step required by r2: set the agent in `runtime.agentRegistry`, wrap `run()` in an IIFE, and delete both the registry entry and per-chat session in `finally` [SPEC/v2/review-2026-05/F23/03-plan-r3.md](SPEC/v2/review-2026-05/F23/03-plan-r3.md#L91-L123). The WebSocket and Telegram wrappers are then covered by the new mandatory chat lifecycle tests [SPEC/v2/review-2026-05/F23/03-plan-r3.md](SPEC/v2/review-2026-05/F23/03-plan-r3.md#L250-L322), and the validation commands include that focused test path [SPEC/v2/review-2026-05/F23/03-plan-r3.md](SPEC/v2/review-2026-05/F23/03-plan-r3.md#L361-L381).

The audit step also explicitly checks that the stale CLI path is gone and that there are no additional `ChatAgent` construction sites [SPEC/v2/review-2026-05/F23/03-plan-r3.md](SPEC/v2/review-2026-05/F23/03-plan-r3.md#L332-L334). I do not see a remaining guideline violation, factual error, missing required deliverable, or executability gap.

## Required changes

None.

## Strengths

- r3 resolves all r2 blockers directly instead of narrowing the claim around them.
- The recommended plan is small but complete: roster enforcement, honest chat cancellation, both chat construction sites, and focused tests.
- The OneShotChannel correction is appropriately scoped; it does not turn a supervisor-priority issue into a dead-code cleanup.

VERDICT: APPROVED