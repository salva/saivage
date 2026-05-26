# G13 - Review of round 1

## Findings

### 1. CHANGES_REQUESTED - Round 1 invents an active BaseAgent convention consumer and preserves the unused import

The analysis says the territory side of [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L11-L58) is called from [src/agents/base.ts](../../../../src/agents/base.ts#L35) as write-guard warnings inside `BaseAgent.executeTool` ([SPEC/v2/review-2026-05-round2/G13/01-analysis-r1.md](01-analysis-r1.md#L10)). That is not true in the current source. [src/agents/base.ts](../../../../src/agents/base.ts#L35) imports `checkConvention`, but a full source search for `checkConvention(` only finds the export at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L32) and the convention unit-test calls in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L36-L86). There is no production call site.

The plan then turns that mistaken edge into intentional final architecture: it says [src/agents/base.ts](../../../../src/agents/base.ts#L35) should keep the `checkConvention` import ([SPEC/v2/review-2026-05-round2/G13/03-plan-r1.md](03-plan-r1.md#L109-L112)) and expects the post-split negative grep to still find [src/agents/base.ts](../../../../src/agents/base.ts#L35) among remaining conventions module consumers ([SPEC/v2/review-2026-05-round2/G13/03-plan-r1.md](03-plan-r1.md#L158-L163)). That leaves a stale dependency from BaseAgent to the conventions module and preserves a false story about runtime convention enforcement.

This matters for architecture-first cleanup. The repository has a lint script at [package.json](../../../../package.json#L20), and unused variables are errors in [eslint.config.js](../../../../eslint.config.js#L11-L14), but the validation plan only runs typecheck, focused tests, full tests, and build ([SPEC/v2/review-2026-05-round2/G13/03-plan-r1.md](03-plan-r1.md#L118-L151)). Round 2 should correct the consumer map, remove the unused import from [src/agents/base.ts](../../../../src/agents/base.ts#L35), update the expected remaining conventions imports accordingly, and add `npm run lint` to validation. If the desired end state is to restore runtime convention checks, that needs to be designed explicitly with a concrete call site and tests; R1 cannot assume that behavior already exists.

### 2. CHANGES_REQUESTED - The new registry file should be a literal move, not an extra explanatory docblock

R1 states that relocated symbols should carry their existing JSDoc verbatim ([SPEC/v2/review-2026-05-round2/G13/01-analysis-r1.md](01-analysis-r1.md#L36-L39)) and the plan describes [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L60-L93) as a verbatim move into the new chat registry ([SPEC/v2/review-2026-05-round2/G13/03-plan-r1.md](03-plan-r1.md#L10-L12)). Immediately after that, E1 adds a new file-level header docblock ([SPEC/v2/review-2026-05-round2/G13/03-plan-r1.md](03-plan-r1.md#L12-L27)). The extra header repeats information already carried by the existing `LOCAL_CHAT_COMMANDS` JSDoc in [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L66-L71), and it is not needed for the architectural split.

This is smaller than the BaseAgent issue, but it should be tightened before implementation. The clean move is: create the registry module, move the existing interface, array, type, and renderer, keep the existing registry JSDoc, and do not add a second explanatory comment block unless there is a concrete local convention requiring module headers.

## What is solid

The recommended split itself is the right direction. Moving `LocalChatCommand`, `LOCAL_CHAT_COMMANDS`, `LocalChatCommandName`, and `renderLocalChatCommandsTable` into a pure chat-owned leaf module matches the subsystem map's Chat ownership and avoids making [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L15-L17) the dependency target for prompt loading. The no-shim stance is also correct for the project rules, and the planned import updates cover the real chat-registry consumers in [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L14-L61), [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L12-L14), [src/agents/prompts.test.ts](../../../../src/agents/prompts.test.ts#L11-L49), [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L19-L21), and [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts#L10-L34).

## Required round-2 changes

- Correct the analysis to say the territory checker is not currently wired into production runtime; [src/agents/base.ts](../../../../src/agents/base.ts#L35) has only an unused import.
- Add an implementation step to remove that unused import, and update the post-split grep expectation so the remaining [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L11-L58) consumers are [src/agents/roster.ts](../../../../src/agents/roster.ts#L11-L31), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10-L86), and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24-L130).
- Add `npm run lint` to validation, preferably before build, so stale imports are caught by [eslint.config.js](../../../../eslint.config.js#L11-L14).
- Remove the proposed new file-level registry docblock, or justify it as a deliberate local convention rather than calling the move verbatim.

VERDICT: CHANGES_REQUESTED