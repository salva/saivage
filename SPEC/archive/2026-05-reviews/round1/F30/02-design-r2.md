# F30 — Design r2

## Changes from r1

- **Reworked Proposal B's dispatch mechanism** to be genuinely registry-driven. r1 replaced the `switch (cmd)` in `chat.ts` with a `switch (c.name)` in `localCommands.ts` — same duplication, new file. r2 replaces dispatch with a `Record<LocalChatCommandName, LocalCommandHandler>` handler table constrained by `satisfies`, where `LocalChatCommandName` is a literal-union type derived from `LOCAL_CHAT_COMMANDS`. Adding or removing a registry entry without a matching handler edit becomes a TypeScript compile error.
- **Reworked Proposal A symmetrically** so the two proposals differ only in module structure, not in dispatch correctness. Both now use the same handler-table-plus-`satisfies` pattern; A keeps the table inside `chat.ts`, B lifts it into `src/chat/localCommands.ts`.
- **Updated the "What it forbids" sections** to drop the "no `case "/` literal" grep guards in favour of the type-level invariant (drift now fails at `npm run typecheck` rather than via a structural regex test).
- Recommendation still Proposal B for the reasons in r1; the registry-driven correction does not change the proposal selection.

---

Two proposals. Both eliminate the duplication between the `switch` in `tryHandleCommand` and the `cmdHelp` Markdown table, both consume the `LOCAL_CHAT_COMMANDS` registry that F18 introduces in [src/agents/conventions.ts](src/agents/conventions.ts), and both leave the memory/skill family (`parseSlashCommand` / `runSlashCommand`) and the corresponding `cmdHelp` rows untouched.

Proposal A is the minimum completion of F18: keep dispatch inside `ChatAgent`, drive `cmdHelp` from the registry. Proposal B is the level-up: lift the entire local-command surface (dispatch + help rendering) into a sibling module of [src/chat/slashCommands.ts](src/chat/slashCommands.ts), mirroring how the memory family is already factored.

## Shared registry shape (both proposals)

Both proposals depend on `LOCAL_CHAT_COMMANDS` being declared with `as const satisfies readonly LocalChatCommand[]` so the literal `name` values survive type-narrowing. This shape is identical to what F18 needs for its prompt placeholder; if F18 lands first with a widened `readonly LocalChatCommand[]` annotation, F30's step 1 tightens it to `as const satisfies` and adds the derived name type. The shape is:

```ts
// src/agents/conventions.ts
export interface LocalChatCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly usage: string;
  readonly help: string;
}

export const LOCAL_CHAT_COMMANDS = [
  { name: "/help",            usage: "/help",                     help: "Show this help message" },
  { name: "/status",          usage: "/status",                   help: "Show runtime status (agents, current stage)" },
  { name: "/plan",            usage: "/plan",                     help: "Show the current plan with all stages" },
  { name: "/history",         usage: "/history [n]",              help: "Show completed stages (last n, default 5)" },
  { name: "/replan",          usage: "/replan [reason]",          help: "Force replanning (urgent note to Planner)" },
  { name: "/restart-planner", aliases: ["/planner-restart"],
                              usage: "/restart-planner [reason]", help: "Restart the Planner from persisted state" },
  { name: "/note",            usage: "/note <msg>",               help: "Create a note for the Planner" },
  { name: "/note!",           usage: "/note! <msg>",              help: "Create an **urgent** high-priority note" },
  { name: "/notep",           usage: "/notep <msg>",              help: "Create a **permanent** note" },
] as const satisfies readonly LocalChatCommand[];

export type LocalChatCommandName = (typeof LOCAL_CHAT_COMMANDS)[number]["name"];
// resolves to: "/help" | "/status" | "/plan" | "/history" | "/replan"
//            | "/restart-planner" | "/note" | "/note!" | "/notep"
```

The `as const satisfies` form is the key. A plain `: readonly LocalChatCommand[] = [...] as const` annotation widens the `name` field back to `string` and breaks the union derivation. The `satisfies` operator preserves the literal narrowing while still asserting structural conformance to `LocalChatCommand`.

---

## Proposal A — Handler table inside `chat.ts`

### Scope (files touched)

- [src/agents/chat.ts](src/agents/chat.ts) — replace the `switch` body, replace the `cmdHelp` body. No other agent file. No new file.
- [src/agents/conventions.ts](src/agents/conventions.ts) — confirm `as const satisfies` form per the shared shape above.
- New test: [src/agents/chat.test.ts](src/agents/chat.test.ts) — covers dispatch, alias, help rendering.

### What gets added

A module-level handler table in `chat.ts`, right above the `ChatAgent` class:

```ts
type LocalCommandHandler = (this: ChatAgent, args: string) => string | Promise<string>;

const LOCAL_COMMAND_HANDLERS = {
  "/help":            function () { return this.cmdHelp(); },
  "/status":          function () { return this.cmdStatus(); },
  "/plan":            function () { return this.cmdPlan(); },
  "/history":         function (args) { return this.cmdHistory(args); },
  "/replan":          function (args) { return this.cmdNote(args || REPLAN_DEFAULT_REASON, false, true); },
  "/restart-planner": function (args) { return this.cmdRestartPlanner(args); },
  "/note":            function (args) { return args ? this.cmdNote(args, false, false) : USAGE_NOTE; },
  "/note!":           function (args) { return args ? this.cmdNote(args, false, true)  : USAGE_NOTE_URGENT; },
  "/notep":           function (args) { return args ? this.cmdNote(args, true,  false) : USAGE_NOTEP; },
} satisfies Record<LocalChatCommandName, LocalCommandHandler>;
```

The `satisfies Record<LocalChatCommandName, LocalCommandHandler>` clause makes drift between `LOCAL_CHAT_COMMANDS` and `LOCAL_COMMAND_HANDLERS` a compile error in either direction:

- Add `{ name: "/foo", ... }` to the registry without adding `"/foo": …` to the table -> "Property `/foo` is missing in type `…`".
- Add `"/foo": …` to the table without adding it to the registry -> "Object literal may only specify known properties, and `/foo` does not exist in type `Record<LocalChatCommandName, …>`".
- Typo a key (`"/halp"` instead of `"/help"`) -> the same "does not exist in type" error.

Alias resolution stays a small helper that walks `LOCAL_CHAT_COMMANDS` once:

```ts
function resolveLocalCommand(cmd: string): LocalChatCommandName | undefined {
  for (const c of LOCAL_CHAT_COMMANDS) {
    if (c.name === cmd) return c.name;
    if (c.aliases?.includes(cmd)) return c.name;
  }
  return undefined;
}
```

The dispatch block in `tryHandleCommand` at [src/agents/chat.ts](src/agents/chat.ts#L330-L361) shrinks to a registry lookup followed by a single typed-key handler call — no `switch`, no per-command list:

```ts
const spaceIdx = content.indexOf(" ");
const cmd  = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

const canonical = resolveLocalCommand(cmd);
if (!canonical) return null;
return LOCAL_COMMAND_HANDLERS[canonical].call(this, args);
```

`cmdHelp` at [src/agents/chat.ts](src/agents/chat.ts#L364-L389) is rewritten to render the local rows from `LOCAL_CHAT_COMMANDS` and append the memory/skill rows as a static suffix array:

```ts
private cmdHelp(): string {
  const localRows = LOCAL_CHAT_COMMANDS.map(c => `| \`${c.usage}\` | ${c.help} |`);
  return [
    "**Available Commands**",
    "",
    "| Command | Description |",
    "|---------|-------------|",
    ...localRows,
    ...MEMORY_SKILL_HELP_ROWS, // static suffix; content owned by skills/memory agent
    "",
    "Any other message is handled by the AI assistant.",
  ].join("\n");
}
```

### What gets removed

- The 27-line `switch` statement at [src/agents/chat.ts](src/agents/chat.ts#L335-L361). Deleted, no shim.
- The hand-typed nine-row local section of the Markdown table at [src/agents/chat.ts](src/agents/chat.ts#L370-L378).
- The duplicated default-reason string for `/replan` and the three usage strings, now in module-level constants used by both dispatch and (potentially) help.

### Risk

- Low. All behaviour is reachable by the new vitest spec.
- `.call(this, args)` preserves access to `cmdXxx` instance methods unchanged.
- `LOCAL_COMMAND_HANDLERS[canonical]` is non-null without a `!` because `canonical` is typed as `LocalChatCommandName` and the table is constrained by `Record<LocalChatCommandName, …>`.
- `MEMORY_SKILL_HELP_ROWS` lives in `chat.ts` because the memory/skill agent owns its content but the table layout is a chat-presentation concern; relocating it would cross the F18 boundary.

### What it enables

- Adding a new local command becomes a one-line edit to `LOCAL_CHAT_COMMANDS` plus one entry in `LOCAL_COMMAND_HANDLERS`. Forgetting either half is a TypeScript error, not a runtime failure or a test gap.
- Closes the F30-reported drift: `/planner-restart` becomes a proper alias declared in `LOCAL_CHAT_COMMANDS[?].aliases`, not a `case` fallthrough.

### What it forbids

- `LOCAL_COMMAND_HANDLERS` is the only dispatch surface; no further `if (cmd === "/...")` branch may be added in `tryHandleCommand`. Enforced by code review plus a small structural test that `tryHandleCommand`'s body is short (no second dispatch arm needed because the typecheck invariant already prevents the legitimate case for adding one).
- No further hand-typed slash-command row may be added inside `cmdHelp` for any local command — the local rows are produced exclusively by the `.map()` over `LOCAL_CHAT_COMMANDS`.

### Recommendation note

Smallest delta that achieves the F30 goal with the registry-driven invariant the issue requires. Keeps `ChatAgent`'s structure unchanged. Disadvantage: handlers stay coupled to the class via `this` and are not unit-testable without a full `ChatAgent` instance (channel + event bus + LLM stack). The new test file mocks those, which works but is heavier than necessary.

---

## Proposal B — Lift the local-command surface into `src/chat/localCommands.ts`

### Scope (files touched)

- New file: [src/chat/localCommands.ts](src/chat/localCommands.ts) — owns the `LocalCommandContext` interface, the `LOCAL_COMMAND_HANDLERS` table, `dispatchLocalCommand`, and `renderLocalHelp`. ~140 lines.
- New file: [src/chat/localCommands.test.ts](src/chat/localCommands.test.ts).
- [src/agents/chat.ts](src/agents/chat.ts) — `tryHandleCommand` shrinks to a thin wrapper; `cmdHelp`, `cmdNote`, `cmdRestartPlanner` deleted (their bodies move into the module); `cmdStatus`, `cmdPlan`, `cmdHistory` remain on the class because they read project state via `this.ctx.project.paths`; the agent grows a `localCommandContext()` private builder.
- [src/agents/conventions.ts](src/agents/conventions.ts) — confirm `as const satisfies` form per the shared shape above.

### Layout

The new module mirrors the existing memory-command factoring at [src/chat/slashCommands.ts](src/chat/slashCommands.ts):

```ts
// src/chat/localCommands.ts
import { LOCAL_CHAT_COMMANDS, type LocalChatCommandName } from "../agents/conventions.js";
import { createUserNote } from "../runtime/notes.js";
import type { EventBus } from "../events/bus.js";
import type { PlannerControl } from "../server/bootstrap.js";

export interface LocalCommandContext {
  notesDir: string;
  channel: string;
  sessionId: string;
  eventBus: EventBus;
  plannerControl: PlannerControl | undefined;
  renderStatus:  () => string;
  renderPlan:    () => string;
  renderHistory: (n: number) => string;
}

type LocalCommandHandler = (ctx: LocalCommandContext, args: string) => string | Promise<string>;

const LOCAL_COMMAND_HANDLERS = {
  "/help":            ()             => renderLocalHelp(),
  "/status":          (ctx)          => ctx.renderStatus(),
  "/plan":            (ctx)          => ctx.renderPlan(),
  "/history":         (ctx, args)    => ctx.renderHistory(parseInt(args, 10) || 5),
  "/replan":          (ctx, args)    => createNote(ctx, args || REPLAN_DEFAULT_REASON, false, true),
  "/restart-planner": (ctx, args)    => restartPlanner(ctx, args),
  "/note":            (ctx, args)    => args ? createNote(ctx, args, false, false) : USAGE_NOTE,
  "/note!":           (ctx, args)    => args ? createNote(ctx, args, false, true)  : USAGE_NOTE_URGENT,
  "/notep":           (ctx, args)    => args ? createNote(ctx, args, true,  false) : USAGE_NOTEP,
} satisfies Record<LocalChatCommandName, LocalCommandHandler>;

export async function dispatchLocalCommand(
  content: string,
  ctx: LocalCommandContext,
): Promise<string | null> {
  if (!content.startsWith("/")) return null;
  const spaceIdx = content.indexOf(" ");
  const cmd  = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const canonical = resolveLocalCommand(cmd);
  if (!canonical) return null;
  return LOCAL_COMMAND_HANDLERS[canonical](ctx, args);
}

function resolveLocalCommand(cmd: string): LocalChatCommandName | undefined {
  for (const c of LOCAL_CHAT_COMMANDS) {
    if (c.name === cmd) return c.name;
    if (c.aliases?.includes(cmd)) return c.name;
  }
  return undefined;
}

export function renderLocalHelp(): string { /* renders LOCAL_CHAT_COMMANDS rows + MEMORY_SKILL_HELP_ROWS suffix */ }

export const MEMORY_SKILL_HELP_ROWS: readonly string[] = [ /* 7 rows, verbatim from chat.ts */ ];

// restartPlanner and createNote bodies move here verbatim from chat.ts.
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

The `satisfies Record<LocalChatCommandName, LocalCommandHandler>` invariant is identical to Proposal A's: drift between the registry and the handler table is a compile error.

### What gets removed

- All of [src/agents/chat.ts](src/agents/chat.ts#L335-L361) (the `switch`).
- All of [src/agents/chat.ts](src/agents/chat.ts#L364-L389) (`cmdHelp`).
- `cmdNote` and `cmdRestartPlanner` methods on `ChatAgent` (~30 lines combined) — their bodies move into the module as plain functions with the `LocalCommandContext` argument.

### Risk

- Moderate. Cross-file refactor with new public surface (`dispatchLocalCommand`, `renderLocalHelp`).
- `tryHandleExplicitPlannerRestart` at [src/agents/chat.ts](src/agents/chat.ts#L501-L505) still calls `this.cmdRestartPlanner(content)`. After move, that call site changes to `restartPlanner(this.localCommandContext(), content)` importing the function from the new module. Single mechanical edit, covered by a test.
- The seven-row `MEMORY_SKILL_HELP_ROWS` constant moves out of `chat.ts` into the new module — still hand-coded, still owned by the skills/memory agent. Choosing `src/chat/localCommands.ts` as its home is justified because `src/chat/` is already where memory-family routing lives ([src/chat/slashCommands.ts](src/chat/slashCommands.ts)).
- F18-ordering: if F18 has not landed, B introduces `LOCAL_CHAT_COMMANDS` (with the `as const satisfies` form) into `src/agents/conventions.ts` itself, then F18 merges. No design change required, only ordering of the patch.

### What it enables

- The slash-command surface is unit-testable without instantiating `ChatAgent`. The test file constructs a synthetic `LocalCommandContext` with stub callbacks and asserts outputs for all nine commands plus the alias. The existing `src/chat/slashCommands.test.ts` is the template.
- `ChatAgent` is shorter and more focused (session lifecycle, LLM loop, channel I/O, event subscription). Dispatch logic is no longer mixed with conversation handling. Concretely, [src/agents/chat.ts](src/agents/chat.ts) shrinks by ~90 lines.
- Future commands that don't need ChatAgent state (anything pure, e.g. `/version`, `/whoami`) can be added without growing the agent class.
- Symmetry with the memory family: both families now live under `src/chat/`, dispatched the same way (`parsed = parse...; if (parsed) run...`), tested the same way. Closes a long-standing asymmetry that F30's "triplicated" symptom partly stems from.

### What it forbids

- The registry/handler-table pairing is the only local dispatch surface. Drift fails `npm run typecheck`. No `if (cmd === "/...")` branch in `dispatchLocalCommand` is permitted; the table is the dispatch.
- The new module may not import from `src/agents/chat.ts`. One-way dependency: chat -> localCommands, never the reverse.
- No further hand-typed local command row may be added inside `renderLocalHelp` — the local rows are produced exclusively by `LOCAL_CHAT_COMMANDS.map(...)`.

### Recommendation note

The right architectural target. The cost over Proposal A is one new file and a small context-object plumbing pattern. The benefits — testability, symmetry with the memory family, shorter `ChatAgent` — pay off the moment another command is added or another channel (Telegram, CLI) wants to invoke the same dispatch surface.

---

## Proposal C — Pull in a CLI-style command framework (e.g., `commander`, `yargs`, `cmd-ts`)

Considered and rejected. The dispatch table is nine entries with trivial arg shapes (most are `<rest of line>`, no flags, no subcommands except inside the memory family which is out of scope). Adding a runtime dependency to gain `--help`-style ergonomics buys nothing the registry-plus-`satisfies` approach above does not already provide, and it violates project guideline §2 (no premature configurability) and §1 (the framework's old-style invocation would itself become legacy at the next refactor).

---

## Recommendation

**Proposal B.**

Reasons unchanged from r1:

1. It is the natural completion of F18's split: F18 declares the registry, F30 turns it into the single source of truth for both rendering and dispatch. Proposal A does that minimally; B does it cleanly by also fixing the structural asymmetry where the memory family is already a module ([src/chat/slashCommands.ts](src/chat/slashCommands.ts)) but the local family is inlined.
2. The slash-command surface becomes unit-testable without instantiating `ChatAgent`. There are currently no chat-command tests; this is the moment to introduce them, and B makes them cheap. A makes them expensive (full agent harness).
3. The level-up cost is small: one new file (~140 lines), one new test file, a `LocalCommandContext` builder method on `ChatAgent` (~15 lines). Net `chat.ts` line count drops.
4. Proposal A is a strict subset of B's behavioural change without the modularisation. Picking A and later picking B means doing the dispatch rewrite twice.
5. The risk delta over A is bounded by one cross-file move (`cmdNote`, `cmdRestartPlanner`) covered by a deterministic test surface; this is exactly the same pattern already in place for the memory family, so the precedent and test template both exist.
