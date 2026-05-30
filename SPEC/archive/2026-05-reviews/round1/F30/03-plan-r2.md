# F30 — Plan r2 (Proposal B)

## Changes from r1

- **Dispatch is now genuinely registry-driven.** r1's `dispatchLocalCommand` body contained a second `switch (c.name)` over every command name — the same duplication the issue called out, in a new file. r2 replaces that with a `LOCAL_COMMAND_HANDLERS` table constrained by `satisfies Record<LocalChatCommandName, LocalCommandHandler>` where `LocalChatCommandName` is a literal-union type derived from `LOCAL_CHAT_COMMANDS` via `as const satisfies`. Adding or removing a registry entry without a matching handler edit is now a `npm run typecheck` failure, not just a runtime/test gap.
- **Removed structural grep guards** that checked `src/agents/chat.ts` for `case "/`. The type-level invariant supersedes them; the remaining tests focus on dispatch behaviour, alias resolution, help-row composition, and `tryHandleCommand`'s contract.
- **Replaced the emoji-bearing user-visible string with an emoji-free replacement.** The current `cmdNote` reply begins with a printable emoji character followed by `Note created:`. The replacement reply is `` `Note created:` `` followed by the same body. The Plan documents the user-visible string change without embedding the emoji glyph in this file (the glyph is referenced only by its Unicode name "MEMO" / U+1F4DD).
- Step 1 of the plan was tightened: regardless of whether F18 has landed, F30 ensures `LOCAL_CHAT_COMMANDS` is declared with `as const satisfies readonly LocalChatCommand[]` and that `LocalChatCommandName` is exported from `src/agents/conventions.ts`. If F18 declared the registry with a widened annotation, this step narrows it.
- All other steps carried over; the `LocalCommandContext` interface, the `tryHandleExplicitPlannerRestart` rewire, the file boundaries, the validation commands, and the rollback strategy are unchanged from r1.

Plan for Proposal B from [02-design-r2.md](02-design-r2.md): lift the local slash-command surface into `src/chat/localCommands.ts`, drive both dispatch and `/help` rendering from F18's `LOCAL_CHAT_COMMANDS`, enforce the no-drift invariant at the type level via `satisfies Record<LocalChatCommandName, …>`, and shrink `ChatAgent.tryHandleCommand` / delete `cmdHelp` / move `cmdNote` and `cmdRestartPlanner` out.

## Cross-issue ordering

- **Must land after F18.** F30 consumes `LOCAL_CHAT_COMMANDS` from [src/agents/conventions.ts](src/agents/conventions.ts), which F18 introduces. If F30 is applied before F18 is merged, step 1 below introduces `LOCAL_CHAT_COMMANDS` itself (same shape as F18's design); F18 then merges into a registry that already exists. The handoff is mechanical either way.
- **Out of scope (do not touch):**
  - [src/skills/](src/skills/) and [SPEC/v2/skills-memory/](SPEC/v2/skills-memory/), [SPEC/v2/skills/](SPEC/v2/skills/).
  - [src/chat/slashCommands.ts](src/chat/slashCommands.ts) and its test file.
  - The memory/skill handler hook at [src/agents/chat.ts](src/agents/chat.ts#L304-L334) (`parseSlashCommand` + `runSlashCommand` call). It stays exactly as is.
  - The seven memory/skill rows in `/help`. Their text is copied verbatim into the new module as `MEMORY_SKILL_HELP_ROWS`; F30 does not author or edit that content.

## Edit steps

### Step 1 — Ensure `LOCAL_CHAT_COMMANDS` shape in `src/agents/conventions.ts`

Required end-state in [src/agents/conventions.ts](src/agents/conventions.ts):

```ts
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
```

If F18 already declared `LOCAL_CHAT_COMMANDS` with a plain `: readonly LocalChatCommand[] = [...]` annotation, change it to the `as const satisfies` form and add the `LocalChatCommandName` export. If F18 has not landed, the entire block above is added in this step. Either way the end-state is identical.

Validation for this step alone: `npm run typecheck` plus a one-liner check that `LocalChatCommandName` is a string-literal union, not `string`, by reading the `.d.ts` produced by `npx tsc --emitDeclarationOnly` (or by spot-checking with a deliberately wrong literal in a scratch file).

### Step 2 — Create `src/chat/localCommands.ts`

New file. Full skeleton (prose strings carried over verbatim from the bodies being removed in step 3, with the one user-visible change documented at the end of this step):

```ts
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

const REPLAN_DEFAULT_REASON =
  "User requests replanning. Re-evaluate the current plan, analyze what has failed or escalated, and create a new strategy to achieve the project objectives.";
const USAGE_NOTE        = "Usage: `/note <message>` - create a note for the Planner.";
const USAGE_NOTE_URGENT = "Usage: `/note! <message>` - create an **urgent** high-priority note.";
const USAGE_NOTEP       = "Usage: `/notep <message>` - create a **permanent** note.";

export const MEMORY_SKILL_HELP_ROWS: readonly string[] = [
  "| `/skills list` | List available skills |",
  "| `/skills show <name-or-id>` | Show a skill body |",
  "| `/memories list` | List memory records |",
  "| `/memories show <id-or-topic>` | Show a memory by id or topic |",
  "| `/memories search <query>` | Search memory records |",
  "| `/remember <text>` | Ask the Planner to record a memory |",
  "| `/forget <id>` | Ask the Planner to archive a memory |",
];

const LOCAL_COMMAND_HANDLERS = {
  "/help":            ()           => renderLocalHelp(),
  "/status":          (ctx)        => ctx.renderStatus(),
  "/plan":            (ctx)        => ctx.renderPlan(),
  "/history":         (ctx, args)  => ctx.renderHistory(parseInt(args, 10) || 5),
  "/replan":          (ctx, args)  => createNote(ctx, args || REPLAN_DEFAULT_REASON, false, true),
  "/restart-planner": (ctx, args)  => restartPlanner(ctx, args),
  "/note":            (ctx, args)  => args ? createNote(ctx, args, false, false) : USAGE_NOTE,
  "/note!":           (ctx, args)  => args ? createNote(ctx, args, false, true)  : USAGE_NOTE_URGENT,
  "/notep":           (ctx, args)  => args ? createNote(ctx, args, true,  false) : USAGE_NOTEP,
} satisfies Record<LocalChatCommandName, LocalCommandHandler>;

function resolveLocalCommand(cmd: string): LocalChatCommandName | undefined {
  for (const c of LOCAL_CHAT_COMMANDS) {
    if (c.name === cmd) return c.name;
    if (c.aliases?.includes(cmd)) return c.name;
  }
  return undefined;
}

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

export function renderLocalHelp(): string {
  const localRows = LOCAL_CHAT_COMMANDS.map(c => `| \`${c.usage}\` | ${c.help} |`);
  return [
    "**Available Commands**",
    "",
    "| Command | Description |",
    "|---------|-------------|",
    ...localRows,
    ...MEMORY_SKILL_HELP_ROWS,
    "",
    "Any other message is handled by the AI assistant.",
  ].join("\n");
}

async function createNote(
  ctx: LocalCommandContext,
  content: string,
  permanent: boolean,
  urgent: boolean,
): Promise<string> {
  const note = createUserNote({
    notesDir: ctx.notesDir,
    channel: ctx.channel,
    sessionId: ctx.sessionId,
    content,
    permanent,
    urgent,
  });
  const flags = [permanent ? "permanent" : null, urgent ? "urgent" : null]
    .filter(Boolean).join(", ");
  const flagStr = flags ? ` (${flags})` : "";
  return `Note created: \`${note.id}\`${flagStr}\nThe Planner will decide how to handle it when it next sees pending notes.${urgent ? "\nMarked high priority; no running work was interrupted." : ""}`;
}

export async function restartPlanner(
  ctx: LocalCommandContext,
  reason: string,
): Promise<string> {
  if (!ctx.plannerControl) {
    return "Planner restart is not available in this runtime. Use `/replan <reason>` to create an urgent Planner note instead.";
  }
  const restartReason = reason || "User explicitly requested a Planner restart from chat.";
  const request = ctx.plannerControl.requestRestart(restartReason, `${ctx.channel}:${ctx.sessionId}`);
  await ctx.eventBus.publish({
    type: "plan_updated",
    summary: `Planner restart requested from ${ctx.channel}: ${restartReason}`,
  });
  return [
    `Planner restart requested at ${request.requestedAt}.`,
    "The current Planner turn will be cancelled, then a fresh Planner will reload plan/history from disk and continue from persistent state.",
    `Reason: ${restartReason}`,
  ].join("\n");
}
```

The `satisfies Record<LocalChatCommandName, LocalCommandHandler>` clause is the F30 invariant. Drift (registry entry without handler, or handler without registry entry, or typo on either side) is now a TypeScript compile error.

**One user-visible string change (document in the commit body):** the current `cmdNote` reply at [src/agents/chat.ts](src/agents/chat.ts#L480) begins with a single Unicode character at codepoint U+1F4DD (Unicode name MEMO) followed by `" Note created:"`. Per loop convention §"No emojis", the replacement `createNote` returns the same body starting at `"Note created:"` (the codepoint and its trailing space are dropped). No other reply text is altered.

### Step 3 — Edit `src/agents/chat.ts`

Apply these edits in one pass via `multi_replace_string_in_file`:

1. **Imports**: add `import { dispatchLocalCommand, restartPlanner, type LocalCommandContext } from "../chat/localCommands.js";`.
2. **Replace the `switch` block** at [src/agents/chat.ts](src/agents/chat.ts#L330-L361). The post-`parseSlashCommand` tail of `tryHandleCommand` becomes:

   ```ts
   return dispatchLocalCommand(content, this.localCommandContext());
   ```

3. **Delete `cmdHelp`** entirely at [src/agents/chat.ts](src/agents/chat.ts#L364-L389).
4. **Delete `cmdNote`** and **delete `cmdRestartPlanner`** (the bodies have moved into the module).
5. **Adjust `tryHandleExplicitPlannerRestart`** at [src/agents/chat.ts](src/agents/chat.ts#L501-L505): replace `return this.cmdRestartPlanner(content);` with `return restartPlanner(this.localCommandContext(), content);`.
6. **Add `localCommandContext()` private helper** on `ChatAgent`:

   ```ts
   private localCommandContext(): LocalCommandContext {
     return {
       notesDir: this.ctx.project.paths.notes,
       channel: this.input.channel,
       sessionId: this.input.sessionId,
       eventBus: this.eventBus,
       plannerControl: this.plannerControl,
       renderStatus:  () => this.cmdStatus(),
       renderPlan:    () => this.cmdPlan(),
       renderHistory: (n: number) => this.cmdHistory(String(n)),
     };
   }
   ```

`cmdStatus`, `cmdPlan`, `cmdHistory` remain unchanged — they read project state via `this.ctx.project.paths` and stay on the class because they are not pure functions of a context object.

### Step 4 — New test file `src/chat/localCommands.test.ts`

Vitest spec covering:

1. **Type-level invariant (compile-time sanity)**: a short `// @ts-expect-error` block at the top of the test file demonstrates that an invented command name fails the handler-table type. This documents the invariant for readers; the actual enforcement is `npm run typecheck`, not the test.

   ```ts
   // Sanity: the handler table is keyed by the registry's literal names.
   // Adding an unknown key is a type error. Deleting a known key is also a type error.
   // The lines below must NOT compile:
   //   // @ts-expect-error
   //   const bad1: Record<LocalChatCommandName, unknown> = { "/help": 0 }; // missing keys
   //   // @ts-expect-error
   //   const bad2: Record<LocalChatCommandName, unknown> = { ...allKeys, "/bogus": 0 };
   ```

2. **Dispatch coverage**:
   - For each entry in `LOCAL_CHAT_COMMANDS`, `dispatchLocalCommand(entry.name, ctx)` returns a non-null string. Iterating the registry — not a hand-listed array — proves every registered command has a working handler at runtime, complementing the compile-time invariant.
   - For `/restart-planner` and its alias `/planner-restart`, both dispatch identically (assert via a spy on `ctx.plannerControl.requestRestart`).
   - `dispatchLocalCommand("/bogus", ctx)` returns `null`.
   - `dispatchLocalCommand("not-a-command", ctx)` returns `null`.
   - Case-insensitive: `dispatchLocalCommand("/HELP", ctx)` returns the help body.
3. **Argument handling**:
   - `/history` with empty args defaults to `n=5` (assert `ctx.renderHistory` called with `5`); `/history 12` calls with `12`; `/history banana` defaults to `5`.
   - `/replan` with empty args uses `REPLAN_DEFAULT_REASON`; with text uses the text. Assert via a `vi.mock("../runtime/notes.js")` spy on `createUserNote`.
   - `/note`, `/note!`, `/notep` with empty args each return their usage string verbatim.
4. **`renderLocalHelp` output**:
   - Contains exactly one row per `LOCAL_CHAT_COMMANDS` entry, in declaration order, formatted as `` `| \`${usage}\` | ${help} |` ``. Compared by iterating the registry, not by string-literal hard-coding.
   - Contains every string in `MEMORY_SKILL_HELP_ROWS` immediately after the local rows.
   - Ends with `"Any other message is handled by the AI assistant."` as the last non-empty line.
   - Aliases (e.g. `/planner-restart`) are NOT listed as separate rows.
5. **`createNote` reply**:
   - The first line starts with `"Note created:"` (no leading emoji glyph or other prefix). Negative assertion: the reply does not contain the U+1F4DD codepoint.
6. **`tryHandleCommand` end-to-end** (small integration test against a stubbed `ChatAgent` or a focused unit on `dispatchLocalCommand`): unknown slash commands return `null` (the LLM-fallthrough contract).

`createUserNote` is mocked via `vi.mock("../runtime/notes.js")` so the test does not touch the filesystem.

### Step 5 — Verify no other call sites broke

`grep -n "cmdHelp\|cmdNote\|cmdRestartPlanner" src/` must return only matches in [src/chat/localCommands.ts](src/chat/localCommands.ts) (the new module) and the surviving `cmdStatus`/`cmdPlan`/`cmdHistory` methods. Any other match is a missed call site.

## Test strategy

### Existing tests covering this area

- [src/chat/slashCommands.test.ts](src/chat/slashCommands.test.ts) — memory/skill family only. F30 does not modify this file or the code it tests.
- No existing `chat.test.ts` for the local family — that is part of why the duplication has survived.

### New tests

- [src/chat/localCommands.test.ts](src/chat/localCommands.test.ts) — new, scope per Step 4 above. Approximately 12-15 `it(...)` blocks.

### Validation commands

Run from the repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck                            # the registry/handler-table invariant fails here on drift
npm run build
npx vitest run src/chat/localCommands.test.ts
npx vitest run src/chat/                     # also re-runs slashCommands.test.ts to confirm no cross-impact
npx vitest run                               # full suite, must stay green
npm run lint                                 # confirms no unused-import or no-undef issues from the imports edit
```

Pre-merge gate: all six commands must pass. `npm run typecheck` is the canonical guard for the registry-driven invariant; `npx vitest run` is the canonical regression check because there is no chat-agent integration test that the focused command would skip.

## Rollback strategy

Single commit. All edits are confined to:

- `src/chat/localCommands.ts` (new file — delete to roll back)
- `src/chat/localCommands.test.ts` (new file — delete to roll back)
- `src/agents/chat.ts` (the dispatch + cmdHelp + cmdNote + cmdRestartPlanner removal — `git checkout HEAD~1 -- src/agents/chat.ts` to roll back)
- `src/agents/conventions.ts` (the `as const satisfies` tightening plus the `LocalChatCommandName` export)

`git revert <sha>` is sufficient. No data-shape changes, no on-disk format changes, no schema migrations.

## Risk notes

- **One user-visible string change.** The leading emoji glyph (U+1F4DD) on the `Note created:` reply is removed. Document in the commit body. The change is forced by loop convention §"No emojis".
- **`LOCAL_CHAT_COMMANDS` placement** in `src/agents/conventions.ts` is awkward (it is not a "convention" in the territory-rule sense). F30 inherits F18's placement and does not relocate. A separate follow-up (not F30, not F18) can move the registry to `src/chat/` if reviewers wish; F30 does not gate on that decision.
- **No interaction with `parseSlashCommand`** — the two-tier dispatch order in `tryHandleCommand` (memory family first, local family second) is preserved verbatim.
- **`tryHandleExplicitPlannerRestart`** uses the same `restartPlanner` function imported from the new module; behaviour identical to the pre-F30 path (it currently calls `this.cmdRestartPlanner(content)` directly).
- **Drift safety net.** With the `satisfies Record<LocalChatCommandName, LocalCommandHandler>` invariant, the recurrence mode for F30 (someone adds a command in one place and forgets the other) is a `npm run typecheck` failure on the PR — caught before merge by CI, not by a downstream user report.
