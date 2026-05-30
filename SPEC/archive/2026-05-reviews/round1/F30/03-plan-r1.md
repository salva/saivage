# F30 — Plan r1 (Proposal B)

Plan for Proposal B from [02-design-r1.md](02-design-r1.md): lift the local slash-command surface into `src/chat/localCommands.ts`, drive both dispatch and `/help` rendering from F18's `LOCAL_CHAT_COMMANDS`, and shrink `ChatAgent.tryHandleCommand` / delete `cmdHelp`.

## Cross-issue ordering

- **Must land after F18.** F30 consumes `LOCAL_CHAT_COMMANDS` from [src/agents/conventions.ts](src/agents/conventions.ts), which F18 introduces. If F30 is applied before F18 is merged, step 1 below introduces `LOCAL_CHAT_COMMANDS` itself (same shape as F18's design); F18 then merges into a registry that already exists. The handoff is mechanical either way.
- **Out of scope (do not touch):**
  - [src/skills/](src/skills/) and [SPEC/v2/skills-memory/](SPEC/v2/skills-memory/), [SPEC/v2/skills/](SPEC/v2/skills/).
  - [src/chat/slashCommands.ts](src/chat/slashCommands.ts) and its test file.
  - The memory/skill handler hook at [src/agents/chat.ts](src/agents/chat.ts#L304-L334) (`parseSlashCommand` + `runSlashCommand` call). It stays exactly as is.
  - The seven memory/skill rows in `/help`. Their text is copied verbatim into the new module as `MEMORY_SKILL_HELP_ROWS`; F30 does not author or edit that content.

## Edit steps

### Step 1 — Confirm or create `LOCAL_CHAT_COMMANDS` in `src/agents/conventions.ts`

If F18 has landed: nothing to do.

If not: append to [src/agents/conventions.ts](src/agents/conventions.ts):

```ts
export interface LocalChatCommand {
  name: string;
  aliases?: string[];
  usage: string;  // displayed in /help, e.g. "/history [n]"
  help: string;   // /help row description
}

export const LOCAL_CHAT_COMMANDS: readonly LocalChatCommand[] = [
  { name: "/help",            usage: "/help",                       help: "Show this help message" },
  { name: "/status",          usage: "/status",                     help: "Show runtime status (agents, current stage)" },
  { name: "/plan",            usage: "/plan",                       help: "Show the current plan with all stages" },
  { name: "/history",         usage: "/history [n]",                help: "Show completed stages (last n, default 5)" },
  { name: "/replan",          usage: "/replan [reason]",            help: "Force replanning (urgent note to Planner)" },
  { name: "/restart-planner", aliases: ["/planner-restart"],
                              usage: "/restart-planner [reason]",   help: "Restart the Planner from persisted state" },
  { name: "/note",            usage: "/note <msg>",                 help: "Create a note for the Planner" },
  { name: "/note!",           usage: "/note! <msg>",                help: "Create an **urgent** high-priority note" },
  { name: "/notep",           usage: "/notep <msg>",                help: "Create a **permanent** note" },
];
```

### Step 2 — Create `src/chat/localCommands.ts`

New file. Contents (skeleton — exact prose carried over verbatim from the bodies being removed in step 3):

```ts
/**
 * Saivage — local-Chat slash commands.
 *
 * Owns dispatch and /help rendering for the nine local commands declared
 * in LOCAL_CHAT_COMMANDS. The memory/skill family is parsed and routed
 * separately by src/chat/slashCommands.ts; this module does not see those.
 */

import { LOCAL_CHAT_COMMANDS, type LocalChatCommand } from "../agents/conventions.js";
import { createUserNote } from "../runtime/notes.js";
import type { EventBus } from "../events/bus.js";
import type { PlannerControl } from "../server/bootstrap.js";

export interface LocalCommandContext {
  notesDir: string;
  channel: string;
  sessionId: string;
  eventBus: EventBus;
  plannerControl: PlannerControl | undefined;
  renderStatus: () => string;
  renderPlan: () => string;
  renderHistory: (n: number) => string;
}

const REPLAN_DEFAULT_REASON =
  "User requests replanning. Re-evaluate the current plan, analyze what has failed or escalated, and create a new strategy to achieve the project objectives.";
const USAGE_NOTE        = "Usage: `/note <message>` — create a note for the Planner.";
const USAGE_NOTE_URGENT = "Usage: `/note! <message>` — create an **urgent** high-priority note.";
const USAGE_NOTEP       = "Usage: `/notep <message>` — create a **permanent** note.";

/** /help rows owned by the skills/memory agent. F30 does not author this content. */
export const MEMORY_SKILL_HELP_ROWS: readonly string[] = [
  "| `/skills list` | List available skills |",
  "| `/skills show <name-or-id>` | Show a skill body |",
  "| `/memories list` | List memory records |",
  "| `/memories show <id-or-topic>` | Show a memory by id or topic |",
  "| `/memories search <query>` | Search memory records |",
  "| `/remember <text>` | Ask the Planner to record a memory |",
  "| `/forget <id>` | Ask the Planner to archive a memory |",
];

function resolveLocalCommand(cmd: string): LocalChatCommand | undefined {
  for (const c of LOCAL_CHAT_COMMANDS) {
    if (c.name === cmd) return c;
    if (c.aliases?.includes(cmd)) return c;
  }
  return undefined;
}

/** Returns the reply string, or null if `content` is not a recognised local command. */
export async function dispatchLocalCommand(
  content: string,
  ctx: LocalCommandContext,
): Promise<string | null> {
  if (!content.startsWith("/")) return null;
  const spaceIdx = content.indexOf(" ");
  const cmd  = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const c = resolveLocalCommand(cmd);
  if (!c) return null;

  switch (c.name) {
    case "/help":            return renderHelp();
    case "/status":          return ctx.renderStatus();
    case "/plan":            return ctx.renderPlan();
    case "/history":         return ctx.renderHistory(parseInt(args, 10) || 5);
    case "/replan":          return createNote(ctx, args || REPLAN_DEFAULT_REASON, false, true);
    case "/restart-planner": return restartPlanner(ctx, args);
    case "/note":            return args ? createNote(ctx, args, false, false) : USAGE_NOTE;
    case "/note!":           return args ? createNote(ctx, args, false, true)  : USAGE_NOTE_URGENT;
    case "/notep":           return args ? createNote(ctx, args, true,  false) : USAGE_NOTEP;
  }
  return null; // unreachable: every LOCAL_CHAT_COMMANDS name has a case.
}

export function renderHelp(): string {
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
  const flags = [permanent ? "permanent" : null, urgent ? "urgent" : null].filter(Boolean).join(", ");
  const flagStr = flags ? ` (${flags})` : "";
  return `Note created: \`${note.id}\`${flagStr}\nThe Planner will decide how to handle it when it next sees pending notes.${urgent ? "\nMarked high priority; no running work was interrupted." : ""}`;
}

export async function restartPlanner(ctx: LocalCommandContext, reason: string): Promise<string> {
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

Notes on the prose carried over:

- The note-success message previously contained a `Note created` emoji (`📝`) at [src/agents/chat.ts](src/agents/chat.ts#L477). Per loop convention §"No emojis", F30 drops it. This is the only user-visible string change in F30; document it in the commit message.
- The `restartPlanner` reply text, the `REPLAN_DEFAULT_REASON`, and the three USAGE strings are copied verbatim from the current `chat.ts` so behaviour is preserved.

### Step 3 — Edit `src/agents/chat.ts`

Apply these edits in one pass via `multi_replace_string_in_file`:

1. **Imports**: add `import { dispatchLocalCommand, restartPlanner } from "../chat/localCommands.js";`.
2. **Delete the `switch` block**: at [src/agents/chat.ts](src/agents/chat.ts#L330-L361), replace the entire `const spaceIdx … switch (cmd) { … }` body of `tryHandleCommand` with:

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

   Add the `LocalCommandContext` type-only import alongside the function imports.

`cmdStatus`, `cmdPlan`, `cmdHistory` remain unchanged — they read project state via `this.ctx.project.paths` and stay on the class because they are not pure functions of a context object.

### Step 4 — New test file `src/chat/localCommands.test.ts`

Vitest spec covering:

1. **Dispatch table**:
   - For each entry in `LOCAL_CHAT_COMMANDS`, `dispatchLocalCommand("/<name>", ctx)` returns a non-null string.
   - For `/restart-planner` and its alias `/planner-restart`, both dispatch to the same path (assert via a spy on `ctx.plannerControl.requestRestart`).
   - `dispatchLocalCommand("/bogus", ctx)` returns `null`.
   - `dispatchLocalCommand("not-a-command", ctx)` returns `null`.
   - Case-insensitive: `dispatchLocalCommand("/HELP", ctx)` returns the help body.
2. **Argument handling**:
   - `/history` with empty args defaults to `n=5` (assert `ctx.renderHistory` called with `5`); with `/history 12` calls with `12`; with `/history banana` defaults to `5`.
   - `/replan` with empty args uses `REPLAN_DEFAULT_REASON`; with text uses the text. Assert via a spy on the `notesDir` write or by replacing `createUserNote` with a vitest mock.
   - `/note`, `/note!`, `/notep` with empty args each return their usage string verbatim.
3. **`renderHelp` output**:
   - Contains exactly one row per `LOCAL_CHAT_COMMANDS` entry, in declaration order, formatted as `` `| \`${usage}\` | ${help} |` ``.
   - Contains every string in `MEMORY_SKILL_HELP_ROWS` immediately after the local rows.
   - Ends with `"Any other message is handled by the AI assistant."` as the last non-empty line.
4. **Structural guards** (regressions of the F30 issue):
   - The output of `renderHelp()` contains `/restart-planner` (the canonical name). Aliases are NOT listed as separate rows in the table (covered by enumerating `LOCAL_CHAT_COMMANDS`).
   - `src/agents/chat.ts` source file (read via `fs.readFileSync`) contains no `case "/` literal. This catches future regressions where someone re-introduces an inline `case` instead of editing `LOCAL_CHAT_COMMANDS`.
   - `src/agents/chat.ts` contains no `private cmdHelp` literal.

`createUserNote` is mocked via `vi.mock("../runtime/notes.js")` so the test does not touch the filesystem.

### Step 5 — Verify no other call sites broke

`grep -n "cmdHelp\|cmdNote\|cmdRestartPlanner" src/` must return only matches inside [src/chat/localCommands.ts](src/chat/localCommands.ts) (the new module) and the `cmdStatus`/`cmdPlan`/`cmdHistory` methods that remain. Any other match is a missed call site.

## Test strategy

### Existing tests covering this area

- [src/chat/slashCommands.test.ts](src/chat/slashCommands.test.ts) — memory/skill family only. F30 does not modify this file or the code it tests.
- No existing `chat.test.ts` for the local family — that is part of why the duplication has survived.

### New tests

- [src/chat/localCommands.test.ts](src/chat/localCommands.test.ts) — new, scope per Step 4 above. Approximately 12-15 `it(...)` blocks.

### Validation commands

Run from the repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/chat/localCommands.test.ts
npx vitest run src/chat/                 # also re-runs the existing slashCommands.test.ts to confirm no cross-impact
npx vitest run                            # full suite, must stay green
npm run lint                              # confirms no unused-import or no-undef issues from the imports edit
```

Pre-merge gate: all five commands must pass. The full `npx vitest run` is the canonical regression check because there is no chat-agent integration test that the focused command would skip.

## Rollback strategy

Single commit. All edits are confined to:

- `src/chat/localCommands.ts` (new file — delete to roll back)
- `src/chat/localCommands.test.ts` (new file — delete to roll back)
- `src/agents/chat.ts` (the dispatch + cmdHelp removal — `git checkout HEAD~1 -- src/agents/chat.ts` to roll back)
- `src/agents/conventions.ts` (only edited if F18 has not landed)

`git revert <sha>` is sufficient. No data-shape changes, no on-disk format changes, no schema migrations.

## Risk notes

- **No emoji** in the new `createNote` reply. This is a visible string change: clients displaying the assistant message will see no leading `📝`. The change is forced by loop convention §"No emojis"; document in the commit body.
- **`LOCAL_CHAT_COMMANDS` placement** in `src/agents/conventions.ts` is awkward (it is not a "convention" in the territory-rule sense). F30 inherits F18's placement and does not relocate. A separate follow-up (not F30, not F18) can move the registry to `src/chat/` if reviewers wish; F30 does not gate on that decision.
- **No interaction with `parseSlashCommand`** — verified by structural grep test in Step 4.4; the two-tier dispatch order in `tryHandleCommand` (memory family first, local family second) is preserved.
- **`tryHandleExplicitPlannerRestart`** uses the same `restartPlanner` function imported from the new module; behaviour identical to the pre-F30 path (it currently calls `this.cmdRestartPlanner(content)` directly).
