# G11 - Review r3

R3 is approved. Proposal B remains the right architecture: remove the free-text Planner-restart regex, keep the destructive restart action behind the explicit slash-command surface, rewrite the Chat prompt contract, and cover the deletion at the ChatAgent dispatch layer.

## Findings

No blocking findings.

## Verification Notes

- The fifth prompt directive called out in r2 is now in scope. R3 explicitly lists [prompts/chat.md](prompts/chat.md#L73), requires deleting that Guidelines bullet in [SPEC/v2/review-2026-05-round2/G11/02-design-r3.md](SPEC/v2/review-2026-05-round2/G11/02-design-r3.md#L80), and mirrors the same deletion plus stale-phrase grep in [SPEC/v2/review-2026-05-round2/G11/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G11/03-plan-r3.md#L75) and [SPEC/v2/review-2026-05-round2/G11/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G11/03-plan-r3.md#L84). That closes the prompt-contract hole around the live prompt text at [prompts/chat.md](prompts/chat.md#L7), [prompts/chat.md](prompts/chat.md#L33), [prompts/chat.md](prompts/chat.md#L43), [prompts/chat.md](prompts/chat.md#L51), and [prompts/chat.md](prompts/chat.md#L73).
- The JavaScript regex semantics are now accurate. R3 acknowledges the live `i` flags at [src/agents/chat.ts](src/agents/chat.ts#L353) and corrects the apostrophe case: [SPEC/v2/review-2026-05-round2/G11/01-analysis-r3.md](SPEC/v2/review-2026-05-round2/G11/01-analysis-r3.md#L45), [SPEC/v2/review-2026-05-round2/G11/01-analysis-r3.md](SPEC/v2/review-2026-05-round2/G11/01-analysis-r3.md#L49), and [SPEC/v2/review-2026-05-round2/G11/01-analysis-r3.md](SPEC/v2/review-2026-05-round2/G11/01-analysis-r3.md#L68). The rejected regex alternative in [SPEC/v2/review-2026-05-round2/G11/02-design-r3.md](SPEC/v2/review-2026-05-round2/G11/02-design-r3.md#L29) also no longer relies on the false `planner's` claim.
- The replacement greps are real positive controls against the current source. The current bug is visible at [src/agents/chat.ts](src/agents/chat.ts#L197), [src/agents/chat.ts](src/agents/chat.ts#L352), [src/agents/chat.ts](src/agents/chat.ts#L353), and [src/agents/chat.ts](src/agents/chat.ts#L355). R3's validation checks in [SPEC/v2/review-2026-05-round2/G11/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G11/03-plan-r3.md#L205) through [SPEC/v2/review-2026-05-round2/G11/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G11/03-plan-r3.md#L207) now search those exact markers and will fail before the deletion.
- The regression test is at the correct layer and is implementable with the existing harness. The plan targets the existing ChatAgent suite at [src/agents/agents.test.ts](src/agents/agents.test.ts#L227), reuses `makeChatContext` at [src/agents/agents.test.ts](src/agents/agents.test.ts#L614), `TestChatChannel` at [src/agents/agents.test.ts](src/agents/agents.test.ts#L626), and `deferred` at [src/agents/agents.test.ts](src/agents/agents.test.ts#L659), and can pass a `PlannerControl`-shaped stub because the class is exported at [src/server/bootstrap.ts](src/server/bootstrap.ts#L73). This test will exercise the free-text path that `dispatchLocalCommand` cannot see.

## Residual Risk

The proposed UX intentionally turns natural-language restart requests into a two-turn flow: the LLM directs the user to type `/restart-planner <reason>`, and only the slash command performs the restart. That is consistent with the finding, the subsystem map's split between Chat and local commands, and the architecture-first rule against retaining fuzzy destructive control paths.

VERDICT: APPROVED