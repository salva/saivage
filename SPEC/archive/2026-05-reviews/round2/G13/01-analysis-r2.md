# G13 — Functional analysis (round 2)

**Finding:** [SPEC/v2/review-2026-05-round2/G13-conventions-file-mixes-two-concerns.md](../G13-conventions-file-mixes-two-concerns.md)
**Subsystem map row:** Agents + Chat — see [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)
**Round 1:** [01-analysis-r1.md](01-analysis-r1.md)
**R1 review:** [04-review-r1.md](04-review-r1.md)

## R2 deltas vs r1

- §1 corrected: `checkConvention` is **not** wired into production runtime. [src/agents/base.ts](../../../../src/agents/base.ts#L35) holds only an unused import; the only call sites are unit tests. The r1 claim of a write-guard inside `BaseAgent.executeTool` was wrong.
- §3 updated: the unused import at [src/agents/base.ts](../../../../src/agents/base.ts#L35) is now in-scope for removal.
- §4 updated: dead-code removal rule made explicit for this finding.
- §5 unchanged.

## 1. What the code does today

[src/agents/conventions.ts](../../../../src/agents/conventions.ts) bundles two unrelated surfaces:

- **Territory rules.** [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L11-L58) declares `ConventionRule`, projects `ROSTER` into a `Partial<Record<AgentRole, ConventionRule>>`, and exports `checkConvention(role, filePath)` at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L32) and `getConvention(role)`. A full-source search for `checkConvention(` finds only the export at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L32) and the unit-test calls in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L36-L86). There is **no production call site**. [src/agents/base.ts](../../../../src/agents/base.ts#L35) imports `checkConvention` but never invokes it — the import is dead code. `getConvention` is consumed by [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24-L130). The `ConventionRule` type is also referenced by [src/agents/roster.ts](../../../../src/agents/roster.ts#L11-L31) as a type-only import (each roster entry owns its territory).
- **Local chat-command registry.** [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L60-L93) declares `LocalChatCommand`, the `LOCAL_CHAT_COMMANDS` literal array (with its JSDoc at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L66-L71)), the `LocalChatCommandName` literal-union, and `renderLocalChatCommandsTable()`. Consumed by [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L14) (template substitution of `{{slash_commands_table}}` in `prompts/chat.md`), by [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L11-L14) (dispatcher table keyed by `LocalChatCommandName`, plus `resolveLocalCommand` and `renderLocalHelp` via `LOCAL_CHAT_COMMANDS`), and by three test files: [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L18-L21), [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts#L10-L13), and [src/agents/prompts.test.ts](../../../../src/agents/prompts.test.ts#L11).

## 2. Why the mix is wrong

- **No domain overlap.** Territory rules constrain *agent write actions on the project filesystem*; the chat-command registry catalogues *local non-LLM slash commands accepted by ChatAgent*. The two have disjoint inputs, consumers, lifecycle, and tests. There is no logic crossing the boundary.
- **Cross-layer import.** The subsystem map places `LOCAL_CHAT_COMMANDS` under the "Chat" subsystem ([00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) row "Chat") yet stores it in `src/agents/`. The current state forces the Chat subsystem to reach into Agents to pick up its own canonical registry — exactly the inversion a layered linter would flag.
- **Test geometry.** [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts) lives next to agent tests but exercises only the chat-command registry shape; co-locating it with the dispatcher tests in [src/chat/](../../../../src/chat/) would let a single grep over `src/chat/` find every chat-surface test. Today the catalogue tests are split across two directories for purely historical reasons.
- **Naming.** A file titled `conventions.ts` whose docblock reads "Per-agent territory definitions. Violation logging (warnings, not blocks)." silently owning a chat-command catalogue is a discoverability trap.

## 3. Scope of the fix

In-scope:

- The two halves of [src/agents/conventions.ts](../../../../src/agents/conventions.ts).
- The four real chat-registry import sites: [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L14), [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L11-L14), [src/agents/prompts.test.ts](../../../../src/agents/prompts.test.ts#L11), [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L18-L21).
- The misplaced test [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts).
- The unused `checkConvention` import at [src/agents/base.ts](../../../../src/agents/base.ts#L35) — removed as dead code (architecture-first, no migration shims).

Out-of-scope:

- `ConventionRule` itself, and its consumption from [src/agents/roster.ts](../../../../src/agents/roster.ts#L11-L31) — already correctly placed in the agents layer.
- Restoring runtime convention enforcement. The territory checker has no production call site today; reintroducing one would require a concrete design with explicit tests and is not part of this finding.
- The dispatcher in [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts), the slash-command parser in [src/chat/slashCommands.ts](../../../../src/chat/slashCommands.ts), and the memory/skill family — those boundaries are correct.
- The `prompts/chat.md` template variable name `{{slash_commands_table}}` — value-only change, no template edit needed.

## 4. Constraints

- Architecture-first, no backward compatibility: no re-export shim in [src/agents/conventions.ts](../../../../src/agents/conventions.ts); the file ends with `getConvention` after the split.
- Remove dead code: the unused `checkConvention` import at [src/agents/base.ts](../../../../src/agents/base.ts#L35) is deleted as part of this fix (caught by [eslint.config.js](../../../../eslint.config.js#L11-L14) `no-unused-vars` once `npm run lint` runs).
- No new docstrings or comments in untouched code; the relocated symbols carry their existing JSDoc verbatim, and no new file-level header is added to the new registry module.
- No new tests beyond what the move implies (the existing tests retain full coverage after import-path updates and after `chat-commands.test.ts` moves into `src/chat/`).
- The fix must not change runtime behaviour: `/help` output and `renderLocalChatCommandsTable()` output stay byte-identical. Territory warning strings are also byte-identical — removing the unused import is a pure no-op at runtime because there is no current call site.

## 5. Risks if left as-is

- Future contributors who grep for "chat command" in `src/chat/` will miss the canonical registry and may add a parallel one.
- A subsequent reorganisation of `src/agents/` would either drag the chat surface along incorrectly or trigger a noisy import-graph fix in unrelated commits.
- The cross-layer import is a hidden coupling that prevents introducing a layer-boundary lint (e.g., dependency-cruiser ruleset).
- The dead `checkConvention` import at [src/agents/base.ts](../../../../src/agents/base.ts#L35) keeps falsely signalling that BaseAgent enforces territory at runtime, misleading future readers and reviewers (as it did in r1).
