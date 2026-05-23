# Saivage v2 — Skill + Memory: Functional Analysis

Status: DRAFT (Phase A, round 3)
Author: Claude Opus 4.7 (writer); round-2 fixer: Claude Opus 4.7; round-3 fixer: Claude Opus 4.7
Date: 2026-05-23

---

## 0. Scope and method

This document is a functional analysis only — it does NOT propose a design or
implementation plan. It describes the *current* skill subsystem in Saivage v2
as actually implemented, the *absent* memory subsystem (which exists only as
spec stubs and unimplemented MCP tools), the functional gaps between the two,
and the testable requirements that an integrated Skill+Memory feature must
satisfy.

Evidence cited below is grounded in:

- [src/skills/loader.ts](../../../src/skills/loader.ts) (full file)
- [src/types.ts](../../../src/types.ts) §10 — `SkillEntrySchema`,
  `SkillIndexSchema`
- [src/agents/base.ts](../../../src/agents/base.ts) — `BaseAgent` constructor
- [src/agents/planner.ts](../../../src/agents/planner.ts),
  [manager.ts](../../../src/agents/manager.ts),
  [coder.ts](../../../src/agents/coder.ts),
  [researcher.ts](../../../src/agents/researcher.ts),
  [chat.ts](../../../src/agents/chat.ts),
  [inspector.ts](../../../src/agents/inspector.ts),
  [reviewer.ts](../../../src/agents/reviewer.ts),
  [data-agent.ts](../../../src/agents/data-agent.ts),
  [designer.ts](../../../src/agents/designer.ts)
- [src/mcp/builtins.ts](../../../src/mcp/builtins.ts) — `skillsHandler`,
  `memoryTools` (stub), `indexTools` (stub)
- [src/runtime/notes.ts](../../../src/runtime/notes.ts) — `NoteManager`
- [SPEC/v2/00-AGENT-SYSTEM.md](../00-AGENT-SYSTEM.md)
- [SPEC/v2/04-RUNTIME-DETAILS.md](../04-RUNTIME-DETAILS.md)
- [SPEC/v2/05-MCP-SERVICES.md](../05-MCP-SERVICES.md)
- [SPEC/v2/06-SYSTEM-DESIGN.md](../06-SYSTEM-DESIGN.md)
- [SPEC/v2/skills/](../skills/)
- The three live project state dirs: `saivage-v3/.saivage/`,
  `diedrico/.saivage/`, `getrich/.saivage/` (the latter via the `saivage`
  container working tree).

The author also confirmed, via a workspace-wide grep, that no `memory`-related
code exists outside the stub MCP tool registration; there is no on-disk
memory store, no schema, no loader, no agent integration.

---

## 1. What the current skill system actually does today

### 1.1 The pipeline, end to end

[loader.ts:42](../../../src/skills/loader.ts) `resolveSkills(context,
projectSkillsDir, maxSkills=5)` performs the following, in order:

1. **Discovery** — `collectSkillEntries(projectSkillsDir)`
   ([loader.ts:104](../../../src/skills/loader.ts)) walks two directories in
   precedence order:
   1. `projectSkillsDir` — passed in from
      [base.ts:163](../../../src/agents/base.ts) as
      `ctx.project.paths.skills` (the project's `.saivage/skills/`).
   2. `<thisDir>/../../skills` — relative to `src/skills/`, which resolves
      to the **built-in** `saivage/skills/` shipped in the repo.
   For each directory it reads exactly one file, `<dir>/index.json`, parses
   it with `SkillIndexSchema`, and emits one `EntryWithDir` per entry.
   `seen.add(entry.name)` ensures the project dir wins on name collision.

2. **Target-agent filter** — entries whose
   `target_agents` array is non-empty and does not contain `context.agentRole`
   are dropped. Entries that omit `target_agents` apply to all agents.
   ([loader.ts:49](../../../src/skills/loader.ts))

3. **Trigger scoring** — `scoreTriggers(entry.triggers, context)`
   ([loader.ts:160](../../../src/skills/loader.ts)) iterates the entry's
   triggers, each formatted as `<type>:<value>`, and adds 1 point per match
   against `SkillMatchContext`. Supported types:
   - `keyword:<word>` — case-insensitive `indexOf` against
     `context.description`.
   - `tool:<name>` — exact membership in `context.tools[]`.
   - `path:<glob>` — `*`/`**` glob match against any entry of
     `context.filePaths[]`.
   - `tag:<label>` — exact membership in `context.tags[]`.
   - `agent:<type>` — exact match against `context.agentRole`.
   - A trigger string with no colon is treated as `keyword:<string>`
     ([loader.ts:208](../../../src/skills/loader.ts)).
   Entries with score 0 are dropped.

4. **Ranking** — `sort((a,b) => b.score - a.score || b.updated_at -
   a.updated_at)`. Tie-break is lexicographic on the ISO `updated_at`
   string, so "most recently updated" wins ties.
   ([loader.ts:65](../../../src/skills/loader.ts))

5. **Budget** — top `maxSkills` are kept. `maxSkills` defaults to 5 and is
   read from `ctx.project.config.skills.max_per_agent`
   ([base.ts:164](../../../src/agents/base.ts),
   [types.ts:34](../../../src/types.ts)).

6. **Content load** — `loadSkillContent(entry.file, dir)` reads the markdown
   file relative to the directory the entry came from.
   ([loader.ts:223](../../../src/skills/loader.ts))

7. **Prompt injection** — `formatSkillsForPrompt(skills)`
   ([loader.ts:88](../../../src/skills/loader.ts)) emits a block per skill:
   ```
   --- SKILL: <name> ---
   <full file content>
   ---
   ```
   The blocks are joined with blank lines and appended to the agent's static
   system prompt at construction time
   ([base.ts:160-174](../../../src/agents/base.ts)). They are part of the
   *system message*, not a separate message — they sit in front of the
   conversation for the entire agent lifetime.

### 1.2 Who creates skills, and when

- **Loader** never writes. It is read-only.
- **MCP `skills` service**
  ([builtins.ts:1053](../../../src/mcp/builtins.ts)) exposes
  `list_skills`, `read_skill`, `create_skill`, `update_skill`. These are
  the only *skills-service* write paths. Any role with filesystem write
  access (e.g. `write_file`, [builtins.ts:278](../../../src/mcp/builtins.ts))
  can also edit `index.json` and skill markdown directly — an escape
  hatch worth tracking as an integrity hole (see §1.6).
- **Spec vs runtime divergence (important).** Two different access
  controls coexist:
  - **Spec access matrix**
    ([05-MCP-SERVICES.md:40](../05-MCP-SERVICES.md), labelled
    "convention-based" at [05-MCP-SERVICES.md:29](../05-MCP-SERVICES.md))
    grants the `skills` service to the Coder only.
  - **Runtime tool filter** in
    [base.ts:609-612](../../../src/agents/base.ts) applies
    `ROLE_TOOL_FILTER` per role:
    [base.ts:982-985](../../../src/agents/base.ts) defines
    `WORKER_EXCLUDED_TOOLS = { …PLAN_TOOLS, create_skill, update_skill }`;
    [base.ts:1009-1011](../../../src/agents/base.ts) applies that
    exclusion to Coder, Researcher, and Data Agent;
    [base.ts:990](../../../src/agents/base.ts) leaves unlisted roles
    unfiltered.
    Net effect of the runtime filter:

    | Role        | `list_skills` / `read_skill` | `create_skill` / `update_skill` |
    |-------------|------------------------------|---------------------------------|
    | planner     | yes (read-only allow-list)   | no                              |
    | manager     | yes (no filter)              | **yes**                         |
    | coder       | yes (workers excluded only from write) | **no**                |
    | researcher  | yes                          | no                              |
    | data_agent  | yes                          | no                              |
    | inspector   | yes (read-only allow-list)   | no                              |
    | reviewer    | yes (read-only allow-list)   | no                              |
    | designer    | yes (no filter)              | **yes**                         |
    | chat        | yes (no filter)              | **yes**                         |

  - i.e. **runtime grants skill-write to Manager, Designer, and Chat**,
    while denying it to the role the spec names. This is a Phase B
    decision point: reconcile spec to code, code to spec, or pick a new
    matrix. Treat the runtime filter as the source of truth for what
    *currently happens*; treat the spec matrix as aspirational.

#### 1.2.1 Full runtime access matrix (per role, today)

Sourced from [src/agents/base.ts](../../../src/agents/base.ts) `ROLE_TOOL_FILTER`
(L982-L1011) and [src/mcp/builtins.ts](../../../src/mcp/builtins.ts) service
registration (L1166-L1168, `memory` and `index` registered with
`{ available: false }` → omitted by `runtime.ts` `getAllTools()` L217-L222
and rejected by `callTool()` L180-L184). "skill-read" = `list_skills` /
`read_skill`; "skill-write" = `create_skill` / `update_skill`;
"memory-read/write" = `memory_*` stubs; "index-read/write" = `index_*`
stubs; "fs-write" = `write_file`.

| Role        | skill-read | skill-write | memory-read | memory-write | index-read | index-write | fs-write |
|-------------|------------|-------------|-------------|--------------|------------|-------------|----------|
| planner     | yes (allow-list) | no          | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | no       |
| manager     | yes (unfiltered) | **yes**     | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | yes      |
| coder       | yes (worker)     | no (worker-excluded) | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | yes      |
| researcher  | yes (worker)     | no (worker-excluded) | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | yes      |
| data_agent  | yes (worker)     | no (worker-excluded) | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | yes      |
| inspector   | yes (allow-list) | no          | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | no       |
| reviewer    | yes (allow-list) | no          | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | no       |
| designer    | yes (unfiltered) | **yes**     | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | yes      |
| chat        | yes (unfiltered) | **yes**     | no (unavailable) | no (unavailable) | no (unavailable) | no (unavailable) | yes      |

Key takeaways used by §2 / §4 / §7:

- Every role can read skills today; the spec's "Coder only" grant for
  the `skills` service does not match runtime reality.
- Skill *write* is reachable by Manager, Designer, and Chat — three
  roles the spec does not grant write access to — and denied to Coder,
  the role the spec names.
- No role can call any memory or index tool today, regardless of what
  the spec access matrix says (the services are unavailable, not
  merely empty).
- The Manager spec ([00-AGENT-SYSTEM.md](../00-AGENT-SYSTEM.md) §2.2)
  describes the Manager as "Schedules **skill generation** after a tool
  or pattern is established that will be reused" — i.e. dispatches a
  Coder. The runtime filter accidentally lets the Manager also call
  `create_skill` itself.
- Trigger: a human reading the spec, or the Manager noticing during stage
  execution. There is no automatic trigger — no agent watches for
  "I just did this for the second time, promote it to a skill".

### 1.3 How skills are surfaced to each agent type

Each agent constructor passes a `skillContext` to `BaseAgent`. Surveyed
across the agent files (line refs are skillContext construction sites):

| Agent       | `agentRole` | `description` source                | `tools` | `filePaths` | `tags`              | Ref |
|-------------|-------------|--------------------------------------|---------|-------------|---------------------|-----|
| planner     | `planner`   | `"Strategic planning and stage dispatch"` (constant) | — | — | —                   | [planner.ts:177-180](../../../src/agents/planner.ts) |
| manager     | `manager`   | `stage.objective`                    | — | — | `stage.tags`        | manager.ts |
| coder       | `coder`     | `task.description`                   | — | — | `task.tags ?? []`   | coder.ts |
| researcher  | `researcher`| `task.description`                   | — | — | `task.tags ?? []`   | researcher.ts |
| inspector   | `inspector` | request scope / question             | — | — | —                   | inspector.ts |
| reviewer    | `reviewer`  | `task.description`                   | — | — | `task.tags ?? []`   | [reviewer.ts:90-94](../../../src/agents/reviewer.ts) |
| data-agent  | `data_agent`| `task.description`                   | — | — | `task.tags ?? []`   | [data-agent.ts:83-87](../../../src/agents/data-agent.ts) |
| designer    | `designer`  | `task.description`                   | — | — | `task.tags ?? []`   | [designer.ts:84-88](../../../src/agents/designer.ts) |
| chat        | `chat`      | `"User-facing chat interface"` (constant) | — | — | —             | [chat.ts:156-159](../../../src/agents/chat.ts) |

Three consequences:

1. `tool:<name>` and `path:<glob>` trigger types are **functionally dead**:
   no agent ever populates `context.tools` or `context.filePaths`. The
   spec ([06-SYSTEM-DESIGN.md](../06-SYSTEM-DESIGN.md) §2.6) advertises
   these trigger types as supported. The loader implements them. But the
   call sites never feed the data needed for them to fire.
2. For workers (coder, researcher, data_agent, designer) and Reviewer,
   `agent:`, `tag:`, and content-aware `keyword:` triggers all fire
   (the description is a real task description, and tags are passed).
3. For Planner and Chat, both `tag:` and the only-useful `keyword:`
   matches are limited to the **static boilerplate description**
   (`"Strategic planning and stage dispatch"`,
   `"User-facing chat interface"`). They never receive tags, never
   reference the current objective, and never reference the user's
   message. Effectively only `agent:<planner>` / `agent:<chat>` triggers
   can deliberately target them today.

### 1.4 Where skills physically live (and don't)

**Repo built-in (`saivage/skills/`):**
- Directory structure: `coding/SKILL.md`, `planning/SKILL.md`,
  `research/SKILL.md`, `mcp-authoring/SKILL.md`. One markdown per topic
  using **YAML frontmatter** (`name`, `description`, `version`,
  `agentTypes`, `triggers`). Example:
  [`coding/SKILL.md`](../../../skills/coding/SKILL.md):
  ```yaml
  ---
  name: coding
  agentTypes: [coder]
  triggers: [write, implement, fix, refactor, code, function, class, module]
  ---
  ```
- **There is no `index.json` at `saivage/skills/`.** Verified by
  `ls -la saivage/skills/`. The loader's built-in branch joins
  `thisDir, "..", "..", "skills"` at
  [loader.ts:116](../../../src/skills/loader.ts); in source the path
  resolves to `saivage/skills/`, but the *production runtime* runs from
  the single tsup bundle `dist/cli.js` (see
  [tsup.config.ts](../../../tsup.config.ts),
  [package.json](../../../package.json)): in the bundled output the
  same join lives in `dist/cli.js` and points *outside* `dist`, into a
  sibling `skills/` directory that does not exist alongside the
  deployed dist. So the built-in branch fails twice: no `index.json`
  in source, no `skills/` directory next to dist in production. Either
  way the `if (!rawIndex) continue;` path at
  [loader.ts:121](../../../src/skills/loader.ts) silently emits zero
  entries. **The built-in skills are dead code today — never loaded,
  in source-run or in production.**

**Project-level (`<project>/.saivage/skills/`):**
- Spec format: `index.json` of shape `{ skills: SkillEntry[] }` plus
  individual markdown files. `SkillEntry` schema
  ([types.ts:250](../../../src/types.ts)): `{ name, file, description,
  triggers[], target_agents?, created_at, updated_at }`.
- **None of the three reviewed live deployments have a `skills/`
  directory.** Verified for `saivage-v3/.saivage/`,
  `diedrico/.saivage/`, and `getrich/.saivage/` (all three lack a
  `skills/` entry). The runtime presumably creates the path lazily on
  first call but does not seed it. This is local evidence; a broader
  claim about all deployments is not supported.

So in the three checked deployments, in production today, **zero skills
are loaded into any agent context**.

### 1.5 Spec-vs-code-vs-disk inconsistencies

These are flagged for the reviewer; they are not bugs we are asked to fix
in this analysis but they shape the gap analysis below.

1. **Two skill file formats in the source tree.** The built-in skills use
   YAML frontmatter with field `agentTypes`. The loader expects an external
   `index.json` with field `target_agents`. The spec
   ([SPEC/v2/skills/skill-creation.md](../skills/skill-creation.md) §3) and
   [05-MCP-SERVICES.md](../05-MCP-SERVICES.md) §6 "v2 Adaptation" reconcile
   these by saying "Add `target_agents` to frontmatter (v1 had
   `agentTypes`)" — but no code parses frontmatter at all. The frontmatter
   form is essentially documentation-only.

2. **`create_skill` produces unmatchable skills, and the skills service
   has no in-band remediation.**
   [builtins.ts:1087-1100](../../../src/mcp/builtins.ts) writes an
   `index.json` entry with `triggers: []` and no `target_agents`. Per
   the loader's `scoreTriggers`, an entry with zero triggers always
   scores 0 and is dropped. The MCP `create_skill` tool schema
   ([builtins.ts:1055](../../../src/mcp/builtins.ts)) accepts only
   `name`, `description`, `content` — no `triggers` parameter.
   `update_skill`
   ([builtins.ts:1057](../../../src/mcp/builtins.ts),
   [builtins.ts:1103-1111](../../../src/mcp/builtins.ts)) accepts
   `name`, `content`, `reason` — it rewrites the markdown only; it
   does not touch `index.json`, does not accept `triggers`, does not
   refresh `updated_at`, and silently discards `reason`. So after
   `create_skill` the only ways to make the skill match are: (a) edit
   `index.json` through the generic filesystem `write_file` tool, or
   (b) hand-edit on the host. The skills service itself provides no
   path to fix triggers, change metadata, record an audit reason, or
   delete an entry (no `delete_skill` exists).

3. **`skillsHandler` resolves a different directory than the loader.**
   [builtins.ts:1061](../../../src/mcp/builtins.ts) computes
   `process.env["SAIVAGE_ROOT"] ?? projectRoot()/.saivage/skills`, while
   the loader uses `ctx.project.paths.skills`. In the normal CLI startup
   these should resolve to the same path, but the two code paths can drift
   (different env handling, different "what is the project root" logic).

4. **No `target_agents` defaulting symmetry between code and spec.** The
   spec lists "Discovery paths in precedence order: 1. builtin, 2. project
   (highest precedence)" (06-SYSTEM-DESIGN.md §2.6). The loader iterates
   project-first, builtin-second, with `seen.add(name)` giving project
   precedence — so the *effect* matches the spec, but the spec's wording
   reverses the order in which the reader expects to see the precedence
   declared.

5. **`Memory` and `Index` services are registered as `available: false`
   and hidden from the agent-facing catalog.**
   [builtins.ts:1167-1168](../../../src/mcp/builtins.ts) registers
   `memory` and `index` with `{ available: false }`;
   [runtime.ts:221](../../../src/mcp/runtime.ts) `getAllTools()` skips
   unavailable in-process services so the tool catalog *omits* them
   entirely; [runtime.ts:182-184](../../../src/mcp/runtime.ts)
   `callTool()` rejects unavailable services before reaching the stub
   handler. **No role today has memory/index in its tool catalog**,
   regardless of what the spec access matrix
   ([05-MCP-SERVICES.md:41-42](../05-MCP-SERVICES.md)) grants. The
   spec matrix's grant of Memory/Index to Coder/Researcher/Inspector
   is aspirational, not operational. The spec
   ([05-MCP-SERVICES.md](../05-MCP-SERVICES.md) §7, §8) explicitly
   says they are unimplemented.

6. **`read_skill` ignores `index.json` entries.**
   [builtins.ts:1073-1079](../../../src/mcp/builtins.ts) calls
   `resolveSkillPath(skillsDir, name)`
   ([builtins.ts:64-68](../../../src/mcp/builtins.ts)) which builds
   `${name}.md` directly. Any index entry whose `file` field is nested
   (e.g. the spec example
   [skill-creation.md:50-58](../skills/skill-creation.md) uses
   `"file": "skills/skill-name.md"`) cannot be read via `read_skill`.
   The loader's content load
   ([loader.ts:241-244](../../../src/skills/loader.ts)) does honour
   `entry.file` — so the loader and the read tool disagree on what
   path to use. The spec's own example would make the loader try
   `.saivage/skills/skills/skill-name.md`, a double-`skills/` path
   that does not exist. Separate inconsistency from §1.5.1.

7. **`path:<glob>` triggers diverge from the spec.** The spec
   ([06-SYSTEM-DESIGN.md:233-236](../06-SYSTEM-DESIGN.md)) says
   `path:<glob>` uses minimatch-like matching;
   [loader.ts:230-236](../../../src/skills/loader.ts) implements a
   hand-rolled regex whose replacement order does not produce real
   globstar semantics. Dead today (§1.3.1) but the code/spec gap
   is real if Phase B keeps the trigger.

8. **`UserNote` / `NoteManager`
   ([src/runtime/notes.ts](../../../src/runtime/notes.ts)) is
   sometimes colloquially called a "memory" channel but is not one.**
   It is a one-direction user→Planner injection mechanism with two
   lifetimes (volatile, deleted after acknowledgment; permanent,
   kept and re-injected after compaction). It does not carry
   agent-authored knowledge and is not visible to
   Manager/Coder/Researcher/Inspector.

### 1.6 Write-path integrity gaps

Separate from the format inconsistencies above:

1. **Skills writes bypass the document store.** The loader reads through
   `readJsonOrNull` + Zod
   ([loader.ts:124,139](../../../src/skills/loader.ts)). But
   `create_skill` and `update_skill` call raw `writeFileSync`
   ([builtins.ts:1086,1100,1110](../../../src/mcp/builtins.ts)) and
   `JSON.stringify` without `SkillIndexSchema` validation. The atomic
   tmp-then-rename helper `writeDoc` in
   [store/documents.ts:66-85](../../../src/store/documents.ts) is
   *not* used by the skills handler. Consequence: a crash mid-write
   can leave a torn `index.json`, and a malformed write is accepted
   (validation only fires on the next read).
2. **No de-duplication.** `create_skill` blindly
   `index.skills.push({...})`
   ([builtins.ts:1093-1099](../../../src/mcp/builtins.ts)) without
   checking whether `name` already exists. The loader's `seen` map
   then keeps the first one and silently drops subsequent duplicates.
3. **`list_skills` returns raw JSON without validation**
   ([builtins.ts:1067-1071](../../../src/mcp/builtins.ts)). A consumer
   that trusts the shape can be surprised by a hand-edited index.
4. **Generic filesystem `write_file` is an escape hatch.** Roles whose
   filter does not block `write_file` (Manager, Chat, Designer, all
   workers) can rewrite `index.json` and skill markdown directly
   ([builtins.ts:278-279](../../../src/mcp/builtins.ts)). Any
   integrity invariant the skills service tries to enforce can be
   silently bypassed.

---

## 2. Functional needs unmet by the current skill system

The Saivage v2 lifecycle is:

- **Planner**: long-lived; survives by compaction; conversation is reset to
  `[system_prompt, compaction_summary]` at each compaction
  ([04-RUNTIME-DETAILS.md](../04-RUNTIME-DETAILS.md) §3.2).
- **Manager**: one-shot per stage; fresh context every stage; reads stage
  references but inherits no conversational state from prior stages.
- **Coder / Researcher**: one-shot per task; fresh context every task; only
  state inherited is the static skill block + the task description.
- **Inspector**: one-shot per request.
- **Chat**: per-channel session; persistent chat log on disk; resumes from
  it.

Against this lifecycle, the following functional needs are visibly unmet.

### 2.1 Cross-stage lesson retention

When a Coder discovers, mid-task, that "build command for this repo is
`pnpm -C web build` (not `npm run build` because the workspace pin is
broken)", that fact is captured in the task report and then evaporates. The
next Coder, next stage, will redo the discovery work, possibly making the
same mistake. The skill system is a poor fit because:

- Writing it requires a Coder dispatch with `create_skill` + explicit
  trigger design (per §1.5.2 above, defaults produce dead skills).
- It is a *fact about this project right now*, not a reusable instruction
  on how to write code. Promoting it to a "skill" in the current schema
  forces it into a "rule" frame: "When building the web app, use
  `pnpm -C web build`." That works but is awkward, and the loader will
  only inject it if the Coder's task description happens to contain a
  matching keyword.

The runtime tool filter today **does** allow the Manager (and Chat,
Designer) to call `create_skill`/`update_skill` (§1.2), but the spec
intent denies it (Manager dispatches a Coder). Either way, the Manager
has no *fact-shaped* surface — only the awkward skill schema. And
cross-stage knowledge that the Manager identifies is the *most*
important kind, because the Manager is the only agent that sees the
full task-by-task arc of a stage.

### 2.2 Survival of compaction

The Planner is the only agent that compacts more than once. Compaction
discards the conversation and reconstructs from disk. Today, what survives
compaction is:

- The static system prompt (including skill block computed at construction
  time).
- Permanent user notes (re-injected by `NoteManager.getPermanentNotes()`).
- Anything the Planner re-reads from disk on its first post-compaction
  turn (`plan.json`, `plan-history.json`, latest stage summaries).

What **does not** survive:

- Decisions the Planner made that did not end up in `plan.json` (e.g. "I
  decided to defer the data-quality stage until after the user adds new
  data" — captured implicitly in stage ordering but the *reason* is lost).
- Heuristics the Planner picked up over the project ("the Coder loops on
  test failures when the failure message mentions `flake8`; route to
  Researcher first").
- Patterns of failure ("the last three escalations were all about
  out-of-date research artifacts; create a research refresh stage before
  any major code stage").

The Planner cannot write skills (no access). It cannot write notes (notes
are user→Planner, not Planner→Planner). It has no other persistent
self-channel. So Planner compaction is information-lossy by design.

### 2.3 Project-specific facts that don't fit a "skill" frame

A *skill* is structurally an instruction ("When X, do Y."). Many things an
agent learns are *facts*:

- "Table `users` has a denormalized column `last_login_at_ms`. Use it
  instead of joining to `login_events`."
- "The flake8 config inherits from `/etc/flake8` which is wrong; pass
  `--config=.flake8` explicitly."
- "The CI pipeline rejects commits over 500kB; do not commit the
  fixtures directory."
- "The user previously rejected the proposal to use Drizzle; do not
  propose ORMs again."

Forcing these into the skill schema means writing fake "When you operate on
the users table, remember that …" sentences, choosing triggers that match
the fact's surface form, and hoping the loader picks them. Triggers are
not designed for facts — they are designed for *topic detection*. A fact
should be retrievable by lookup ("what do I know about table `users`?")
not by lossy keyword overlap.

### 2.4 Failure-mode awareness for Inspector / Planner

The Inspector is the system's introspection tool, but it operates only on
the current snapshot of project state (`plan.json`, `stage-history`,
disk). It has no persistent record of past *failures*. If the project has
escalated three times for the same root cause, the Inspector cannot say
"this looks like the pattern we hit in stages s7, s12, s19" unless it
re-derives that from `plan-history.json` and the underlying task reports
every time. The Inspector's persistent `tools/inspector/` directory holds
*scripts*, not *findings*.

A `memory` channel writeable by the Inspector and readable by the Planner
would let the Inspector record cross-stage findings ("recurring failure
mode: Researcher's web fetches are hitting rate limits between 09:00 and
11:00 UTC") and let the Planner consult them before scheduling.

### 2.5 Decay and staleness

Skills are markdown files with `created_at` / `updated_at`. The loader
sorts by `updated_at` to break score ties — so a skill that hasn't been
updated for a year, but has the same triggers as a fresh one, sinks. There
is no other staleness mechanism:

- No TTL field.
- No "skill X depends on file Y being present; if Y is gone, evict X".
- No agent surface to *remove* a skill that became wrong. `update_skill`
  edits content but cannot delete the entry. No `delete_skill` MCP tool
  exists ([builtins.ts:1053](../../../src/mcp/builtins.ts)).

For *memories* the staleness problem is sharper. "Build command is
`pnpm build`" is true today, false in six months once the team moves to
`turbo`. Stale memories are worse than no memories: they actively mislead
fresh agents that trust them.

### 2.6 Scoping

Today there are exactly two skill scopes: built-in (repo-level, shared
across all projects — though see §1.4: dead) and project-level (one
directory per project). Missing scopes:

- **Stage-scoped** — knowledge that is only relevant inside a single
  stage and should not pollute later stages (e.g. "for this stage we are
  intentionally bypassing the schema check; revert the bypass at stage
  end").
- **Session-scoped** (Chat) — facts the user mentioned in this chat
  session that should inform the Planner now but not become a permanent
  project rule (the `volatile` user note partly fills this).

The current system supports only `project` scope in practice. User-wide
and cross-project scopes are explicitly Out of Scope for this feature
(§6, OOS-3): the ground rules forbid `~/.saivage` and global
host state, and no virtual host-file scope is contemplated.

### 2.7 Write permissions and provenance

The access matrix ([05-MCP-SERVICES.md](../05-MCP-SERVICES.md) §"Access
Matrix") only authorizes the Coder to write skills. There is no notion of
*provenance* — once the skill is on disk, an `index.json` entry says it
exists, but not who created it, in which stage, under what task, with
what justification (`update_skill` has a `reason` parameter that is
written nowhere; see [builtins.ts:1109-1113](../../../src/mcp/builtins.ts)
— the parameter is accepted and discarded). So we cannot:

- Audit which agent wrote which skill.
- Roll back a project's skill state to "as of stage 12".
- Distinguish skills hand-edited by the user from skills generated by
  the Coder.

### 2.8 Read permissions and surfacing

The loader injects skills into the *system prompt*, all at once, at
construction time. Consequences:

- An agent that runs for 100 turns sees the same skill block on turn 100
  as on turn 1. There is no mechanism to surface a skill *later*
  ("after the agent reports a test failure, inject the `test-debugging`
  skill").
- The Chat agent cannot ask the user "based on memory M I think you
  prefer X; should I record that?" because there is no memory M and no
  proposal/promotion flow.
- The Manager cannot say "I want to read the full text of skill S only
  if I actually need it"; everything matching triggers is dumped into
  context unconditionally.

The MCP `list_skills` / `read_skill` tools exist
([builtins.ts:1053](../../../src/mcp/builtins.ts)) and could partially
serve the "pull on demand" use case. Per the runtime filter (§1.2)
every role currently *can* call them — they are on the read-only
allow-list for restricted roles and unfiltered for the others. The
gap is therefore not access; it is agent-prompt design (no agent is
instructed to pull skills on demand) and the absence of fact-shaped
content to pull.

### 2.9 Compaction-time persistence channel

Compaction is the natural moment to persist structured durable facts,
but today there is no such channel. The compaction routine
([compaction.ts:94-119](../../../src/runtime/compaction.ts)) sends a
*summarization* prompt and replaces history with the resulting summary,
with a hard-truncation fallback
([compaction.ts:125-139](../../../src/runtime/compaction.ts)). There
is no "and additionally, emit any durable facts you want to keep"
step. The previous summary is normally part of the next compaction's
input, so a fact mentioned in summary N can survive into summary N+1
by transitive re-summarization — but this is lossy: each round the
LLM may drop, blur, or merge previously-summarized facts. The
verified gap is the absence of any structured persistence channel
attached to compaction; everything durable round-trips through
free-text summaries.

### 2.10 Conflict and contradiction

There is no mechanism to detect that skill A and skill B disagree
("Always use 4-space indents" vs "Match existing file style"), nor that
memory M1 from stage 3 contradicts memory M2 from stage 12. The loader
simply concatenates everything that scores > 0 and lets the LLM resolve
contradictions. This is acceptable for a handful of skills but degrades
as the corpus grows and as memories of the form "the build command is X"
multiply over time.

---

## 3. What the current skill system gets right (preserve)

1. **Discovery precedence: project overrides built-in.** The loader
   walks `projectSkillsDir` first and `seen.add(name)` ensures any
   project-level entry wins over a built-in of the same name
   ([loader.ts:104-121](../../../src/skills/loader.ts)). Even with
   built-ins currently broken (§1.4), the precedence model — built-ins
   as sane defaults, project state as authoritative override — is the
   right shape and should be preserved.

2. **Loader-side Zod validation with per-entry tolerance.** The
   loader validates `index.json` through `SkillIndexSchema` and each
   entry through `SkillEntrySchema.safeParse`; malformed entries are
   warned about and skipped rather than crashing agent construction
   ([loader.ts:128-159](../../../src/skills/loader.ts)). Preserve
   this read-time tolerance.

3. **`target_agents` filtering as a declarative selection axis.**
   Filtering entries whose `target_agents` array excludes the current
   role ([loader.ts:49](../../../src/skills/loader.ts)) is a good
   design — it keeps role-specific content out of the wrong agent's
   prompt without any trigger ceremony. Preserve, and add more
   dimensions (scope, lifecycle) in Phase B rather than replacing it.

4. **Eager system-prompt injection is the right default for
   instruction-shaped content.** Content that *should* sit in front
   of every turn ("this codebase uses tabs, not spaces") belongs in
   the static system prompt
   ([base.ts:160-174](../../../src/agents/base.ts)). Preserve eager
   injection as one of two surfacing modes (the other being on-demand
   pull, §2.8 / FR-10).

5. **Markdown-as-content.** Skill bodies are human-editable,
   git-diffable markdown. A reviewer can read them without tooling
   and a user can hand-edit them. Preserve for both skills and
   memory content payloads.

6. **Per-agent budget.** `max_per_agent` (default 5,
   [types.ts:34](../../../src/types.ts)) caps how much extra text is
   injected. Without a budget the system prompt would grow
   unboundedly. Preserve, possibly as a per-scope budget.

7. **Top-N ranking, not "include everything that matches".**
   `resolveSkills` sorts by score then `updated_at` and keeps only
   the top N ([loader.ts:60-72](../../../src/skills/loader.ts)).
   Bounding context cost is a hard requirement for LLM systems.
   Preserve.

8. **Multi-dimensional triggers (the ones that actually fire).**
   `keyword:`, `tag:`, and `agent:` triggers work today (per §1.3 the
   `tool:` and `path:` types are functionally dead because no agent
   populates `tools` / `filePaths`). The working trigger types are
   useful and not overly clever. Preserve, and decide in Phase B
   whether to repair or remove the dead ones (§5.3).

9. **No global state.** Everything is per-project under
   `<project>/.saivage/`. Aligns with the ground rule "nothing in
   `~/.saivage`". Preserve.

10. **NoteManager as a working model for persistence patterns.** The
    `UserNote` flow ([src/runtime/notes.ts](../../../src/runtime/notes.ts))
    demonstrates a shape v2 already operates correctly: one JSON per
    item, lifecycle states (`volatile` / `permanent` +
    `acknowledged_at`), runtime-managed cleanup, atomic operations,
    bounded TTL. The memory subsystem can reuse this shape almost
    wholesale (subject to OOS-10: the two channels stay distinct).

11. **The atomic-write helper pattern in `store/documents.ts` is the
    right write path — but is a *target*, not a current property.**
    `readDoc` / `writeDoc` / `deleteDoc`
    ([src/store/documents.ts](../../../src/store/documents.ts):66-85)
    provide tmp-then-rename atomicity and Zod validation. The skills
    handler does **not** use this pipeline today (§1.6.1); raw
    `writeFileSync` is used. Phase B must route all record writes
    through this pattern; FR-28 makes that explicit.

---

## 4. Functional requirements

Numbered, testable. "Skill" below means "instruction-shaped content
addressed to an agent role". "Memory" below means "fact-shaped or
lesson-shaped content addressed by retrieval, not by trigger". The unified
feature must satisfy *all* of these unless explicitly Out of Scope (§6).

### 4.1 Storage and lifecycle

FR-1. All persistent state lives under `<project>/.saivage/` in JSON or
JSONL. No SQLite, no embedded DB, no external service. Every write goes
through the existing `store/documents.ts` atomic-write pipeline.

FR-2. Each persistent record (skill or memory) has, at minimum:
`id`, `kind` (`skill` | `memory`), `scope` (`project` | `stage` |
`session`), `created_at`, `updated_at`, `author_agent` (role and
agent-id), `source` (stage-id and task-id when applicable), and a
content payload. The schema is enforced by Zod and validated on read.

FR-3. Records support an explicit lifecycle: `active`, `superseded`,
`archived`, `expired`. The runtime can move records between these
states based on TTL, supersession links, or explicit agent action; no
record is silently mutated in place. Tests must verify lifecycle
transitions.

FR-4. The system supports at least three scopes: `project` (lifetime =
project), `stage` (lifetime = one stage; auto-archived when the stage
terminates), and `session` (lifetime = one chat session, by analogy
with volatile user notes). User-wide and cross-project scopes are
**out of scope** (§6).

FR-5. There is no DB and no global registry. All scopes resolve to a
single project directory tree; cross-project memory sharing is **out of
scope**.

### 4.2 Authoring

FR-6. Every agent role that has a legitimate need (Planner, Manager,
Coder, Researcher, Inspector — see §2 for derivations) can author
records through MCP tools. The access matrix is enforced by the MCP
runtime, not by convention only; an unauthorized call returns a
descriptive error.

FR-7. The author MCP surface supports at minimum: `create_record`,
`update_record`, `supersede_record`, `archive_record`. Every mutation
records `reason` (free-form string), `author_agent`, and timestamp in
the record's audit trail. Tests must verify the audit trail survives
`update_record`.

FR-8. Creation does not require the author to choose triggers /
retrieval keys up front. The system either (a) accepts a record without
triggers and uses content-based retrieval, or (b) infers triggers from
content. The current failure mode where `create_skill` produces an
unmatchable record (§1.5.2) is forbidden by this requirement.

FR-9. The Manager can write `stage`-scoped records during a stage;
those records are eager-injected only for that stage and are
auto-archived (lifecycle → `archived`) when the stage terminates.
Test: write a stage-scoped record in stage S; verify it is not
surfaced in stage S+1.

### 4.3 Retrieval and surfacing

FR-10. At least two surfacing modes are supported:
- **Eager injection**: into the system prompt at agent construction
  (today's behavior). For "always-on" instruction-shaped content.
- **On-demand lookup**: via MCP tools (`list_records`, `get_record`,
  `search_records`). For fact-shaped content the agent pulls when it
  notices it needs it.
Tests must verify both modes are reachable per agent role.

FR-11. Eager injection has a per-agent budget enforced by the
runtime, expressed as either a record count or a character/token
cap (Phase B chooses one; the *requirement* is that a budget exists
and is enforced). Test: configure a budget of N; insert > N matching
records; verify the constructed system prompt contains exactly N
record blocks (or stops at the byte cap) regardless of how many
additional records match.

FR-12. Records can declare `target_agents` (today's behavior) and
`scope_tags` (richer than today's flat `tags`). Eager injection
respects both. Tests must verify a `stage`-scoped record is never
injected outside its stage, even if its triggers match.

FR-13. Trigger types that today are *advertised but dead* (`tool:`,
`path:`) MUST either be fully wired by the call sites (agents
populate `tools` and `filePaths` in their `SkillMatchContext`), or
removed from the schema. The Phase B design selects one of the two;
the requirement is that the trigger catalog matches the call-site
reality.

FR-14. Memory records support at minimum: exact-key lookup
(`{key: "build-command", scope: "project"}`) and **simple keyword
search** over content. Semantic / vector search is **out of scope**
(§6).

### 4.4 Compaction safety

FR-15. After a Planner compaction, the runtime re-injects all `active`
`project`-scoped records flagged `survive_compaction: true` into the
post-compaction context, by analogy with `NoteManager.getPermanentNotes()`.
The Planner does not need to "remember" to re-read them.

FR-16. Compaction provides the Planner an explicit *write* opportunity:
before history is discarded, the runtime invites the Planner (via a
synthesized tool call or summary template extension) to emit one or
more `memory` records for things it wants to keep. This is a hook for
Phase B to design; the requirement is that compaction is not purely
lossy.

### 4.5 Decay and freshness

FR-17. Records have an optional `expires_at` (ISO timestamp) and/or
`ttl_ms`. Expired records transition to `expired` automatically on the
next access. Expired records are not injected. Tests must verify
expiration is applied to both eager injection and on-demand search.

FR-18. Records can be `superseded_by` another record id. Following
supersession chains is the retrieval system's job; the latest active
descendant is returned by default, and the chain is walkable through
the audit trail (FR-7). Test: create R1, supersede with R2; a default
retrieval call returns R2 and not R1, but an explicit history query
returns both.

FR-19. The Inspector can issue an MCP call to enumerate records older
than N days for review. The functional requirement is *enumeration*;
the policy applied to the resulting list (archive, refresh, prompt
user) is Phase B's choice and is not specified here. Test: with
records of mixed ages, the enumeration call returns only those above
the threshold.

### 4.6 Auditability and human ergonomics

FR-20. The on-disk format is human-readable: JSON for index/metadata,
markdown for free-form content. A human reviewer with `cat` and `grep`
can answer "what skills and memories does this project have, who wrote
them, why, and when?".

FR-21. Every record file is git-trackable and intended to be committed
(modulo per-scope `.gitignore` rules — e.g. `session`-scoped records
may be gitignored alongside the existing `tmp/chats/` policy).

FR-22. The Chat agent MUST be able to list records (via existing or
new MCP read tools) so the user can ask "what do you remember about
this project?" in a chat session and receive a useful answer without
shelling into the host. Test: from a Chat session, a query
enumerating records returns a non-empty list when records exist.
Whether a dedicated web-UI dashboard panel is built on top is
deferred to Phase B and tracked as an open question (§5.9); a
web-UI panel is NOT a Phase-A requirement.

FR-23. **No migration tool ships.** The three reviewed live
deployments (`saivage-v3`, `diedrico`, `getrich`) contain no
`.saivage/skills/` directory (§1.4); for them, schema replacement is
a no-op. No claim is made about other deployments; consistent with
ground rule 2 (no backward compatibility), Phase B is free to
replace the on-disk schema without a migrator. Test: a fresh project
with no prior record state initializes successfully on first
authoring call.

### 4.7 Non-functional

FR-24. **Built-in records load in production.** Whatever built-in
records Phase B ships (skills, default memories, or none) MUST be
loaded by a freshly constructed agent of the matching role, both in
source-run (`tsx` / `pnpm dev`) and after the production tsup
bundle build. The current behavior (silent zero-load due to missing
`index.json` in source and missing `skills/` alongside `dist/` in
production, per §1.4) is a defect the new system must not reproduce
— either by also shipping an index, or by switching to a directory
walk + frontmatter parser that needs none.

FR-25. The system must work without any LLM call to operate.
Authoring and retrieval are pure file/IO operations. (LLMs may
*populate* records, but the runtime infrastructure must not depend
on an LLM round-trip for ordinary load/store.)

FR-26. The system must be unit-testable end-to-end with no MCP
server running; the loader/store layer is pure TypeScript over the
file system.

### 4.8 Security and concurrency

FR-27. **No secrets in records.** The authoring path MUST refuse to
write content that matches the project's secret-detection heuristics
(env files, `auth-profiles.json` contents, API-key-shaped strings,
provider configs). The retrieval path MUST redact / refuse to surface
any record whose content matches the same heuristics. Records pointing
to secret files by path (without inlining contents) are acceptable.
Test: a write attempt containing an obvious API-key-shaped string is
rejected with a descriptive error and no on-disk artifact.

FR-28. **Write-path atomicity and validation.** All record writes go
through the `writeDoc` tmp-then-rename helper
([store/documents.ts](../../../src/store/documents.ts)) and are Zod
validated *before* the atomic rename. A crash between any two writes
leaves the index in a previously-valid state. Test: simulate failure
mid-write; on restart the loader reads the prior valid index without
warnings.

FR-29. **Concurrent-write safety.** When the Manager dispatches workers
in parallel and two authoring agents touch the same record file or
index, the system MUST detect the conflict (e.g. via mtime/ETag check
in `writeDoc` or per-record file-locking) and either serialize or
reject one writer with a retryable error. JSONL append-only layouts
MAY rely on append atomicity. Phase B picks the mechanism; the
requirement is that lost-update races are not silently absorbed.
Test: two concurrent writes to the same record id produce either two
ordered updates or one success + one explicit conflict error, never
an undetected lost update.

FR-30. **Deletion and archival ergonomics.** The MCP surface MUST
provide explicit `archive_record` (reversible) and `delete_record`
(terminal) calls. Today there is no `delete_skill`
([builtins.ts:1053](../../../src/mcp/builtins.ts)); an agent that
generated bad content has no in-band path to remove it. Test:
archived records do not appear in eager injection or in default
search results but are still retrievable by id and via an
`include_archived` flag.

### 4.9 Regression tests pinned to known defects

FR-31. The Phase B implementation MUST ship explicit tests that
reproduce the current-system defects identified in §1, so they cannot
silently recur:

  a. **Built-in skills load.** Assert the shipped built-in records
     (whichever Phase B keeps) are visible to a freshly constructed
     agent of the matching role, both in source-run and after the
     production tsup bundle build.
  b. **No unmatchable records.** Assert `create_record` (or
     equivalent) cannot produce a record that is unreachable by any
     retrieval path — either by requiring at least one trigger /
     `target_agents`, or by guaranteeing on-demand lookup works on
     records with empty triggers.
  c. **Updates touch metadata.** Assert `update_record` refreshes
     `updated_at`, persists `reason` into the audit trail, and
     updates index metadata when content changes affect routing.
  d. **Reads honour `file` field.** Assert a record with a
     non-default `file` path is readable through the MCP read tool.
  e. **Unavailable tools are not advertised; unauthorized writes are
     filtered.** Two distinct current-state defects must each have a
     regression test:
     (i) `create_skill` and `update_skill` are reachable by Manager,
     Designer, and Chat today (their role filter is unset, so the
     unfiltered tool catalog includes both), contrary to the spec's
     Coder-only `skills`-service grant. Test must assert that under
     the Phase B matrix these calls fail with a descriptive
     authorization error from the MCP runtime, not from a downstream
     handler.
     (ii) The memory and index MCP services are registered with
     `{ available: false }` in `builtins.ts` and are therefore omitted
     from `getAllTools()` and rejected by `callTool()` for **every**
     role today. Test must assert that until Phase B wires them, no
     role's tool catalog contains `memory_*` or `index_*` and any
     direct `callTool` invocation returns an `unavailable` error.
  f. **Secrets are refused.** Assert that `create_record` /
     `update_record` reject content containing the well-known
     secret-bearing paths and tokens called out in FR-27 (provider
     configs, auth-profile fields, env files, shell history).
  g. **Concurrent writes do not corrupt the index.** Assert that two
     Manager-dispatched workers writing records in parallel produce
     either two distinct, well-formed records or one deterministic
     winner — never a partially written `index.json` or a half-written
     record JSON file (FR-28, FR-29).

---

## 5. Open questions for Phase B

Each question has at least two concrete sketched options. None are
endorsed here; Phase B selects.

### 5.1 One feature or two?

**Question:** Skill + Memory — one unified record type with a `kind`
field, or two distinct subsystems sharing an underlying store?

- **Option A: One unified record.** Single Zod schema, single MCP
  service (`records` or `knowledge`), single on-disk directory
  (`.saivage/knowledge/`). The `kind` field discriminates *how* a
  record is surfaced (eager-inject vs lookup-only) but the storage,
  audit trail, and lifecycle are identical. Simpler.
- **Option B: Two subsystems sharing primitives.** Separate `skills/`
  and `memories/` directories, separate MCP services
  (`skills`, `memory`) — matching the spec's existing names —
  separate top-level schemas but reusing the document store. Easier
  to grow them in different directions later.

### 5.2 Retrieval mechanism for memory (fact-shaped) content

**Question:** How does an agent look up the fact "what is the build
command for this project?"

- **Option A: Topic / key index.** Every memory has a structured
  `topic` field (e.g. `{ table: "users", aspect: "schema" }`) and is
  retrieved by exact match plus an optional secondary keyword filter.
  Cheap, deterministic, requires authors to pick topics.
- **Option B: Full-text index over content.** A JSONL `memories.jsonl`
  is grepped at retrieval time, or a small inverted index is kept on
  disk. Bigger payload, but agents do not have to pre-categorize.
- **Option C: LLM-side responsibility.** The MCP `list_records` tool
  returns short summaries of every record matching the agent's scope;
  the LLM picks which ones to `get_record` in full. Pushes the cost to
  the LLM. Simple to implement.

### 5.3 Trigger system fate

**Question:** Keep the `keyword:/tool:/path:/tag:/agent:` trigger
language?

- **Option A: Keep, but wire up `tool:` and `path:` properly** by
  populating `tools` and `filePaths` in the agent constructors. Triggers
  remain the only eager-injection selection mechanism.
- **Option B: Replace triggers with explicit `target_agents` +
  `target_tags` only.** Drop keyword/tool/path matching entirely. Eager
  injection becomes purely declarative. Anything that needs content-aware
  selection moves to on-demand lookup (5.2).
- **Option C: Keep triggers for skills, drop them for memories.**
  Memories are looked up by topic/keyword (5.2); skills are still
  selected by triggers.

### 5.4 Where do user-supplied preferences live?

**Question:** User-wide preferences ("I prefer 4-space indents in
Python") are out of scope per the user's no-`~/.saivage` rule. What is
the alternative surface?

- **Option A: Per-project only.** User must copy their preferences into
  each project's `.saivage/skills/` or `.saivage/memories/`. Manual
  ceremony but compliant with the ground rules.
- **Option B (REJECTED in round 1).** *A user-managed file outside
  `.saivage/`* (e.g. an `AGENTS.md` at the user's home or repo root
  read at startup and merged in as a virtual read-only scope) was
  proposed in round 1. **Rejected** because it violates ground rule 3:
  any host-level or user-wide state is forbidden, and OOS-3 / OOS-10
  reaffirm it. Listed here only to record that it was considered.
- **Option C: Out of scope for this feature.** Defer to a future
  feature; document the limitation.

### 5.5 Authoring rights

**Question:** Which agents can author which kinds at which scopes?

- **Option A: All authoring agents (Planner, Manager, Coder, Researcher,
  Inspector) can write at any scope they have access to.** Simple.
  Risk: Coder writes a `project`-scoped memory that contradicts an
  earlier Planner-written one.
- **Option B: Scope-restricted authoring.** Planner owns
  `project`-scoped; Manager owns `stage`-scoped; Coder/Researcher can
  only write `task`-scoped (a new sub-scope) and must escalate to
  `stage`/`project` via the Manager/Planner. More invariant-preserving,
  more ceremony.

### 5.6 Conflict and contradiction handling

**Question:** What happens when records contradict each other?

- **Option A: Best-effort, LLM resolves.** The system surfaces both;
  the consuming LLM is told to prefer the more recent (`updated_at`).
- **Option B: Explicit supersession.** Writing a record that
  contradicts an active one requires either the `supersede_record`
  call (which marks the older one as `superseded`) or an `override`
  acknowledgment that they are intentionally co-active. Inspector can
  audit for unresolved conflicts.

### 5.7 Storage layout

**Question:** One file per record, or append-only JSONL?

- **Option A: One JSON file per record** (mirrors `notes/<id>.json`
  and `inspections/<id>.json`). Easy to diff, easy to delete. Lots of
  small files at scale.
- **Option B: Append-only JSONL** (`memories/memories.jsonl`,
  `skills/skills.jsonl`). One file to scan, supports a tail-style
  audit log naturally. Harder to edit by hand. Tombstone records for
  delete/supersede.

### 5.8 Built-in content distribution

**Question:** How are repo-shipped built-in skills loaded
(fixing §1.4 and §1.5.1)?

- **Option A: Ship an `index.json` at `saivage/skills/`** alongside the
  existing markdown. Minimal change. Still two formats (YAML
  frontmatter on disk, `index.json` for the loader).
- **Option B: Loader walks the directory, parses YAML frontmatter,
  no `index.json` required.** Removes the dual-format problem.
  Slightly more loader logic.
- **Option C: Drop built-in skills entirely.** Document the four
  current ones as part of the agent system prompts (or as default
  project-level skills seeded at `saivage init`). Cleanest split:
  built-ins become part of the runtime; user-authored everything lives
  under `.saivage/`.

### 5.9 Web UI / Chat exposure

**Question:** How are records exposed to the user?

- **Option A: Web UI dashboard panel** listing records by scope, with
  read-only display and a "promote / archive" button per record.
- **Option B: Chat commands** (`/skills list`, `/memories list`) — no
  UI work needed initially.
- **Option C: File-system only** — user reads `.saivage/skills/` and
  `.saivage/memories/` directly. No UI surface. Forces git diffs as the
  only review mechanism.

### 5.10 Cross-agent visibility (NB-2)

**Question:** Beyond eager injection via `target_agents`, who can
*discover*, *search*, and *read* records authored by another role?
Specifically: can the Chat agent read a `stage`-scoped memory written
by a Coder? Can a Researcher read a Manager's `session`-scoped memory?
Can the Inspector read everything regardless of `target_agents`?

- **Option A: Visibility follows the MCP access matrix only.**
  An agent reads what the access table permits, ignoring
  `target_agents`. `target_agents` controls *eager injection* only,
  not *on-demand read*. Simple; matches today's `Skill` semantics.
- **Option B: `target_agents` is a hard ACL.** An agent cannot read
  records that do not list its role, even on-demand. Strong isolation
  but breaks the Inspector's ability to audit and the Chat agent's
  ability to surface state to the user.
- **Option C: Inspector + Chat are always-readers; others honour
  `target_agents`.** Hybrid: privileged roles see everything,
  worker roles only see what is targeted at them. Matches the
  Inspector's existing read-everything posture
  ([00-AGENT-SYSTEM.md](../00-AGENT-SYSTEM.md) §3.4) and the Chat
  agent's user-facing role.

### 5.11 Relation to inspections (NB-4)

**Question:** The Inspector already writes `inspections/<id>.json`
with its own lifecycle (open → resolved → archived). When the
Inspector identifies a *recurring* failure mode, should it (a) write a
new memory record that references the inspection id, (b) promote the
inspection itself into a memory record (mutating its kind), or (c)
leave inspections and memory entirely separate, with the Planner
responsible for distilling inspection findings into memories during
compaction?

- **Option A: Inspection → memory by reference.** Inspector writes a
  memory whose `source_ref` points at the inspection id. The
  inspection stays as a report; the memory is the agent-facing
  artefact. Preserves both lifecycles.
- **Option B: Promotion in place.** The Inspector mutates the
  inspection record's `kind` from `inspection` to `memory` once it
  has been confirmed. Single source of truth but conflates two
  schemas with different invariants (`expires_at`, `superseded_by`).
- **Option C: Planner-mediated promotion.** Only the Planner, at
  compaction-time (FR-16), reads open inspections and decides which
  ones become memories. Inspector never writes memories directly.
  Keeps authorship centralised but adds compaction-time latency.

### 5.12 Compaction sufficiency (NB-5)

**Question:** `plan-history.json` is append-only and never truncated
([01-DATA-MODEL.md:472](../01-DATA-MODEL.md)). Together with
`plan.json` and the existing compaction summary, what *additional*
recovery does a memory store actually provide? Stated differently:
which Planner-recovery use cases are *not* solved by replaying
`plan-history.json` and re-reading `plan.json` after compaction, and
therefore genuinely require a memory channel?

- **Option A: Memory carries only what `plan-history.json` cannot.**
  Restrict the memory scope to (i) cross-stage *lessons* (§2.1),
  (ii) failure-mode patterns (§2.4), and (iii) project facts that are
  not stage-shaped (§2.3). Anything that is already a plan-history
  event MUST NOT be duplicated into memory.
- **Option B: Memory is the only post-compaction recall surface.**
  Treat `plan-history.json` as audit-only, never read at runtime.
  All recall goes through memory. Simpler runtime, but discards the
  compaction-summary work that already exists and forces memory to
  re-encode plan structure.
- **Option C: Dual-read.** Compaction-time re-injection (FR-15)
  pulls from both `plan-history.json` (last N entries) and
  `active`-status memory records. Highest recall, highest token cost,
  and requires an explicit dedup rule.

A regression test (FR-31) MUST pin the chosen boundary: replay a
representative `plan-history.json` and assert which Planner-recovery
fields come from history vs. memory.

---

## 6. Out of scope

Explicitly out of scope for the integrated Skill + Memory feature. If
any of these are needed they belong to a separate, future feature.

OOS-1. **Vector / semantic search.** The MCP `index` stub
([builtins.ts:1139](../../../src/mcp/builtins.ts)) and the spec
([05-MCP-SERVICES.md](../05-MCP-SERVICES.md) §8) mention full-text search
as a separate `index` service. Phase B may use only basic keyword
matching and exact key lookup. Embeddings, ANN indexes, and FAISS-like
machinery are not part of this feature.

OOS-2. **Automatic LLM-driven summarization across projects.** This
feature does not consult, summarize, or share across projects. Records
created in project A are invisible to project B.

OOS-3. **Cross-project memory sharing.** Even if two projects on the same
host have overlapping facts, the system does not link them. (User-wide
preferences are deferred per §5.4.)

OOS-4. **Multi-user / multi-tenant access control.** A single human
operator is assumed. There is no per-user record ownership beyond the
`author_agent` audit field.

OOS-5. **Sync / cloud backup.** Records live on the project's disk. Git
provides backup if the user commits them. No external store.

OOS-6. **Automatic memory eviction by LLM judgment.** The runtime applies
mechanical lifecycle rules (TTL, supersession, scope expiry). It does
not call an LLM to decide "is this memory still useful?". Such an
evaluator can be built later as a Phase-N feature, scheduled as a
dedicated Inspector stage; it is not built into the core load/store.

OOS-7. **Migration of existing v2 skill data.** Per ground rule 2 (no
backward compatibility), and per §1.4 (zero deployed skill data exists),
Phase B is free to replace the schema. No data migration tool will be
shipped.

OOS-8. **Per-record encryption / access tokens.** Records are plaintext
JSON / markdown, like every other `.saivage/` document.

OOS-9. **A separate "knowledge graph" / linked-records layer.** Records
may reference each other by id (e.g. `supersedes`, `relates_to`) but
the system does not provide graph queries beyond "follow supersession
chain".

OOS-10. **Replacing the existing `NoteManager` / `UserNote` system.**
The user-note channel and the memory channel are distinct (one is
user-to-Planner injection, the other is agent-authored persistence).
Phase B may *reuse the patterns* but should not fold them into a single
table — they have different invariants.

---

## 7. Summary table — gap matrix

| Need (§2 ref)                              | Skill system today | Memory today      | Required FRs        |
|--------------------------------------------|--------------------|-------------------|---------------------|
| Cross-stage lesson retention (§2.1)        | indirect (skill schema awkward for facts; runtime grants write to Manager/Designer/Chat, not the spec-named Coder) | none           | FR-6, FR-7, FR-9    |
| Survive Planner compaction (§2.2)          | partial (system prompt only) | none   | FR-15, FR-16        |
| Project-specific *facts* (§2.3)            | awkward (forced into rule shape) | none | FR-10, FR-14        |
| Failure-mode awareness (§2.4)              | none               | none              | FR-6, FR-9, FR-19   |
| Decay / staleness (§2.5)                   | manual only        | n/a               | FR-17, FR-18        |
| Stage / session scopes (§2.6)              | project only       | n/a               | FR-4, FR-12         |
| Write provenance (§2.7)                    | none               | n/a               | FR-2, FR-7, FR-20   |
| On-demand pull (§2.8)                      | partial (every role can call `list_skills`/`read_skill`; no agent prompt instructs them to) | n/a             | FR-10               |
| Compaction-time write hook (§2.9)          | none               | none              | FR-16               |
| Contradiction handling (§2.10)             | none               | n/a               | FR-18 + §5.6        |

---

## 8. Items the writer could not determine

These warrant the reviewer's attention before Phase B starts.

UNK-1. **What was the original intent of the YAML-frontmatter format in
`saivage/skills/*/SKILL.md`?** The spec
([SPEC/v2/05-MCP-SERVICES.md](../05-MCP-SERVICES.md) §6 "v2 Adaptation")
treats them as v1 leftovers being adapted, but the loader was never
taught to read frontmatter and there is no evidence anyone is reading
those files today. Confirm whether they are meant to be deleted, ported
to `index.json`, or addressed by an Option-B loader walk (§5.8).

UNK-2. **Why does the access matrix grant `Memory` to Coder, Researcher,
Inspector but not Planner or Manager?** This shape predates any memory
implementation and may reflect a v1 assumption that "memory" was a
worker-level scratchpad. The functional needs in §2 strongly suggest
Planner and Manager are the *primary* memory authors. Confirm with the
spec owner whether the access matrix is intentional or vestigial.

UNK-3. **Should `session`-scoped records survive across chat sessions on
the same channel?** Chat logs do persist
([00-AGENT-SYSTEM.md](../00-AGENT-SYSTEM.md) §2.6), so "session" could
mean either "this chat-id" (does not survive a new session) or "this
channel" (does survive new session for the same channel). The user's
intent here is not stated.

UNK-4. **Is there an existing operator desire to expose skill/memory
state through the web UI?** The user has mentioned `saivage-e2e-checkers`
and prompts around UI work in the workspace structure. If yes, FR-22
becomes load-bearing for Phase B; if no, it can be deferred.

UNK-5. **Are the four built-in skills (`coding`, `planning`, `research`,
`mcp-authoring`) considered authoritative content the runtime should
guarantee, or are they sample content the operator may discard?** Phase
B's answer to §5.8 depends on this.

---

## 9. Round log

Round 2 disposition of [00-FUNCTIONAL-REVIEW-r1.md](./00-FUNCTIONAL-REVIEW-r1.md).
Format: `[ID] DECISION — rationale (anchor in this doc)`.

### Blocking findings

- [BLOCK-1: spec-vs-runtime confusion] **ACCEPT-FIX** — §1.2 rewritten
  with a runtime access table showing every role can call
  `list_skills`/`read_skill` and that skill-write is reachable by
  Manager/Designer/Chat (not Coder); §2.8 corrected to note the gap
  is agent-prompt design, not access; §1.5.5 documents that the
  memory and index services are registered `available: false` and are
  therefore omitted by `getAllTools()` and rejected by `callTool()`
  for all roles.
- [BLOCK-2: `update_skill` cannot fix index] **ACCEPT-FIX** —
  §1.5.2 rewritten: `update_skill` writes the body but never refreshes
  `updated_at` / `triggers` / `target_agents` in `index.json`, so
  routing is frozen at creation time. FR-31(c) pins a regression test.
- [BLOCK-3: atomic writes claimed but not used] **ACCEPT-FIX** —
  §3 item 11 reworded: atomic write helpers exist in the codebase but
  are **not** used by the skill loader/writer today; this is a Phase B
  target (FR-28), not a current strength to preserve.
- [BLOCK-4: memory/index hidden from skills catalog] **ACCEPT-FIX** —
  §1.5.5 clarifies that memory/index MCP services are registered with
  `{ available: false }` in `builtins.ts`, omitted from `getAllTools()`
  by `runtime.ts`, and rejected by `callTool()`; no role sees them
  today regardless of spec intent or store state.
- [BLOCK-5: home-file option violates ground rules] **ACCEPT-FIX
  (option rejected)** — §5.4 Option B explicitly marked **REJECTED in
  round 1**, with the rationale cited (ground rule 3, OOS-3/OOS-10).
- [BLOCK-6: FR-11 / FR-16 / FR-22 not testable] **ACCEPT-FIX** —
  FR-11 now states the budget is enforced by the runtime injector
  (not by individual agents); FR-16 names the explicit write
  opportunity at compaction time; FR-22 is weakened to "Chat MUST,
  web UI deferred to §5.9" so the surface is testable in isolation.
- [BLOCK-7: built-in path: source vs bundled] **ACCEPT-FIX** —
  §1.4 already disambiguates source-tree (`saivage/skills/`) vs
  bundled-dist behaviour; FR-31(a) pins a test for both.
- [BLOCK-8: `read_skill` ignores `entry.file`] **ACCEPT-FIX** —
  §1.5.6 added; FR-31(d) pins a regression test for non-default
  `file` paths.

### Non-blocking findings

- [NB-1: runtime access matrix missing] **ACCEPT-FIX** — §1.2 has
  the skill-only table; the full matrix across skill-read,
  skill-write, memory-read/write, index-read/write, and
  filesystem-write for all nine roles is now in §1.2.1.
- [NB-2: cross-agent visibility undefined] **ACCEPT-FIX** — §5.10
  added with three options (ACL-by-access-table, hard ACL, hybrid).
- [NB-3: notes vs memory boundary] **ACCEPT-FIX** — §5.6 already
  addresses conflict; OOS-10 reaffirms `NoteManager` stays.
- [NB-4: relation to inspections] **ACCEPT-FIX** — §5.11 added with
  three promotion-path options.
- [NB-5: compaction sufficiency] **ACCEPT-FIX** — §5.12 added,
  pinning the boundary to a FR-31 regression test.
- [NB-6: concurrent writes / index races] **ACCEPT-FIX** — FR-28
  (atomicity), FR-29 (concurrent-write safety), FR-31(g) test.
- [NB-7: secrets handling] **ACCEPT-FIX** — FR-27 (no secrets) +
  FR-31(f) test reject auth-profile/env/token content at write time.
- [NB-8: deletion / archival ergonomics] **ACCEPT-FIX** — FR-30
  added; OOS does not exclude it.

### Disclosures

- During the round-2 corruption sweep, splice fallout in §4.5 / §4.6
  / §4.7 (FR-18, FR-19, FR-22, FR-23) and an empty §4.7 were
  rewritten as part of the same pattern rather than reported as
  separate findings. The §4.5-§4.7 rewrites were not pre-announced in
  the round-1 corruption list; they are recorded here for round-3
  traceability.
- §5.10–§5.12 were lost to a splice during the §4.5-§4.7 rewrite
  (they had been sandwiched into the corrupted region) and were
  reconstructed from the review's NB-2 / NB-4 / NB-5 prompts rather
  than recovered verbatim. Reviewer should confirm the
  reconstructions match round-1 intent.

### Round 3 dispositions of [00-FUNCTIONAL-REVIEW-r2.md](./00-FUNCTIONAL-REVIEW-r2.md)

- [r2-BLOCK: stale "Coder only" in §7 gap matrix] **ACCEPT-FIX** —
  rows §2.1 and §2.8 reworded to match the §1.2 / §1.2.1 access
  truth (every role can read skills; skill-write is Manager /
  Designer / Chat, not Coder).
- [r2-WRONG-FIX BLOCK-1 round-log entry] **ACCEPT-FIX** — round-log
  BLOCK-1 rewritten so the rationale matches the body fix instead of
  repeating the old "only Coder" framing.
- [r2-WRONG-FIX BLOCK-4 round-log entry] **ACCEPT-FIX** — round-log
  BLOCK-4 rewritten: memory/index are `available: false` (omitted by
  `getAllTools()`, rejected by `callTool()`), not "hidden when the
  store is empty".
- [r2-WRONG-FIX FR-31(e)] **ACCEPT-FIX** — FR-31(e) split into two
  assertions: (i) `create_skill` / `update_skill` reachable by
  Manager / Designer / Chat must be filtered under the Phase B
  matrix; (ii) memory / index services must remain unavailable for
  every role until Phase B wires them.
- [r2-NOT-APPLIED NB-1 full matrix] **ACCEPT-FIX** — §1.2.1 added
  with the full skill / memory / index / filesystem matrix across
  all nine roles, sourced from `ROLE_TOOL_FILTER` and the
  `available: false` registrations.
- [r2-NB stale OOS-11 reference in §2.6] **ACCEPT-FIX** — reduced
  citation to `(§6, OOS-3)`; user-wide / cross-project scope is
  covered by OOS-3 and §5.4's REJECTED Option B.
- [r2-NB §5.11 missing `expires_at` / stale-report wording]
  **ACCEPT-DEFER** — reviewer marked non-blocking; FR-19 already
  pins stale-record enumeration and §5.11 carries the core
  promotion-path decision.
