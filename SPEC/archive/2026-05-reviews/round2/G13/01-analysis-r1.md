# G13 — Functional analysis (round 1)

**Finding:** [SPEC/v2/review-2026-05-round2/G13-conventions-file-mixes-two-concerns.md](../G13-conventions-file-mixes-two-concerns.md)
**Subsystem map row:** Agents + Chat — see [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)

## 1. What the code does today

[src/agents/conventions.ts](../../../../src/agents/conventions.ts) bundles two unrelated surfaces:

- **Territory rules.** [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L11-L58) declares `ConventionRule`, projects `ROSTER` into a `Partial<Record<AgentRole, ConventionRule>>`, and exports `checkConvention(role, filePath)` and `getConvention(role)`. Called only from [src/agents/base.ts](../../../../src/agents/base.ts#L35) (write-guard warnings inside `BaseAgent.executeTool`) and from the territory tests in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10) and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24). The `ConventionRule` type is also referenced by [src/agents/roster.ts](../../../../src/agents/roster.ts#L11) as a type-only import (each roster entry owns its territory).
- **Local chat-command registry.** [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L60-L93) declares `LocalChatCommand`, the `LOCAL_CHAT_COMMANDS` literal array, the `LocalChatCommandName` literal-union, and `renderLocalChatCommandsTable()`. Consumed by [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L14) (template substitution of `{{slash_commands_table}}` in `prompts/chat.md`), by [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L11-L14) (dispatcher table keyed by `LocalChatCommandName`, plus `resolveLocalCommand` and `renderLocalHelp` via `LOCAL_CHAT_COMMANDS`), and by three test files: [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L18-L21), [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts#L10-L13), and [src/agents/prompts.test.ts](../../../../src/agents/prompts.test.ts#L11).

## 2. Why the mix is wrong

- **No domain overlap.** Territory rules constrain *agent write actions on the project filesystem*; the chat-command registry catalogues *local non-LLM slash commands accepted by ChatAgent*. The two have disjoint inputs, consumers, lifecycle, and tests. There is no logic crossing the boundary.
- **Cross-layer import.** The subsystem map places `LOCAL_CHAT_COMMANDS` under the "Chat" subsystem ([00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) row "Chat") yet stores it in `src/agents/`. The current state forces the Chat subsystem to reach into Agents to pick up its own canonical registry — exactly the inversion a layered linter would flag.
- **Test geometry.** [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts) lives next to agent tests but exercises only the chat-command registry shape; co-locating it with the dispatcher tests in [src/chat/](../../../../src/chat/) would let a single grep over `src/chat/` find every chat-surface test. Today the catalogue tests are split across two directories for purely historical reasons.
- **Naming.** A file titled `conventions.ts` whose docblock reads "Per-agent territory definitions. Violation logging (warnings, not blocks)." silently owning a chat-command catalogue is a discoverability trap.

## 3. Scope of the fix

In-scope:

- The two halves of [src/agents/conventions.ts](../../../../src/agents/conventions.ts).
- The five import sites listed in §1.
- The misplaced test [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts).

Out-of-scope:

- `ConventionRule` itself, and its consumption from [src/agents/roster.ts](../../../../src/agents/roster.ts#L11) — already correctly placed in the agents layer.
- The dispatcher in [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts), the slash-command parser in [src/chat/slashCommands.ts](../../../../src/chat/slashCommands.ts), and the memory/skill family — those boundaries are correct.
- The `prompts/chat.md` template variable name `{{slash_commands_table}}` — value-only change, no template edit needed.

## 4. Constraints

- Architecture-first, no backward compatibility: no re-export shim in `src/agents/conventions.ts`; the file ends with `getConvention` after the split.
- No new docstrings or comments in untouched code; the relocated symbols carry their existing JSDoc verbatim.
- No new tests beyond what the move implies (the existing tests retain full coverage after import-path updates and after `chat-commands.test.ts` moves into `src/chat/`).
- The fix must not change runtime behaviour: `/help` output, `renderLocalChatCommandsTable()` output, and `checkConvention` warning strings stay byte-identical.

## 5. Risks if left as-is

- Future contributors who grep for "chat command" in `src/chat/` will miss the canonical registry and may add a parallel one.
- A subsequent reorganisation of `src/agents/` would either drag the chat surface along incorrectly or trigger a noisy import-graph fix in unrelated commits.
- The cross-layer import is a hidden coupling that prevents introducing a layer-boundary lint (e.g., dependency-cruiser ruleset).
