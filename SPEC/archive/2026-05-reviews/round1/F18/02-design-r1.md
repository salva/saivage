# F18 — Design r1

## Proposal A — Trim and dedupe in place (focused fix)

### Scope

Edit only `src/agents/*.ts` and `src/agents/conventions.ts`. No new directories, no build-time copying, no IO.

### What changes

1. Extract the repeated paragraphs into named string constants in [src/agents/conventions.ts](src/agents/conventions.ts):
   - `AGENT_ROSTER_PROMPT` — the "Saivage system / agent hierarchy" paragraph that today appears in Planner, Manager, Inspector, Chat. Pulled once, referenced by name.
   - `COMMUNICATION_PROTOCOL_PROMPT` — the "agents communicate via structured returns" paragraph. Same hosts.
   - `PERSISTENCE_PROMPT` — the `.saivage/plan.json`, `plan-history.json`, `stages/`, `tmp/state/runtime.json` paragraph.
   - `CORRECTIVE_ACTION_PROMPT` — the "evaluate, fix or escalate" paragraph reused by Planner and Manager.
   - `WORKER_CONTRACT_PROMPT` — the `TaskReport` shape and "checklist + issues_found" rules duplicated across Coder, Researcher, Reviewer, Data Agent.
2. Each role prompt becomes `[AGENT_ROSTER_PROMPT, ROLE_SPECIFIC, ...].join("\n\n")` — the role-specific block holds only what is unique to the role.
3. `VISIBLE_EXECUTION_STYLE_PROMPT` moves from `base.ts` to `conventions.ts` for co-location with the other shared blocks; `base.ts` imports it.
4. Trim each prompt against the actual behaviour: delete sections that no longer match the code (e.g. mentions of `.saivage/runtime/runtime-state.json` are downgraded to the canonical `tmp/state/runtime.json` — already the live path per workspace memory).
5. Delete the stale JSDoc at [src/agents/base.ts](src/agents/base.ts#L104-L105) ("from prompts/<role>.md") — it advertises a layout that does not exist in this proposal.
6. F30 alignment: in Chat's prompt, replace the hand-typed slash-command list with a comment `<<SLASH_COMMANDS>>` placeholder substituted at construction time from a single declarative `COMMANDS` array. This stops the triplication caught by F30; the Chat prompt no longer maintains the list.
7. F33 alignment: any prose in prompts that names default config values (provider, models, channels) is removed; agents are told to read `.saivage/config.json` instead of being told what the defaults are.

### What it forbids

- TS files cannot grow new shared prompt prose anywhere except `conventions.ts`.
- Prompts must not restate defaults or paths that exist in `config.ts` — they must reference them by name and let the agent read.

### Risk

- Low surface: only `src/agents/*.ts`. No new IO, no build change, no deployment change.
- Behavioural risk on LLM output is medium: trimming prompts can change agent decisions. Mitigated by running the existing agent test suite and the integration smoke test.

### What it enables

- F02 roster drift becomes structurally impossible — single string.
- F30 triplication: shrinks to duplication (handler + COMMANDS list — F30 then reduces to a follow-up cleanup of the `/help` table).
- F31 stops promising files that do not exist (JSDoc removed).
- F09 worker base refactor lands more cleanly: `WORKER_CONTRACT_PROMPT` is one symbol, not four.
- F33: defaults stop being whispered through prompts.

### What it does not do

- Operators still cannot ship prompt tweaks without a build. (Acceptable trade-off if iteration latency is acceptable today.)
- Prompts still mixed with code at file-open time.

### Recommendation note

Lower complexity, lower payoff. Worth it only if the team accepts that prompt iteration stays at "edit TS + rebuild".

---

## Proposal B — Move prompts to `prompts/*.md` and load at startup (one level up)

### Scope

New top-level directory `prompts/`. New module `src/agents/prompts.ts` that loads files. Build change in `tsup.config.ts` to ship `prompts/` into `dist/`. Delete all `*_PROMPT` TS constants. `conventions.ts` becomes the single source of shared, programmatic blocks (roster, slash commands, default paths) that get inlined into the role prompts at load time.

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

Each role file uses a small marker syntax for include-and-substitute, e.g.:

```md
# Planner — System Prompt

{{> shared/roster}}

{{> shared/communication-protocol}}

## Your Role
...

## Slash Commands

{{slash_commands_table}}
```

`{{> path}}` is a literal include (no expressions). `{{name}}` is a programmatic substitution sourced from `conventions.ts`. Two markers only. No conditionals, no loops, no expressions — anything more is a template engine and not justified by current need.

### Loader contract

New module `src/agents/prompts.ts`:

```ts
export type RolePromptName =
  | "planner" | "manager" | "coder" | "researcher"
  | "data-agent" | "reviewer" | "inspector" | "chat" | "designer";

export function loadRolePrompt(role: RolePromptName): string;
```

- Resolves prompt root via `import.meta.url`: in source, `<repoRoot>/prompts`; in bundle, `<dist>/prompts` (mirrors what `tsup` already does for `skills/builtin` at [tsup.config.ts](tsup.config.ts#L14-L19)).
- Reads synchronously at first call using `node:fs.readFileSync` (matches the synchronous-construction constraint identified in analysis §Constraints).
- Caches the rendered string per role (prompts do not change in-process).
- Substitution map is built from `conventions.ts`:
  - `slash_commands_table` ← rendered from a single declarative `COMMANDS` array (the F30 fix).
  - `default_paths` ← string built from `config.ts` defaults (the F33 alignment).
  - `agent_roster` is an include via `{{> shared/roster}}`, not a substitution.

### Build & deployment

- Extend `tsup.config.ts` `onSuccess`:
  ```ts
  await mkdir("dist/prompts", { recursive: true });
  await cp("prompts", "dist/prompts", { recursive: true });
  ```
- `src/agents/prompts.ts` finds the prompts directory relative to its own URL: in dev, `../../prompts/`; bundled, `./prompts/` (sibling to `dist/cli.js`).
- No runtime config knob for an alternate prompt path. (Add only when a use case appears.)

### Per-role file size after extraction

Estimated lines per `prompts/<role>.md` after de-duping into shared/: roughly 35–60 lines of role-unique guidance, vs 55–245 today.

### `BaseAgent` and constructors

- Each agent constructor calls `loadRolePrompt("planner")` instead of using `PLANNER_PROMPT`. Same `BaseAgent` API.
- `BaseAgentConfig.systemPrompt` JSDoc is rewritten to: `/** Rendered role prompt (see prompts/<role>.md and src/agents/prompts.ts). */`. F31 is resolved.
- Tests keep passing `{ systemPrompt: "sys" }` directly — the loader is bypassed for unit tests, exactly as today.

### Risk

- Higher than A: one new module, one bundling step, one filesystem read on startup. All matched by the existing `skills/builtin` precedent.
- Same prompt-content risk as A (trimming/rewording can change LLM behaviour). Mitigated identically.
- Asset-path bug class is real: must be caught with a vitest integration test that loads each role once.

### What it enables

- Operators iterate prompts by editing `.md` files and restarting the runtime; no `tsc`, no `tsup`, no escaping backticks for JSON inside prompts.
- Diffs of `src/agents/<role>.ts` become purely about behaviour.
- F02 roster: one file (`shared/roster.md`).
- F30 slash commands: one declarative `COMMANDS` array drives the prompt include, the `/help` table, and `tryHandleCommand`. Triplication collapses to a single source.
- F31: comment becomes accurate or is replaced; layout exists.
- F09: shared worker contract block is one Markdown file consumed by every worker prompt.
- F33: prompts stop naming defaults; `default_paths` substitution is the only place that does, and it reads from `config.ts`.

### What it forbids

- No new prompt prose in `src/agents/*.ts`. Lint-style guard: a vitest check that grep-fails the build if any `*_PROMPT = \`` template literal reappears under `src/agents/`.
- No third include syntax. Two markers, period.
- No async loader. Synchronous-only.

### Recommendation note

This is the right architectural target. It is what `BaseAgentConfig.systemPrompt`'s JSDoc has been promising. The build precedent (`skills/builtin`) already does exactly this for sibling assets, so the bundling cost is already paid in pattern-shape.

---

## Proposal C — Pull a real template engine (Handlebars / Eta / mustache)

Considered and rejected. Adding a 30–100 KB runtime dependency, learning a syntax surface (partials, helpers, escape modes), and inheriting its CVE feed buys nothing over the two-marker include in Proposal B. The substitutions we need are: one literal include, one variable. A real engine is gold-plating and violates project guideline §2 (no premature configurability). Not pursued.

---

## Recommendation

**Proposal B.**

Reasons:
1. It implements what `BaseAgentConfig.systemPrompt`'s JSDoc has been documenting since the type was written — closing F31 properly rather than by deleting an aspiration.
2. The build pattern (`tsup` `onSuccess` copying non-TS assets to `dist/`) is already in production for `skills/builtin`; adding `prompts/` is a same-shape change with low risk.
3. It is the cheapest way to make F02, F09, F30, F33 structurally hard to regress: one shared file per concern, included by reference, not by retyping.
4. Iteration latency on prompts collapses from "edit TS, rebuild, restart" to "edit .md, restart" — and prompts are the primary quality lever per F18's stated motivation.
5. The synchronous-read constraint is real but tiny: 9 files, totaling under ~50 KB on disk, read once at agent construction. The existing `cp("skills/builtin", "dist/skills/builtin")` step already handles a much larger asset tree.

Proposal A is a strict subset of B's prompt-content work without the externalisation. Picking A and later picking B means doing the prompt rewrite twice. Pick B once.
