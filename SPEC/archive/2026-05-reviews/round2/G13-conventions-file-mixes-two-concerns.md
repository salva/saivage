# G13 — `agents/conventions.ts` mixes territory rules with the chat-command registry

**Subsystem:** src/agents/
**Category:** module boundaries / organization
**Severity:** low
**Transversality:** local

## Summary

`src/agents/conventions.ts` is documented as "Per-agent territory definitions. Violation logging (warnings, not blocks)." but in practice the file also owns the canonical `LOCAL_CHAT_COMMANDS` registry, the `LocalChatCommandName` type, and the `renderLocalChatCommandsTable` helper that drives `/help` rendering. These two responsibilities have no domain overlap and have separate test surfaces, separate consumers (conventions → write-territory checks in `BaseAgent.executeTool`; commands → `dispatchLocalCommand` and the prompt-loader). The mix forces `src/agents/prompts.ts` and `src/chat/localCommands.ts` to import the chat-command surface *from a module about file-write conventions*, which is a cross-layer dependency that won't survive any future module reorganisation cleanly.

## Evidence

[src/agents/conventions.ts](src/agents/conventions.ts) — first half is the territory checker:

```ts
export interface ConventionRule { writeTerritory: string[]; excludeTerritory: string[]; description: string; }
const CONVENTIONS = ... ROSTER.filter(e => e.convention !== null) ...
export function checkConvention(role, filePath): string | null { ... }
export function getConvention(role): ConventionRule | null { ... }
```

Second half is the chat-command registry:

```ts
export interface LocalChatCommand { name; aliases?; usage; help; }
export const LOCAL_CHAT_COMMANDS = [ /help, /status, /plan, /history, /replan,
  /restart-planner, /note, /note!, /notep ] as const satisfies readonly LocalChatCommand[];
export type LocalChatCommandName = (typeof LOCAL_CHAT_COMMANDS)[number]["name"];
export function renderLocalChatCommandsTable(): string { ... }
```

Cross-layer imports caused by the mix:

- [src/agents/prompts.ts](src/agents/prompts.ts#L15) imports `renderLocalChatCommandsTable` from `./conventions.js` — the prompt loader (a presentation concern) reaches into the file-write-policy module to find the chat command list.
- [src/chat/localCommands.ts](src/chat/localCommands.ts#L13-L15) imports `LOCAL_CHAT_COMMANDS` and `LocalChatCommandName` from `../agents/conventions.js` — the chat command dispatcher (a UI concern) imports from the agents/territory module.

Neither consumer cares about file-write territory rules. Neither would be touched by a change to `ConventionRule`. The bundling is purely historical.

## Why this matters

- Mixed responsibilities make the file hard to grep, hard to test in isolation, and hard to extract when (e.g.) the chat-command surface grows enough to warrant its own module.
- The chat-command registry has nontrivial domain logic (alias resolution, help rendering, naming conventions like `/note!`). It deserves its own module name where future readers expect to find it (`src/chat/registry.ts` or `src/agents/localCommands.ts`).
- The cross-layer import from `src/chat/` into `src/agents/` for a registry that has no agent semantics is exactly the kind of thing a layered-architecture lint would flag.

## Rough remediation direction

1. Split into `src/agents/conventions.ts` (territory rules only) and `src/chat/localCommandRegistry.ts` (the `LOCAL_CHAT_COMMANDS` array, `LocalChatCommandName` type, and `renderLocalChatCommandsTable`).
2. Update the two import sites: `prompts.ts` and `chat/localCommands.ts`.
3. Re-test `/help` rendering and conventions warnings to confirm no behaviour change.

Architecture-first / no-backward-compat: do not leave a re-export shim in the old file.

## Cross-links

- Adjacent to G05 (worker agents share a base but their message builders are split into 5 files) — the codebase has a tendency to mis-place module boundaries; this is the smaller, easier instance.
