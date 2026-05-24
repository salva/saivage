# F23 — Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F23-supervisor-priority-incomplete.md](SPEC/v2/review-2026-05/F23-supervisor-priority-incomplete.md)
- [SPEC/v2/review-2026-05/F23/04-review-r1.md](SPEC/v2/review-2026-05/F23/04-review-r1.md)
- [SPEC/v2/review-2026-05/F23/01-analysis-r2.md](SPEC/v2/review-2026-05/F23/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F23/02-design-r2.md](SPEC/v2/review-2026-05/F23/02-design-r2.md)
- [SPEC/v2/review-2026-05/F23/03-plan-r2.md](SPEC/v2/review-2026-05/F23/03-plan-r2.md)
- Spot-checks: [src/agents/chat.ts](src/agents/chat.ts), [src/agents/base.ts](src/agents/base.ts), [src/channels/types.ts](src/channels/types.ts), [src/channels/oneshot.ts](src/channels/oneshot.ts), [src/server/server.ts](src/server/server.ts), [src/server/telegram-bot.ts](src/server/telegram-bot.ts), [src/runtime/supervisor.ts](src/runtime/supervisor.ts), [src/agents/types.ts](src/agents/types.ts)

## Findings

### Analysis

r2 fixes the main r1 omission for the WebSocket path. The analysis now correctly states that `BaseAgent.cancel()` only flips the inherited flag ([src/agents/base.ts](src/agents/base.ts#L209-L211)), while `ChatAgent.run()` resolves from the channel close handler rather than from `BaseAgent.runLoop()` ([src/agents/chat.ts](src/agents/chat.ts#L192), [src/agents/chat.ts](src/agents/chat.ts#L223-L233)). That is the right contract to analyze before adding `chat` to the abort priority.

However, the channel inventory overstates the existing close semantics. `OneShotChannel.onClose()` is a no-op and `OneShotChannel.close()` is also a no-op ([src/channels/oneshot.ts](src/channels/oneshot.ts#L31-L36)). The statement that all four `ChatChannel` implementations wire `close()` to the registered `onClose` handler is therefore factually false. If one-shot chat is no longer a real `ChatAgent` transport, the analysis should say so and remove it from the honest-cancel proof; if it is still intended to satisfy `ChatChannel`, the plan must include the channel fix and test it.

The analysis also cites `src/cli/run.ts` as a CLI chat consumer, but that path does not exist. The actual CLI entrypoint is [src/server/cli.ts](src/server/cli.ts), and the current source search did not find a CLI `ChatAgent` construction outside tests. This is not just a stale link: it affects the claimed set of lifecycle consumers.

### Design

Proposal B remains the right supervisor-side shape: replacing `ROLE_ABORT_PRIORITY` with `Record<AgentRole, number>` is a clean structural fix for the union/list drift between [src/agents/types.ts](src/agents/types.ts#L20-L28) and [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L20). The ordering rationale is also sound, with `planner` last.

The chat side is still incomplete because the design only registers the WebSocket chat path in [src/server/server.ts](src/server/server.ts#L694-L709). Telegram also constructs and runs `ChatAgent` instances ([src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L101)), and those instances are not inserted into `runtime.agentRegistry`. With `chat` present in `ABORT_PRIORITY`, this leaves a real class of live chat sessions invisible to the supervisor. That undercuts the design's claim that Proposal B fixes the bug at every layer.

This is equivalent in severity to the r1 objection, not a new stylistic preference: adding `chat` to the priority map is only correct if every in-scope long-lived `ChatAgent` either participates in the registry/cancel contract or is explicitly excluded from the abortable roster.

### Plan

The WebSocket plan is executable: it adds `runtime.agentRegistry.set(ctx.agentId, chatAgent)` before running the agent and deletes it in a `finally`, mirroring the planner pattern. The `ChatAgent.cancel()` override is also the right minimal hook for channels whose `close()` fires `onClose`.

The plan must be expanded before approval:

- Add the same registry lifecycle for Telegram chat sessions, or explicitly choose the no-chat-supervision variant and remove `chat` from `ABORT_PRIORITY`. The current Proposal B cannot leave [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L89-L101) untouched while claiming complete chat supervision.
- Correct the `OneShotChannel` contract. Either update [src/channels/oneshot.ts](src/channels/oneshot.ts#L31-L36) so `close()` triggers the registered close handler, or remove one-shot from the set of transports used to prove `ChatAgent.cancel()` is universally honest. Leaving the false claim in place would hand the implementer a broken invariant.
- Add focused tests for the additional lifecycle surface. The r2 chat lifecycle test with a fake channel is useful, but it does not prove Telegram registration/deregistration and it does not catch the current `OneShotChannel.close()` no-op.

## Required changes

1. Revise the analysis/design/plan to account for Telegram-created `ChatAgent` instances. If Proposal B keeps `chat` in `ABORT_PRIORITY`, the plan must register Telegram chat agents in `runtime.agentRegistry`, delete them in a `finally` after `run()` resolves or rejects, and include a focused test or extracted helper test that covers both WebSocket and Telegram registration behavior.
2. Fix the channel-close factual error. Either make `OneShotChannel` satisfy the same `close()` -> `onClose` lifecycle and add a small test for it, or document that one-shot is not an in-scope `ChatAgent` transport and remove it from the proof that all channels already support the cancel chain.
3. Remove or correct the nonexistent `src/cli/run.ts` reference. If there is no CLI chat path today, say that plainly; do not cite it as a lifecycle consumer.
4. Update the validation commands to include the new Telegram/channel lifecycle coverage alongside the existing supervisor and chat lifecycle tests.

## Strengths

- r2 directly addresses the r1 planner-starvation objection for the WebSocket path.
- The `Record<AgentRole, number>` proposal is still the strongest supervisor-side fix and matches the architecture-first/no-shim guideline.
- The proposed `ChatAgent.cancel()` override is concise and uses the existing `onClose` resolution path instead of inventing a parallel shutdown mechanism.

VERDICT: CHANGES_REQUESTED