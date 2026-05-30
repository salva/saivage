# F30 - Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F30-chat-slash-commands-triplicated.md](SPEC/v2/review-2026-05/F30-chat-slash-commands-triplicated.md)
- [SPEC/v2/review-2026-05/F30/04-review-r1.md](SPEC/v2/review-2026-05/F30/04-review-r1.md)
- [SPEC/v2/review-2026-05/F30/01-analysis-r2.md](SPEC/v2/review-2026-05/F30/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F30/02-design-r2.md](SPEC/v2/review-2026-05/F30/02-design-r2.md)
- [SPEC/v2/review-2026-05/F30/03-plan-r2.md](SPEC/v2/review-2026-05/F30/03-plan-r2.md)
- Spot-checks: [src/agents/chat.ts](src/agents/chat.ts#L99-L110), [src/agents/chat.ts](src/agents/chat.ts#L303-L361), [src/agents/chat.ts](src/agents/chat.ts#L379-L385), [src/agents/chat.ts](src/agents/chat.ts#L480), [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L38-L90)

## Findings

### Analysis

The r2 analysis resolves the r1 factual typo. It now states that the memory/skill help suffix has seven rows and keeps those rows out of `LOCAL_CHAT_COMMANDS` ([SPEC/v2/review-2026-05/F30/01-analysis-r2.md](SPEC/v2/review-2026-05/F30/01-analysis-r2.md#L34-L36), [src/agents/chat.ts](src/agents/chat.ts#L379-L385)). The corrected command argument count is also consistent with the current local switch at [src/agents/chat.ts](src/agents/chat.ts#L335-L358).

The scope boundary is clear and acceptable: memory/skill parsing and execution stay first in the two-tier flow ([src/agents/chat.ts](src/agents/chat.ts#L303-L329), [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L38-L90)), and the analysis explicitly forbids changes to `src/chat/slashCommands.ts`, `parseSlashCommand` / `runSlashCommand`, and the seven memory/skill help rows ([SPEC/v2/review-2026-05/F30/01-analysis-r2.md](SPEC/v2/review-2026-05/F30/01-analysis-r2.md#L89-L96)).

### Design

The dispatch design is now genuinely registry-driven. Both viable proposals derive `LocalChatCommandName` from `LOCAL_CHAT_COMMANDS` and constrain the handler table with `satisfies Record<LocalChatCommandName, LocalCommandHandler>` ([SPEC/v2/review-2026-05/F30/02-design-r2.md](SPEC/v2/review-2026-05/F30/02-design-r2.md#L20-L49), [SPEC/v2/review-2026-05/F30/02-design-r2.md](SPEC/v2/review-2026-05/F30/02-design-r2.md#L189-L213)). This removes the r1 problem where command names were duplicated in a parallel `switch (c.name)`.

Proposal B stays within the allowed boundary. It moves local command dispatch and local help rendering into [src/chat/localCommands.ts](src/chat/localCommands.ts), while leaving the memory/skill router in [src/chat/slashCommands.ts](src/chat/slashCommands.ts) and preserving the existing parse-then-local-dispatch order ([SPEC/v2/review-2026-05/F30/02-design-r2.md](SPEC/v2/review-2026-05/F30/02-design-r2.md#L160-L225), [SPEC/v2/review-2026-05/F30/02-design-r2.md](SPEC/v2/review-2026-05/F30/02-design-r2.md#L235-L249)). The memory/skill help rows remain a verbatim suffix, not part of the local registry ([SPEC/v2/review-2026-05/F30/02-design-r2.md](SPEC/v2/review-2026-05/F30/02-design-r2.md#L223-L225), [SPEC/v2/review-2026-05/F30/02-design-r2.md](SPEC/v2/review-2026-05/F30/02-design-r2.md#L261-L262)).

### Plan

The plan matches the corrected design. The proposed `dispatchLocalCommand` resolves through `LOCAL_CHAT_COMMANDS` and invokes `LOCAL_COMMAND_HANDLERS[canonical]`, with no command-name `switch` left in the new dispatch path ([SPEC/v2/review-2026-05/F30/03-plan-r2.md](SPEC/v2/review-2026-05/F30/03-plan-r2.md#L95-L126)). `npm run typecheck` is the canonical drift guard, which is the right enforcement point for the registry/handler invariant ([SPEC/v2/review-2026-05/F30/03-plan-r2.md](SPEC/v2/review-2026-05/F30/03-plan-r2.md#L184), [SPEC/v2/review-2026-05/F30/03-plan-r2.md](SPEC/v2/review-2026-05/F30/03-plan-r2.md#L280-L286)).

The plan also handles the F18 ordering gap: if the registry has not landed yet in [src/agents/conventions.ts](src/agents/conventions.ts#L1-L90), F30 adds the same `LOCAL_CHAT_COMMANDS` shape itself and exports `LocalChatCommandName` ([SPEC/v2/review-2026-05/F30/03-plan-r2.md](SPEC/v2/review-2026-05/F30/03-plan-r2.md#L14-L20), [SPEC/v2/review-2026-05/F30/03-plan-r2.md](SPEC/v2/review-2026-05/F30/03-plan-r2.md#L26-L58)). That makes the plan executable against the current tree.

No literal emoji remains in the generated r2 documents. The existing note reply glyph at [src/agents/chat.ts](src/agents/chat.ts#L480) is referenced by Unicode name and codepoint only, and the replacement reply is specified as `Note created:` ([SPEC/v2/review-2026-05/F30/03-plan-r2.md](SPEC/v2/review-2026-05/F30/03-plan-r2.md#L5-L8), [SPEC/v2/review-2026-05/F30/03-plan-r2.md](SPEC/v2/review-2026-05/F30/03-plan-r2.md#L186-L187)).

## Required changes

None.

## Strengths

- The r1 core objection is fixed structurally, not patched with a regex guard.
- The plan preserves the memory/skill handler boundary and the current two-tier command order.
- The validation commands include typecheck, build, focused Vitest coverage, broader chat tests, full tests, and lint.

VERDICT: APPROVED