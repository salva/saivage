# F30 — Analysis r1

## Problem restated

The Chat agent's slash-command surface is hand-typed in **three** places that already disagree:

1. The system prompt's "Slash Commands" Markdown section at [src/agents/chat.ts](src/agents/chat.ts#L99-L109).
2. The dispatch `switch` in `tryHandleCommand` at [src/agents/chat.ts](src/agents/chat.ts#L335-L361).
3. The `/help` Markdown table emitted by `cmdHelp` at [src/agents/chat.ts](src/agents/chat.ts#L364-L389).

Adding a command, renaming one, or wiring an alias requires three coordinated edits in the same file, and the three lists drift in practice.

## Scope and the F18 boundary

F30 sits downstream of F18. Per [F18/02-design-r2.md](../F18/02-design-r2.md#L24-L57), F18 introduces a declarative registry for the **local-Chat command family only**:

```ts
// src/agents/conventions.ts (added by F18)
export interface LocalChatCommand { name; aliases?; usage; help; }
export const LOCAL_CHAT_COMMANDS: LocalChatCommand[]; // 9 entries
export function renderLocalChatCommandsTable(): string;
```

F18 wires this into the **prompt** via a `{{slash_commands_table}}` placeholder and explicitly leaves the duplication between source (2) and source (3) for F30 to close. After F18 lands, the prompt-text copy of the command list is gone; F30 closes the remaining duplication between the dispatch `switch` and the `cmdHelp` Markdown table by making both consume `LOCAL_CHAT_COMMANDS`.

The **memory/skill family** (`/skills`, `/memories`, `/remember`, `/forget`) is owned by another agent and is **out of scope** for F30:

- The handler hook at [src/agents/chat.ts](src/agents/chat.ts#L304-L334) (`parseSlashCommand` / `runSlashCommand`) is not touched.
- The router module at [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L40-L80) is not touched.
- The seven memory/skill rows in `cmdHelp` at [src/agents/chat.ts](src/agents/chat.ts#L379-L385) are not refactored into `LOCAL_CHAT_COMMANDS`. They remain a hand-coded suffix block whose content is owned by the skills/memory agent; F30 only ensures the LOCAL rows above them are auto-generated.

## Actual differences between the three lists (today)

The nine local commands as they appear in each source:

| Command | Prompt §Slash Commands (1) | `switch` (2) | `cmdHelp` table (3) |
| --- | --- | --- | --- |
| `/help` | listed, no `[reason]` | case present | row present |
| `/status` | listed | case present | row present |
| `/plan` | listed | case present | row present |
| `/history` | listed, no `[n]` arg shown | case present | row shown as `/history [n]` |
| `/replan` | listed, no `[reason]` arg shown | case present | row shown as `/replan [reason]` |
| `/restart-planner` | listed with `[reason]` | case present | row shown with `[reason]` |
| `/planner-restart` (alias) | **NOT listed** | **case present** as fallthrough alias | **NOT listed** |
| `/note` | listed with `<text>` | case present | row shown as `/note <msg>` |
| `/note!` | listed with `<text>` | case present | row shown as `/note! <msg>` |
| `/notep` | listed with `<text>` | case present | row shown as `/notep <msg>` |

Concrete disagreements:
- `/planner-restart` is wired in source (2) at [src/agents/chat.ts](src/agents/chat.ts#L351) but absent from both (1) and (3) — F30 issue note confirms this.
- `/history` and `/replan` argument labels differ between the prompt and the help table.
- The note commands' argument placeholder is `<text>` in the prompt and `<msg>` in the help table.

## Contract

`tryHandleCommand` at [src/agents/chat.ts](src/agents/chat.ts#L297-L362):

- **Input**: a string that may or may not start with `/`.
- **Output**: `Promise<string | null>` — string means "handled, this is the reply"; null means "not a recognized command, fall through to the LLM".
- **Two-tier dispatch**:
  1. Try `parseSlashCommand(content)` from [src/chat/slashCommands.ts](src/chat/slashCommands.ts#L40). If it returns a `ParsedCommand`, route to `runSlashCommand` (memory/skill family). Errors are caught and returned as `"Error: ..."` strings — never re-thrown.
  2. Otherwise, split `content` on the first space into `cmd` (lowercased) and `args`. Switch on `cmd`. Default returns `null`.
- **Per-command handler shape**: `(args: string) => string | Promise<string>`. Five of nine handlers ignore `args`; four (`/history`, `/replan`, `/note`, `/note!`, `/notep`, `/restart-planner`) consume it.
- **Argument validation**: `/note`, `/note!`, `/notep` short-circuit with a usage string when `args` is empty; the others happily accept `""`.
- **Lifecycle**: `tryHandleCommand` runs once per inbound user message, on the same async serialised queue as the LLM path ([src/agents/chat.ts](src/agents/chat.ts#L195-L210)). No state is shared between commands.

`cmdHelp` at [src/agents/chat.ts](src/agents/chat.ts#L364-L389):

- **Input**: none.
- **Output**: a Markdown document with a header line, a Markdown table of 9 local rows followed by 7 memory/skill rows, and a closing line.
- **No side effects.**

## Call sites & dependencies

- `tryHandleCommand` is called from `handleUserMessage` at [src/agents/chat.ts](src/agents/chat.ts#L249). It is the only call site.
- `cmdHelp` is called from the `/help` case at [src/agents/chat.ts](src/agents/chat.ts#L337). It is the only call site.
- `cmdNote` is called from `/replan`, `/note`, `/note!`, `/notep`. `cmdRestartPlanner` is called from `/restart-planner`, `/planner-restart`, and from `tryHandleExplicitPlannerRestart` at [src/agents/chat.ts](src/agents/chat.ts#L501-L505) (a separate code path for natural-language restart requests — NOT a slash command). F30 does not touch `tryHandleExplicitPlannerRestart`.
- After F18, `LOCAL_CHAT_COMMANDS` is also consumed by `renderLocalChatCommandsTable()` for the prompt placeholder. F30 will add `cmdHelp` and the dispatch path as further consumers — no other readers.
- No tests currently exist for `chat.ts` (no `src/agents/chat.test.ts`); the only slash-command tests are at [src/chat/slashCommands.test.ts](src/chat/slashCommands.test.ts) and they cover only the memory/skill family. F30 will add the missing local-command tests.

## Constraints any solution must respect

1. **Out of scope, do not cross**: `src/skills/`, `src/chat/slashCommands.ts`, `parseSlashCommand`/`runSlashCommand`, and the four memory/skill rows in `cmdHelp`. Per loop convention §Out-of-scope and the F30 prompt scope note.
2. **Architecture-first, no backward compatibility** ([loop convention §Mandatory](../_LOOP-CONVENTIONS.md#mandatory-project-guidelines-apply-to-every-proposal)). When the dispatch table replaces the `switch`, the `switch` is deleted in the same change. No alias preserving the old hand-coded path.
3. **No new docstrings** on code F30 is not otherwise editing.
4. **Two-tier dispatch must be preserved**: memory/skill family first (via `parseSlashCommand`), then local family. F30 may not reorder these tiers; reordering could capture `/skills list` etc. wrongly if the local table ever grew a `/skills` entry (it must not, but the ordering invariant is a safety net).
5. **Handler signatures must accommodate sync and async**: `/help`, `/status`, `/plan`, `/history` are synchronous today; `/replan`, `/restart-planner`, `/note`, `/note!`, `/notep` return `Promise<string>`. A single registry-driven dispatcher must accept both.
6. **The `string | null` contract of `tryHandleCommand` must be preserved**: unrecognised slash commands fall through to the LLM. The LLM-fallthrough behaviour is what makes natural-language usage feasible; do not convert it to an error.
7. **Argument handling per command must be preserved verbatim**: the `/replan` default-reason string at [src/agents/chat.ts](src/agents/chat.ts#L345-L348), the empty-args usage strings for `/note`/`/note!`/`/notep`, the case-insensitive command matching (`.toLowerCase()` at [src/agents/chat.ts](src/agents/chat.ts#L333)), and the alias semantics where `/planner-restart` dispatches identically to `/restart-planner` must all carry over.
8. **F18 ordering**: F30 lands AFTER F18. If F18 has not landed when F30 begins, F30 introduces `LOCAL_CHAT_COMMANDS` itself (same shape as F18's design specifies) and F18 then merges into it. The plan documents this dependency explicitly.
9. **`LOCAL_CHAT_COMMANDS` location**: F18 places it in `src/agents/conventions.ts`. F30 will not relocate it during F30's own change — relocation, if any, is a separate concern. (Proposal B notes this as a follow-up but does not act on it.)
