# G13 — Design (round 2)

**Analysis:** [01-analysis-r2.md](01-analysis-r2.md)
**Round 1:** [02-design-r1.md](02-design-r1.md)
**R1 review:** [04-review-r1.md](04-review-r1.md)

## R2 deltas vs r1

- Module-boundaries table: the post-split row for [src/agents/base.ts](../../../../src/agents/base.ts) no longer imports from `./conventions.js` (unused import removed).
- Direction unchanged: Proposal A (extract `LocalChatCommand` registry into a chat-owned leaf module).
- No file-level explanatory docblock is added to the new module; the existing `LOCAL_CHAT_COMMANDS` JSDoc at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L66-L71) moves verbatim and is the only documentation in the new file. This honours the "no new docstrings or comments in untouched code" rule for a verbatim move.

## Proposal A (recommended) — Extract registry into a leaf module under `src/chat/`

Create a new file `src/chat/localCommandRegistry.ts` that owns the entire chat-command catalogue surface: `LocalChatCommand`, `LOCAL_CHAT_COMMANDS`, `LocalChatCommandName`, and `renderLocalChatCommandsTable`. The file has zero runtime imports — it is a pure-data leaf. Delete the second half of [src/agents/conventions.ts](../../../../src/agents/conventions.ts) (no re-export shim, per the architecture-first rule). Also remove the unused `checkConvention` import from [src/agents/base.ts](../../../../src/agents/base.ts#L35) — this is dead code with no current production call site.

### Module boundaries after the change

| Module | Owns | Imports |
|---|---|---|
| [src/agents/conventions.ts](../../../../src/agents/conventions.ts) | `ConventionRule`, `checkConvention`, `getConvention` | `./types.js`, `./roster.js`, `../log.js` (unchanged) |
| `src/chat/localCommandRegistry.ts` (new) | `LocalChatCommand`, `LOCAL_CHAT_COMMANDS`, `LocalChatCommandName`, `renderLocalChatCommandsTable` | (none) |
| [src/agents/base.ts](../../../../src/agents/base.ts) | unchanged behaviour | drops the unused `./conventions.js` import |
| [src/agents/prompts.ts](../../../../src/agents/prompts.ts) | unchanged behaviour | swap `./conventions.js` → `../chat/localCommandRegistry.js` for `renderLocalChatCommandsTable` |
| [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts) | unchanged behaviour | swap `../agents/conventions.js` → `./localCommandRegistry.js` |

### Why this passes the layering check

- `src/chat/localCommandRegistry.ts` is a pure data leaf: no imports at all. Any layer is free to depend on it without inducing a cycle.
- The single remaining cross-namespace edge is `src/agents/prompts.ts → src/chat/localCommandRegistry.ts`. That is the right direction: the chat surface owns its own catalogue, and the prompt loader (a presentation concern that happens to live next to agents because the agents own their system-prompt assembly) reads from it. The alternative direction — chat reaching into agents for a chat-only registry — is the inversion the finding flags.
- No circular import: [src/agents/roster.ts](../../../../src/agents/roster.ts#L11) continues its type-only import of `ConventionRule` from `./conventions.js`; [src/agents/conventions.ts](../../../../src/agents/conventions.ts) continues to import `ROSTER` from `./roster.js`. The split removes content from `conventions.ts`, not from this pair.
- After the cleanup, the remaining consumers of [src/agents/conventions.ts](../../../../src/agents/conventions.ts) are exactly [src/agents/roster.ts](../../../../src/agents/roster.ts#L11-L31) (type-only), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10-L86), and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24-L130).

### Test relocations

- Move [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts) to `src/chat/localCommandRegistry.test.ts` and rewrite the import from `./conventions.js` to `./localCommandRegistry.js`. The test exercises the registry shape and `renderLocalChatCommandsTable`; it belongs next to the registry.
- [src/agents/prompts.test.ts](../../../../src/agents/prompts.test.ts#L11) — swap import to `../chat/localCommandRegistry.js`.
- [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L18-L21) — swap import from `../agents/conventions.js` to `./localCommandRegistry.js`.
- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10) and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24) — unchanged (they only import territory symbols).

### Behavioural invariants

- `renderLocalChatCommandsTable()` returns the same string (same array, same `.map(...).join("\n")`).
- `LocalChatCommandName` resolves to the same literal union; the `satisfies Record<LocalChatCommandName, LocalCommandHandler>` constraint in [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L57) keeps the drift guard intact.
- `checkConvention` warning strings are untouched. Removing the unused import from [src/agents/base.ts](../../../../src/agents/base.ts#L35) is a pure no-op at runtime: there is no current call site, only test-only consumers in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L36-L86).
- The `{{slash_commands_table}}` substitution in [prompts/chat.md](../../../../prompts/chat.md) still renders byte-identical output.

## Proposal B (rejected) — Fold the registry into the existing dispatcher file

Variant: delete the second half of [src/agents/conventions.ts](../../../../src/agents/conventions.ts) and inline `LOCAL_CHAT_COMMANDS`, `LocalChatCommandName`, and `renderLocalChatCommandsTable` directly into [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts) (next to `MEMORY_SKILL_HELP_ROWS` and `LOCAL_COMMAND_HANDLERS`). One fewer file; no new module.

**Why rejected:**

1. Pulls heavy transitive surface into [src/agents/prompts.ts](../../../../src/agents/prompts.ts). [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts) imports `../runtime/notes.js` (for `createUserNote`), and `type`-imports `../events/bus.js` and `../server/bootstrap.js`. Even type-only imports thread the prompt loader's dependency view through three subsystems it has no business knowing about; runtime-only imports of `runtime/notes.js` would also be dragged into any module that needs the registry. A pure leaf module avoids that.
2. Mixes catalogue (declarative, no behaviour, no IO) with dispatcher (handlers, async note creation, planner-control wiring). The split into a dedicated registry file makes the catalogue greppable, diffable in isolation, and snapshot-test-friendly. That is precisely the kind of separation the finding asks for; collapsing both halves into one chat-side file would only relocate the original mix, not resolve it.
3. The test surface stays partly entangled: shape tests for `LOCAL_CHAT_COMMANDS` and the help renderer would live in the same file as the dispatch tests ([src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts)), forcing one test file to assert on two distinct concerns. Proposal A keeps them in separate files.
4. The "one level up" reframing — "chat commands are part of the dispatcher; delete the registry as a concept" — is not actually a level up; it is sideways with worse coupling. There is no broader abstraction available that subsumes both `LOCAL_CHAT_COMMANDS` and `ConventionRule`. The honest "level-up" alternative would be a generic "agent capability registry" — which would be over-engineering for two tiny tables and is explicitly forbidden by the project rules.

## Recommendation

Adopt Proposal A. It removes the mixed-concerns file the finding identifies, keeps both new locations minimal (one pure-data leaf plus the unchanged dispatcher), respects layering by giving the chat namespace ownership of its own registry, removes the dead `checkConvention` import that misled r1, and leaves runtime behaviour byte-identical. Detailed edits in [03-plan-r2.md](03-plan-r2.md).
