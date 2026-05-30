# F30 — Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F30-chat-slash-commands-triplicated.md](SPEC/v2/review-2026-05/F30-chat-slash-commands-triplicated.md)
- [SPEC/v2/review-2026-05/F30/01-analysis-r1.md](SPEC/v2/review-2026-05/F30/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F30/02-design-r1.md](SPEC/v2/review-2026-05/F30/02-design-r1.md)
- [SPEC/v2/review-2026-05/F30/03-plan-r1.md](SPEC/v2/review-2026-05/F30/03-plan-r1.md)
- Spot-checks: [src/agents/chat.ts](src/agents/chat.ts#L99-L110), [src/agents/chat.ts](src/agents/chat.ts#L297-L389), [src/agents/chat.ts](src/agents/chat.ts#L483-L505), [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L38-L82)

## Findings

### Analysis

The analysis correctly identifies the current three copies of the local Chat command surface: prompt text, the local `switch`, and `/help` rows. The two-tier dispatch boundary is also correct: the memory/skill family is parsed first by [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L38-L82), then the local command switch runs in [src/agents/chat.ts](src/agents/chat.ts#L331-L361).

There is one factual cleanup needed. [SPEC/v2/review-2026-05/F30/01-analysis-r1.md](SPEC/v2/review-2026-05/F30/01-analysis-r1.md#L83) says there are "four memory/skill rows" in `cmdHelp`, but the actual table has seven rows at [src/agents/chat.ts](src/agents/chat.ts#L379-L385). The earlier analysis text says seven, so this is likely just wording drift; fix it to "seven rows" or "four command roots".

### Design

The selected direction, Proposal B, is architecturally better than leaving the local command family embedded in `ChatAgent`. It preserves the memory/skill boundary and makes local command behavior testable without constructing a full agent instance.

However, the recommended design does not yet fully satisfy F30's root cause. The design claims both proposals eliminate duplication between dispatch and help ([SPEC/v2/review-2026-05/F30/02-design-r1.md](SPEC/v2/review-2026-05/F30/02-design-r1.md#L3-L5)), but the recommended implementation plan still keeps a second authoritative list of command names in dispatch. Moving that list from [src/agents/chat.ts](src/agents/chat.ts#L335-L361) to a new module is useful factoring, but not enough for this issue unless the handler binding is structurally tied to `LOCAL_CHAT_COMMANDS`.

### Plan

The plan's proposed `dispatchLocalCommand` resolves the command through `LOCAL_CHAT_COMMANDS`, then switches over every canonical command name again in [SPEC/v2/review-2026-05/F30/03-plan-r1.md](SPEC/v2/review-2026-05/F30/03-plan-r1.md#L108-L122). That still leaves command names duplicated between the registry and dispatch. The tests catch some drift by iterating `LOCAL_CHAT_COMMANDS` ([SPEC/v2/review-2026-05/F30/03-plan-r1.md](SPEC/v2/review-2026-05/F30/03-plan-r1.md#L220-L225)), but tests are a regression net, not the single source of truth the issue calls for.

The structural guard also only checks that `src/agents/chat.ts` no longer contains command cases ([SPEC/v2/review-2026-05/F30/03-plan-r1.md](SPEC/v2/review-2026-05/F30/03-plan-r1.md#L234-L237)). It would still allow the same stringly command switch to live permanently in [src/chat/localCommands.ts](src/chat/localCommands.ts), which is exactly where Proposal B places it.

Finally, [SPEC/v2/review-2026-05/F30/03-plan-r1.md](SPEC/v2/review-2026-05/F30/03-plan-r1.md#L178) includes a literal emoji while citing the existing note response. The loop convention says no emojis anywhere in generated review documents. Reword that note without embedding the character.

## Required changes

1. Revise Proposal B and the plan so local command dispatch is structurally tied to `LOCAL_CHAT_COMMANDS`, not a separate `switch (c.name)` list. Acceptable shapes include adding an action/handler key to the registry, or exporting a literal `LocalChatCommandName` type from the registry and using a `satisfies Record<LocalChatCommandName, LocalCommandHandler>` handler table so `npm run typecheck` fails on drift. The revised tests should cover the new invariant and should not merely check that `chat.ts` lacks cases.
2. Update the structural guard section to cover the new module as well, or replace it with type-level coverage plus a focused test that proves every registry entry dispatches and no extra local command rows are hand-authored.
3. Fix the memory/skill row count wording in the analysis constraints.
4. Remove the literal emoji from the plan document text while still documenting the intentional user-visible string change, if the writer keeps that change.

## Strengths

- The scope boundary around [src/chat/slashCommands.ts](src/chat/slashCommands.ts) is correct and should stay in the next round.
- The proposed `LocalCommandContext` keeps the new module testable without making it read project state directly.
- The validation commands use the repo's Vitest/typecheck/build conventions and include a focused test plus broader regression runs.

VERDICT: CHANGES_REQUESTED