# F30 — Design r1

Two proposals. Both eliminate the duplication between the `switch` in `tryHandleCommand` and the `cmdHelp` Markdown table, both consume the `LOCAL_CHAT_COMMANDS` registry that F18 introduces in [src/agents/conventions.ts](src/agents/conventions.ts), and both leave the memory/skill family (`parseSlashCommand` / `runSlashCommand`) and the corresponding `cmdHelp` rows untouched.

Proposal A is the minimum completion of F18: keep dispatch inside `ChatAgent`, drive `cmdHelp` from the registry. Proposal B is the level-up: lift the entire local-command surface (dispatch + help rendering) into a sibling module of [src/chat/slashCommands.ts](src/chat/slashCommands.ts), mirroring how the memory family is already factored.

---

## Proposal A — Dispatch map and table renderer inside `chat.ts`

### Scope (files touched)

- [src/agents/chat.ts](src/agents/chat.ts) — replace the `switch` body, replace the `cmdHelp` body. No other agent file. No new file.
- [src/agents/conventions.ts](src/agents/conventions.ts) — assumes F18's `LOCAL_CHAT_COMMANDS` and `LocalChatCommand` are present. No further edits.
- New test: [src/agents/chat.test.ts](src/agents/chat.test.ts) — covers dispatch, alias, help rendering.

### What gets added

1. A module-level constant in `chat.ts`, right above the `ChatAgent` class:

   ```ts
   type LocalCommandHandler = (this: ChatAgent, args: string) => string | Promise<string>;

   const LOCAL_COMMAND_HANDLERS: Record<string, LocalCommandHandler> = {
     "/help":            function () { return this.cmdHelp(); },
     "/status":          function () { return this.cmdStatus(); },
     "/plan":            function () { return this.cmdPlan(); },
     "/history":         function (args) { return this.cmdHistory(args); },
     "/replan":          function (args) {
       return this.cmdNote(
         args || REPLAN_DEFAULT_REASON,
         false,
         true,
       );
     },
     "/restart-planner": function (args) { return this.cmdRestartPlanner(args); },
     "/note":            function (args) { return args ? this.cmdNote(args, false, false) : USAGE_NOTE; },
     "/note!":           function (args) { return args ? this.cmdNote(args, false, true)  : USAGE_NOTE_URGENT; },
     "/notep":           function (args) { return args ? this.cmdNote(args, true,  false) : USAGE_NOTEP; },
   };

   const REPLAN_DEFAULT_REASON = "User requests replanning. Re-evaluate the current plan, analyze what has failed or escalated, and create a new strategy to achieve the project objectives.";
   const USAGE_NOTE        = "Usage: `/note <message>` — create a note for the Planner.";
   const USAGE_NOTE_URGENT = "Usage: `/note! <message>` — create an **urgent** high-priority note.";
   const USAGE_NOTEP       = "Usage: `/notep <message>` — create a **permanent** note.";
   ```

   The keys correspond exactly to `LOCAL_CHAT_COMMANDS[*].name`. Aliases are resolved against the same map via a small helper:

   ```ts
   function resolveLocalCommand(cmd: string): string | undefined {
     for (const c of LOCAL_CHAT_COMMANDS) {
       if (c.name === cmd) return c.name;
       if (c.aliases?.includes(cmd)) return c.name;
     }
     return undefined;
   }
   ```

2. The dispatch block in `tryHandleCommand` at [src/agents/chat.ts](src/agents/chat.ts#L330-L361) shrinks to:

   ```ts
   const spaceIdx = content.indexOf(" ");
   const cmd  = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
   const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

   const canonical = resolveLocalCommand(cmd);
   if (!canonical) return null;
   return LOCAL_COMMAND_HANDLERS[canonical]!.call(this, args);
   ```

3. `cmdHelp` at [src/agents/chat.ts](src/agents/chat.ts#L364-L389) is rewritten to render the local rows from `LOCAL_CHAT_COMMANDS` and append the memory/skill rows as a static suffix array:

   ```ts
   private cmdHelp(): string {
     const localRows = LOCAL_CHAT_COMMANDS.map(c => `| \`${c.usage}\` | ${c.help} |`);
     const memoryRows = MEMORY_SKILL_HELP_ROWS; // module-level const, 7 strings, content owned by skills/memory agent
     return [
       "**Available Commands**",
       "",
       "| Command | Description |",
       "|---------|-------------|",
       ...localRows,
       ...memoryRows,
       "",
       "Any other message is handled by the AI assistant.",
     ].join("\n");
   }
   ```

### What gets removed

- The 27-line `switch` statement at [src/agents/chat.ts](src/agents/chat.ts#L335-L361). Deleted, no shim.
- The hand-typed 9-row local section of the Markdown table at [src/agents/chat.ts](src/agents/chat.ts#L370-L378).
- The duplicated default-reason string for `/replan` and the three usage strings, which now live in module-level constants used by both dispatch and (potentially) help, instead of inline inside the `switch`.

### Risk

- Low. All behaviour is reachable by the new vitest spec. `.call(this, args)` preserves access to `cmdXxx` instance methods unchanged.
- One TypeScript-correctness item: `LOCAL_COMMAND_HANDLERS` indexes by string; the `!` after lookup is justified because `resolveLocalCommand` already confirmed presence. Optionally use a `Map<string, LocalCommandHandler>` to make this explicit; either works.
- The `MEMORY_SKILL_HELP_ROWS` constant lives in `chat.ts` because the memory/skill agent owns its content but the table layout is a chat-presentation concern; relocating it would cross the boundary. F30 keeps it next to `LOCAL_COMMAND_HANDLERS` with a one-line comment naming the owner.

### What it enables

- Adding a new local command becomes a one-line edit to `LOCAL_CHAT_COMMANDS` plus one entry in `LOCAL_COMMAND_HANDLERS`. The `/help` table and the prompt's slash-command list update automatically (the prompt via F18's `{{slash_commands_table}}` placeholder; the help via the renderer here).
- Closes the F30-reported drift: `/planner-restart` becomes a proper alias declared in `LOCAL_CHAT_COMMANDS[?].aliases`, not a `case` fallthrough.

### What it forbids

- No further hand-typed slash-command row may be added inside `cmdHelp` for any local command — vitest guard: a regex test that `cmdHelp()` contains exactly the rows produced by `LOCAL_CHAT_COMMANDS` plus the static memory rows.
- No new `case "/..."` in `tryHandleCommand` — vitest guard: `grep` test that `tryHandleCommand` contains no `case "/` literal.

### Recommendation note

Smallest delta that achieves the F30 goal. Keeps `ChatAgent`'s structure unchanged. Disadvantage: handlers stay coupled to the class via `this` and are not unit-testable without a full `ChatAgent` instance (channel + event bus + LLM stack). The new test file mocks those, which works but is heavier than necessary.

---

## Proposal B — Lift the local-command surface into `src/chat/localCommands.ts`

### Scope (files touched)

- New file: [src/chat/localCommands.ts](src/chat/localCommands.ts) — owns `dispatchLocalCommand` and `renderLocalHelp`. ~120 lines.
- New file: [src/chat/localCommands.test.ts](src/chat/localCommands.test.ts).
- [src/agents/chat.ts](src/agents/chat.ts) — `tryHandleCommand` shrinks to a thin wrapper; `cmdHelp` deleted (its render is now a call into the new module); the five `cmdXxx` instance methods that are pure formatting (`cmdStatus`, `cmdPlan`, `cmdHistory`) **stay** on the class because they read project state via `this.ctx.project.paths`; the slash-command handlers that are pure delegation (`cmdNote`, `cmdRestartPlanner`) move into the new module and consume capabilities through an injected `LocalCommandContext`.
- [src/agents/conventions.ts](src/agents/conventions.ts) — no change relative to F18.

### Layout

The new module mirrors the existing memory-command factoring at [src/chat/slashCommands.ts](src/chat/slashCommands.ts):

```ts
// src/chat/localCommands.ts
import { LOCAL_CHAT_COMMANDS } from "../agents/conventions.js";
import { createUserNote } from "../runtime/notes.js";
import type { PlannerControl } from "../server/bootstrap.js";
import type { EventBus } from "../events/bus.js";
import type { ProjectPaths } from "../paths.js";

export interface LocalCommandContext {
  paths: ProjectPaths;
  notesDir: string;
  channel: string;
  sessionId: string;
  eventBus: EventBus;
  plannerControl: PlannerControl | undefined;
  // For commands whose output depends on the agent's project state, the
  // agent passes pre-computed snippets in via callbacks rather than us
  // re-reading state — keeps the module pure for testing.
  renderStatus: () => string;
  renderPlan: () => string;
  renderHistory: (n: number) => string;
}

/** Returns the handler reply, or null if `content` is not a recognised local command. */
export async function dispatchLocalCommand(
  content: string,
  ctx: LocalCommandContext,
): Promise<string | null>;

/** Returns the `/help` Markdown body (local rows; the memory rows are appended by the caller). */
export function renderLocalHelp(): string;

/** The static memory/skill rows. Content owned by the skills/memory agent; F30 only quotes it. */
export const MEMORY_SKILL_HELP_ROWS: readonly string[];
```

`ChatAgent.tryHandleCommand` becomes:

```ts
private async tryHandleCommand(content: string): Promise<string | null> {
  if (!content.startsWith("/")) return null;

  const parsed = parseSlashCommand(content);
  if (parsed) {
    try {
      return await runSlashCommand(parsed, { /* unchanged */ });
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return dispatchLocalCommand(content, this.localCommandContext());
}
```

where `localCommandContext()` is a small private builder that constructs the `LocalCommandContext` object once, capturing `this.ctx.project.paths`, `this.input.channel`, `this.input.sessionId`, `this.eventBus`, `this.plannerControl`, and three render closures that call the surviving `cmdStatus`/`cmdPlan`/`cmdHistory` on the class.

`cmdHelp` is gone; the `/help` handler inside the module composes `renderLocalHelp()` + `MEMORY_SKILL_HELP_ROWS` + the trailing text.

### What gets removed

- All of [src/agents/chat.ts](src/agents/chat.ts#L335-L361) (the `switch`).
- All of [src/agents/chat.ts](src/agents/chat.ts#L364-L389) (`cmdHelp`).
- `cmdNote` and `cmdRestartPlanner` methods on `ChatAgent` (~30 lines combined) — their bodies move into the module as plain functions with the `LocalCommandContext` argument.

### Risk

- Moderate. Cross-file refactor with new public surface (`dispatchLocalCommand`, `renderLocalHelp`).
- `tryHandleExplicitPlannerRestart` at [src/agents/chat.ts](src/agents/chat.ts#L501-L505) still calls `this.cmdRestartPlanner(content)`. After move, that call site changes to `restartPlanner(content, this.localCommandContext())` importing the function from the new module. Single mechanical edit, covered by an existing-behaviour test.
- The 5-row `MEMORY_SKILL_HELP_ROWS` constant moves out of `chat.ts` into the new module — still hand-coded, still owned by the skills/memory agent. Choosing `src/chat/localCommands.ts` as its home is justified because `src/chat/` is already where memory-family routing lives ([src/chat/slashCommands.ts](src/chat/slashCommands.ts)).
- F18-ordering: if F18 has not landed, B introduces `LOCAL_CHAT_COMMANDS` into `src/agents/conventions.ts` itself, then F18 merges. No design change required, only ordering of the patch.

### What it enables

- The slash-command surface is unit-testable without instantiating `ChatAgent`. The test file can construct a synthetic `LocalCommandContext` with stub callbacks and assert outputs for all nine commands plus the alias. The existing `src/chat/slashCommands.test.ts` is the template.
- `ChatAgent` is shorter and more focused (session lifecycle, LLM loop, channel I/O, event subscription). Dispatch logic is no longer mixed with conversation handling. Concretely, [src/agents/chat.ts](src/agents/chat.ts) shrinks by ~90 lines.
- Future commands that don't need ChatAgent state (anything pure, e.g. `/version`, `/whoami`) can be added without growing the agent class.
- Symmetry with the memory family: both families now live under `src/chat/`, dispatched the same way (`parsed = parse...; if (parsed) run...`), tested the same way. Closes a long-standing asymmetry that F30's "triplicated" symptom partly stems from.

### What it forbids

- No new slash-command handler may live on `ChatAgent`. Vitest guard: a grep test that `src/agents/chat.ts` contains no `case "/` literal AND no method whose name starts with `cmdNote` or `cmdRestartPlanner`.
- The new module may not import from `src/agents/chat.ts`. (One-way dependency: chat → localCommands, never the reverse.)

### Recommendation note

The right architectural target. The cost over Proposal A is one new file and a small context-object plumbing pattern. The benefits — testability, symmetry with the memory family, shorter `ChatAgent` — pay off the moment another command is added or another channel (Telegram, CLI) wants to invoke the same dispatch surface.

---

## Proposal C — Pull in a CLI-style command framework (e.g., `commander`, `yargs`, `cmd-ts`)

Considered and rejected. The dispatch table is nine entries with trivial arg shapes (most are `<rest of line>`, no flags, no subcommands except inside the memory family which is out of scope). Adding a runtime dependency to gain `--help`-style ergonomics buys nothing the registry-driven approach above does not already provide, and it violates project guideline §2 (no premature configurability) and §1 (the framework's old-style invocation would itself become legacy at the next refactor).

---

## Recommendation

**Proposal B.**

Reasons:

1. It is the natural completion of F18's split: F18 declares the registry, F30 turns it into the single source of truth for both rendering and dispatch. Proposal A does that minimally; B does it cleanly by also fixing the structural asymmetry where the memory family is already a module ([src/chat/slashCommands.ts](src/chat/slashCommands.ts)) but the local family is inlined.
2. The slash-command surface becomes unit-testable without instantiating `ChatAgent`. There are currently no chat-command tests; this is the moment to introduce them, and B makes them cheap. A makes them expensive (full agent harness).
3. The level-up cost is small: one new file (~120 lines), one new test file, a `LocalCommandContext` builder method on `ChatAgent` (~15 lines). Net `chat.ts` line count drops.
4. Proposal A is a strict subset of B's behavioural change without the modularisation. Picking A and later picking B means doing the dispatch rewrite twice.
5. The risk delta over A is bounded by one cross-file move (`cmdNote`, `cmdRestartPlanner`) covered by a deterministic test surface; this is exactly the same pattern already in place for the memory family, so the precedent and test template both exist.
