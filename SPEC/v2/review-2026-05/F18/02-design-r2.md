# F18 — Design r2

## Changes from r1

- **Scope tightened around the skills/memory subsystem.** r1 said the slash-command source of truth would drive Chat's prompt list, `/help`, and `tryHandleCommand` collectively. Per loop convention §"Out-of-scope" and the F18 round-2 brief, `src/skills/` and the four memory/skill slash-command handlers in `src/agents/chat.ts` (`/skills`, `/memories`, `/remember`, `/forget`) are owned by another agent. r2 explicitly excludes those handlers and the `parseSlashCommand` / `runSlashCommand` routing in [src/chat/slashCommands.ts](src/chat/slashCommands.ts) from F18's edits.
- **Slash-command unification scaled down to the local-Chat command family only** (the nine commands the local `switch` in [src/agents/chat.ts](src/agents/chat.ts#L331-L360) already owns: `/help`, `/status`, `/plan`, `/history`, `/replan`, `/restart-planner`+`/planner-restart`, `/note`, `/note!`, `/notep`). The memory/skill family remains parse-routed by `parseSlashCommand` and is not touched.
- **F30 cross-link clarified, not subsumed.** F18 removes the prompt-text copy of the local-command list. The remaining triplication between the local switch and the `/help` Markdown table is for F30 to close. F18 does NOT modify `cmdHelp`.
- **No claim that the `/help` table is a consumer of `CHAT_COMMANDS`.** r1's Proposal B implied it; r2 drops that.
- **Deployment service name corrected.** r1's Plan referenced a nonexistent `saivage-v3.service`. The Saivage v2 systemd unit deployed to the `saivage-v3` LXC container is `saivage.service` per [deploy/Makefile](deploy/Makefile#L44-L58) and [deploy/scripts/provision.sh](deploy/scripts/provision.sh#L127-L147). r2 carries this correction into the recommendation and the cross-cutting validation discussion; the Plan applies it operationally.
- Recommendation unchanged: still **Proposal B**.

---

## Proposal A — Trim and dedupe in place (focused fix)

### Scope

Edit only `src/agents/*.ts` and `src/agents/conventions.ts`. No new directories, no build-time copying, no IO.

### What changes

1. Extract the repeated paragraphs into named string constants in [src/agents/conventions.ts](src/agents/conventions.ts):
   - `AGENT_ROSTER_PROMPT` — the "Saivage system / agent hierarchy" paragraph that today appears in Planner, Manager, Inspector, Chat.
   - `COMMUNICATION_PROTOCOL_PROMPT` — the "agents communicate via structured returns" paragraph.
   - `PERSISTENCE_PROMPT` — the `.saivage/plan.json`, `plan-history.json`, `stages/`, `tmp/state/runtime.json` paragraph.
   - `CORRECTIVE_ACTION_PROMPT` — the "evaluate, fix or escalate" paragraph reused by Planner and Manager.
   - `WORKER_CONTRACT_PROMPT` — the `TaskReport` shape and "checklist + issues_found" rules duplicated across Coder, Researcher, Reviewer, Data Agent.
2. Each role prompt becomes `[AGENT_ROSTER_PROMPT, ROLE_SPECIFIC, ...].join("\n\n")` — the role-specific block holds only what is unique to the role.
3. `VISIBLE_EXECUTION_STYLE_PROMPT` moves from `base.ts` to `conventions.ts` for co-location; `base.ts` imports it.
4. Trim each prompt against the actual behaviour: stop naming `.saivage/runtime/runtime-state.json` (canonical is `tmp/state/runtime.json`).
5. Delete the stale JSDoc at [src/agents/base.ts](src/agents/base.ts#L104-L105) ("from prompts/<role>.md").
6. **Local-Chat slash commands only**: in Chat's prompt, replace the hand-typed slash-command list (which today enumerates only the nine local commands: see [src/agents/chat.ts](src/agents/chat.ts#L102-L110)) with a `<<SLASH_COMMANDS>>` placeholder substituted at construction time from a single declarative `LOCAL_CHAT_COMMANDS` array. The `parseSlashCommand` path in [src/chat/slashCommands.ts](src/chat/slashCommands.ts) and its handler hook at [src/agents/chat.ts](src/agents/chat.ts#L300-L329) are untouched.
7. Any prose in prompts that names default config values is removed; agents are told to read `.saivage/config.json`.

### What it forbids

- TS files cannot grow new shared prompt prose outside `conventions.ts`.
- Prompts must not restate defaults or paths that exist in `config.ts`.

### Risk

Low surface: only `src/agents/*.ts`. Behavioural risk on LLM output is medium (trimming prompts can change agent decisions). Mitigated by the existing agent test suite.

### What it enables / forbids

- F02 roster drift becomes structurally impossible.
- F30: this only removes the *prompt-text* copy. The remaining duplication between the `/help` Markdown table and the local-command `switch` is F30's job; F18 does not pretend to fix it.
- F31 stops promising files that do not exist (JSDoc removed).
- F09: `WORKER_CONTRACT_PROMPT` is one symbol, not four.

### What it does not do

Operators still cannot ship prompt tweaks without a `tsup` rebuild. Prompts still live mixed with code at file-open time.

### Recommendation note

Lower complexity, lower payoff. Worth it only if iteration-latency on prompts is acceptable.

---

## Proposal B — Move prompts to `prompts/*.md` and load at startup (one level up)

### Scope

New top-level directory `prompts/`. New module `src/agents/prompts.ts` that loads files synchronously. Build change in `tsup.config.ts` to ship `prompts/` into `dist/`. Delete all `*_PROMPT` TS constants under `src/agents/`. `src/agents/conventions.ts` gains a small declarative `LOCAL_CHAT_COMMANDS` array plus `renderLocalChatCommandsTable()`; that is the **only** programmatic substitution introduced by F18.

**Out of scope (owned by the skills/memory agent), F18 will not modify:**
- `src/skills/` and `SPEC/v2/skills-memory/` and `SPEC/v2/skills/`.
- The `parseSlashCommand`/`runSlashCommand` module at [src/chat/slashCommands.ts](src/chat/slashCommands.ts).
- The `parseSlashCommand(...)` hook in [src/agents/chat.ts](src/agents/chat.ts#L300-L329) which forwards `/skills`, `/memories`, `/remember`, `/forget` to that module.
- The `/help` rows for `/skills`, `/memories`, `/remember`, `/forget` in `cmdHelp` at [src/agents/chat.ts](src/agents/chat.ts#L379-L385). The `/help` text is not externalised by F18.

### Layout

```
prompts/
  shared/
    roster.md
    communication-protocol.md
    persistence.md
    corrective-action.md
    execution-style.md          # ex VISIBLE_EXECUTION_STYLE_PROMPT
    worker-contract.md
  planner.md
  manager.md
  coder.md
  researcher.md
  data-agent.md
  reviewer.md
  inspector.md
  chat.md
  designer.md
```

Each role file uses a small marker syntax for include-and-substitute:

```md
# Planner — System Prompt

{{> shared/roster}}

{{> shared/communication-protocol}}

## Your Role
...

## Slash Commands

{{slash_commands_table}}
```

`{{> path}}` is a literal include (no expressions). `{{name}}` is a programmatic substitution. Two markers only. No conditionals, no loops, no expressions. Anything more is a template engine and not justified.

### Loader contract

New module `src/agents/prompts.ts`:

```ts
export type RolePromptName =
  | "planner" | "manager" | "coder" | "researcher"
  | "data-agent" | "reviewer" | "inspector" | "chat" | "designer";

export function loadRolePrompt(role: RolePromptName): string;
```

- Resolves prompt root via `import.meta.url`: in source, `<repoRoot>/prompts`; in bundle, `<dist>/prompts` (mirrors what `tsup` already does for `skills/builtin` at [tsup.config.ts](tsup.config.ts#L14-L19)).
- Reads synchronously at first call using `node:fs.readFileSync` (matches the synchronous-construction constraint from analysis §Constraints).
- Caches the rendered string per role.
- Substitution map is exactly one entry today: `slash_commands_table` ← `renderLocalChatCommandsTable()`. Only `prompts/chat.md` consumes it.

### Slash-command source of truth — what is and is not unified

F18 introduces ONE source of truth, scoped to the **local Chat command family**:

```ts
// src/agents/conventions.ts (added)
export interface LocalChatCommand {
  name: string;
  aliases?: string[];
  usage: string;
  help: string;
}

export const LOCAL_CHAT_COMMANDS: LocalChatCommand[] = [ /* 9 entries */ ];

export function renderLocalChatCommandsTable(): string { /* markdown bullet list */ }
```

It drives **only** the `{{slash_commands_table}}` placeholder in `prompts/chat.md`. After F18 lands, the local-command list in `chat.md` is one source instead of one-of-three; the existing `switch` in `tryHandleCommand` still hand-codes the dispatch (F30's remaining cleanup is to make the switch loop over `LOCAL_CHAT_COMMANDS`).

The memory/skill command family (`/skills`, `/memories`, `/remember`, `/forget`) is OWNED by another agent. F18:
- Does NOT add those names to `LOCAL_CHAT_COMMANDS`.
- Does NOT touch [src/chat/slashCommands.ts](src/chat/slashCommands.ts).
- Does NOT touch the `parseSlashCommand` call in [src/agents/chat.ts](src/agents/chat.ts#L300-L329).
- Does NOT touch the `/skills` / `/memories` / `/remember` / `/forget` rows in `cmdHelp` at [src/agents/chat.ts](src/agents/chat.ts#L379-L385).
- The today-prompt's "Slash Commands" section ([src/agents/chat.ts](src/agents/chat.ts#L102-L110)) lists ONLY the nine local commands — no skills/memories rows. So replacing it with `{{slash_commands_table}}` is content-preserving.

### Build & deployment

- Extend `tsup.config.ts` `onSuccess`:
  ```ts
  await mkdir("dist/prompts", { recursive: true });
  await cp("prompts", "dist/prompts", { recursive: true });
  ```
- `src/agents/prompts.ts` finds the prompts directory relative to its own URL: in dev, `../../prompts/`; bundled, `./prompts/` (sibling to `dist/cli.js`).
- The deployed systemd unit on the `saivage-v3` LXC is `saivage.service` (see [deploy/Makefile](deploy/Makefile#L44-L58), [deploy/scripts/provision.sh](deploy/scripts/provision.sh#L127-L147)). r1's Plan referenced a nonexistent `saivage-v3.service`; r2's Plan uses the right name.

### Per-role file size after extraction

Estimated lines per `prompts/<role>.md` after de-duping into `shared/`: roughly 35–60 lines of role-unique guidance vs 55–245 today.

### `BaseAgent` and constructors

- Each agent constructor calls `loadRolePrompt("planner")` instead of `PLANNER_PROMPT`. Same `BaseAgent` API.
- `BaseAgentConfig.systemPrompt` JSDoc is rewritten to: `/** Rendered role prompt (see prompts/<role>.md and src/agents/prompts.ts). */`. F31 is resolved.
- Tests keep passing `{ systemPrompt: "sys" }` directly — loader bypassed for unit tests, exactly as today.

### Risk

- One new module, one bundling step, one filesystem read on startup. All matched by the existing `skills/builtin` precedent.
- Same prompt-content risk as A.
- Asset-path bug class is real: caught by a vitest integration test that loads each role once.

### What it enables

- Operators iterate prompts by editing `.md` and restarting the runtime; no `tsc`, no `tsup`, no escaping backticks for JSON inside prompts.
- F02 roster: one file (`shared/roster.md`).
- F30: F18 collapses the prompt-text copy of the local-command list; F30 owner then deduplicates the `cmdHelp` table and the local `switch` against `LOCAL_CHAT_COMMANDS` (or against itself; F18 stays out).
- F31: JSDoc becomes accurate.
- F09: shared worker contract is one Markdown file.
- F33: prompts stop naming defaults.

### What it forbids

- No new prompt prose in `src/agents/*.ts`. Vitest guard: a test grep-fails if any `*_PROMPT\s*=\s*\`` reappears under `src/agents/`.
- No third include syntax. Two markers, period.
- No async loader.
- F18 does not import from `src/skills/`, does not import from `src/chat/slashCommands.ts`, and does not edit those files. Substitution map has exactly one key.

### Recommendation note

This is the right architectural target. It implements what `BaseAgentConfig.systemPrompt`'s JSDoc has been promising. The `tsup` `onSuccess` pattern is already in production for `skills/builtin`; adding `prompts/` is a same-shape change.

---

## Proposal C — Pull a real template engine (Handlebars / Eta / mustache)

Considered and rejected. Adding a 30–100 KB runtime dependency, learning a syntax surface (partials, helpers, escape modes), and inheriting its CVE feed buys nothing over the two-marker include in Proposal B. The substitutions we need are: one literal include, one variable. A real engine is gold-plating and violates project guideline §2 (no premature configurability).

---

## Recommendation

**Proposal B.**

Reasons:
1. It implements what `BaseAgentConfig.systemPrompt`'s JSDoc has been documenting since the type was written — closing F31 properly rather than by deleting an aspiration.
2. The build pattern (`tsup` `onSuccess` copying non-TS assets to `dist/`) is already in production for `skills/builtin`; adding `prompts/` is a same-shape change with low risk.
3. It is the cheapest way to make F02, F09, F33 structurally hard to regress and to leave F30 a clean follow-up: one shared file per concern, included by reference.
4. Iteration latency on prompts collapses from "edit TS, rebuild, restart" to "edit .md, restart" — prompts are the primary quality lever per F18's stated motivation.
5. The synchronous-read constraint is real but tiny: 9 files, totaling under ~50 KB on disk, read once at agent construction.

Proposal A is a strict subset of B's prompt-content work without the externalisation; picking A then later picking B means doing the prompt rewrite twice.
