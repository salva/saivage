# F02 — Design (r1)

Two proposals. Both establish a single roster source of truth; they differ in how aggressively the surrounding code is restructured to consume it. A third proposal is rejected at the bottom with reasoning.

## Proposal A — Single declarative roster, mechanical derivation

**Scope (files touched):**

- New: `src/agents/roster.ts` (~80–120 lines, the only place a role's metadata is written).
- Edited:
  - [src/agents/types.ts](src/agents/types.ts#L20-L28) — `AgentRole` becomes `typeof ROSTER[number]["role"]`.
  - [src/types.ts](src/types.ts#L109) — `TaskSchema.assigned_to` becomes `z.enum(WORKER_ROLES)`.
  - [src/types.ts](src/types.ts#L160) — `TaskReportSchema.agent` becomes `z.enum(WORKER_ROLES)`.
  - [src/types.ts](src/types.ts#L268-L285) — `AgentStateSchema.agent_type` becomes `z.enum(ALL_ROLES)`.
  - [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L16-L33) — `DISPATCH_TOOLS` and `DISPATCH_ROLE_MAP` derived from roster entries with `dispatchTool != null`.
  - [src/agents/base.ts](src/agents/base.ts#L953-L1018) — `ROLE_DISPATCH_TOOLS` derived from roster's `dispatchableBy`; `ROLE_TOOL_FILTER` keyed off roster's `toolFilter` category. The six per-role schema constants (`RUN_*_SCHEMA`) collapse into a single factory `makeDispatchToolSchema(rosterEntry)` since coder/researcher/data_agent/reviewer schemas are byte-identical apart from the name/description.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L14-L20) — `ROLE_ABORT_PRIORITY` derived by sorting roster entries with `abortPriority != null`.
  - [src/runtime/self-check.ts](src/runtime/self-check.ts#L10-L19) — `DEFAULT_SELF_CHECK_FREQUENCY` derived.
  - [src/agents/conventions.ts](src/agents/conventions.ts#L20-L66) — `CONVENTIONS` derived; the existing `Partial<Record<AgentRole, ConventionRule>>` keeps `Partial` only because the planner-narrative roles that don't need conventions can opt out by setting `convention: null` in the roster.
  - [src/config.ts](src/config.ts#L36-L50) — `models` block keys derived from roster's `defaultModelKey` values plus fixed extras `orchestrator`, `default`. `executor` key is **removed** (no agent uses it).
  - [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16) — `ROUTING_ROLE_TO_MODEL_KEY` derived; pseudo-roles `supervisor`, `security`, `default` stay as fixed extras. `executor` entry removed.
  - [src/server/bootstrap.ts](src/server/bootstrap.ts#L293-L370) spawner `switch` — keeps explicit cases (constructors differ) but gains a `default: assertExhaustive(role)` so adding a roster entry without a spawner case becomes a `tsc` error.
  - [SPEC/v2/00-AGENT-SYSTEM.md](SPEC/v2/00-AGENT-SYSTEM.md) — add §2.x sections for Data Agent and Reviewer; update §3 hierarchy diagram; add Worker subsection footnote referencing the roster.
  - [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L163) — update `assigned_to` enum to the four worker roles; [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L351) — update `agent_type` enum to the eight live roles.

**What gets added:**

- A single typed array constant in `src/agents/roster.ts`:

  ```ts
  // src/agents/roster.ts (illustrative shape — not the final file)
  export const ROSTER = [
    {
      role: "planner",
      worker: false,
      dispatchTool: null,
      dispatchableBy: [],
      toolFilter: "planner",
      abortPriority: null,
      selfCheckFrequency: 30,
      convention: { writeTerritory: [".saivage/plan.json", ".saivage/plan-history.json"],
                    excludeTerritory: ["src/", "research/"],
                    description: "Planner manages plan state via Plan MCP only" },
      defaultModelKey: "orchestrator",
    },
    // manager, coder, researcher, data_agent, reviewer, inspector, chat ...
  ] as const satisfies readonly RosterEntry[];

  export type AgentRole = (typeof ROSTER)[number]["role"];
  export type WorkerRole = Extract<typeof ROSTER[number], { worker: true }>["role"];
  export const ALL_ROLES = ROSTER.map(r => r.role) as unknown as readonly [AgentRole, ...AgentRole[]];
  export const WORKER_ROLES = ROSTER.filter(r => r.worker).map(r => r.role) as unknown as readonly [WorkerRole, ...WorkerRole[]];
  ```

  The `as const satisfies` + `as unknown as readonly [T, ...T[]]` dance is what keeps `z.enum(...)` happy with the inferred string-literal tuple.
- A `getRoster(role)` lookup helper and a `renderRosterSummary(forRole)` helper that emits the bullet list currently hardcoded in each prompt (consumed by F18 when prompts are extracted).

**What gets removed:**

- The standalone `AgentRole` union literal at [src/agents/types.ts](src/agents/types.ts#L20-L28) — replaced by a re-export from `roster.ts`.
- All hand-typed role lists in dispatcher/supervisor/self-check/conventions/config/resolver listed above.
- The vestigial `executor` model key at [src/config.ts](src/config.ts#L45) and [src/routing/resolver.ts](src/routing/resolver.ts#L11) — no agent has this role, the key is dead config surface.
- Per-tool `RUN_*_SCHEMA` duplication in [src/agents/base.ts](src/agents/base.ts#L857-L955) for the four worker schemas, replaced by one factory.

**Risk:**

- *Type-level:* The `as unknown as readonly [T, ...T[]]` cast is the standard Zod-friendly idiom; if `tsc` rejects it on `--strict`, fall back to declaring the tuple explicitly. Either way the rest of the change is type-level; runtime behaviour is unchanged.
- *Schema parsing:* The Zod enums today are subsets of what the code allows (e.g. `assigned_to` accepts only 4 of 8 live roles). The change makes `TaskSchema.assigned_to` accept the same 4 worker roles — it is **not** widening to 8, so existing `tasks.json` files continue to validate identically.
- *Spawner exhaustiveness:* Adding the `default: assertExhaustive(role)` will surface that `planner`, `chat`, and (today) `designer` are not in the switch. That is intentional — planner and chat are bootstrapped directly, not via `run_*`. The check guards by including only roles with `dispatchTool != null`, so the exhaustive set is `manager | coder | researcher | data_agent | reviewer | inspector`, matching the existing switch.
- *Tests:* `src/agents/agents.test.ts` constructs `AgentRole` values inline; types still resolve. No runtime test should observe a behaviour change.

**What it enables (cross-issue):**

- F01 (designer wiring): adding `designer` becomes one roster entry + one spawner case.
- F09 (worker helper dedup): worker base class can iterate `WORKER_ROLES`.
- F18 (prompt extraction): prompts consume `renderRosterSummary(role)` instead of repeating prose.
- F23 (supervisor priority incomplete): becomes a one-field-per-role decision in the roster.

**What it forbids:**

- Any future role addition that skips `roster.ts` will fail to compile (Zod enum types are derived from the roster; the spawner has an exhaustive check; tool filters and dispatch maps are derived).
- The `executor` model key cannot be re-introduced silently — adding it back requires a roster entry with a real role.

**Recommendation note:** safest and smallest; closes the structural drift in one commit but leaves prompt-level drift to F18.

---

## Proposal B — Roster + prompt-injected role narrative + designer placeholder

Everything from Proposal A, plus three additions that take the cleanup "one conceptual level up".

**Additional scope:**

- `renderRosterSummary(forRole, { include: "all" | "interactsWith" })` is called by **every** agent's system-prompt construction. The bullet list at the top of each prompt (`- **Planner** (you)...`, `- **Manager**...`) is no longer typed by hand inside the template literal; it is composed at agent construction. This requires either (a) constructing the prompt at runtime in each agent's `runLoop()` setup (rather than module-load `const PROMPT = \`...\``), or (b) splitting the prompt into a header (composed) + body (extracted file, per F18).

  - Option (a) lands inside this issue; option (b) is the F18 path. The design here assumes (a) only as a fallback if F18 has not yet landed when F02 ships.
- The roster entry for designer is added with `enabled: false` (a single boolean field absent from Proposal A's schema). When `enabled: false`:
  - The role is excluded from Zod enums and from `DISPATCH_TOOLS`.
  - It still exists as a type-level value so `DesignerAgent`'s `agentRole: "designer"` literal in [src/agents/designer.ts](src/agents/designer.ts#L85) typechecks.
  - F01's wiring change is then literally a one-line `enabled: true` flip plus a spawner case.
- `models` block schema is rewritten to use a `z.record(WORKER_OR_PLANNER_KEY, ...)` shape that derives valid keys from the roster, so future role additions auto-extend valid model assignments (closes the gap that F32 partially covers for `models`).

**What gets added beyond A:**

- `enabled: boolean` field on roster entries.
- Runtime prompt-header composition or a small `composePromptHeader(role)` helper.
- `models` block schema using a roster-derived key union.

**What gets removed beyond A:**

- The handwritten "## The Saivage System" role bullet list at the top of each of `src/agents/planner.ts`, `src/agents/manager.ts`, `src/agents/coder.ts`, `src/agents/researcher.ts`, `src/agents/data-agent.ts`, `src/agents/reviewer.ts`, `src/agents/inspector.ts`, `src/agents/chat.ts`. ~10–20 lines deleted per file.
- The implicit "designer is dead code" status — replaced by an explicit `enabled: false` flag awaiting F01.

**Risk:**

- Composing prompt headers at runtime changes when the prompt string is materialised; if any test snapshots compare prompts byte-for-byte they will need to re-snap. Survey of `src/agents/agents.test.ts` shows no such snapshot; only inputs/outputs are asserted.
- The `enabled: false` flag is a transitional surface — but in this case it is **not** a backward-compat shim, it is a roster-level capability for "role exists at the type level, not exposed at runtime yet", which is the correct semantics for the in-progress F01 work. After F01 lands the flag can stay (designer is permanently enabled) or be removed; both are local edits.
- The largest risk is scope creep: prompt composition for 8 agents in one PR can collide with F18 (prompt extraction). Mitigation: gate Proposal B behind F18 landing first, or implement Proposal A now and follow with prompt-header composition as a separate PR.

**What it enables:**

- Closes the planner-prompt-omits-data_agent-and-reviewer drift (the original concrete symptom in F02) **structurally**, not just by editing one prompt by hand.
- Designer's status becomes a one-flag flip (`enabled: true`) for F01.
- Removes the duplication of role descriptions across 8 prompts (~150 lines total) without waiting for F18.

**What it forbids:**

- Any agent embedding its own custom role list in its prompt header — there is only one renderer.
- Reintroducing per-prompt drift: the renderer composes from the same roster the schemas derive from, so the prompts and the schemas cannot disagree.

**Recommendation note:** more cleanup per commit, harder to review, and overlaps with F18. Take it only if F18 will not land in the same review cycle.

---

## Proposal C (rejected) — Pure SPEC-only rewrite

"Update the SPEC enumerations to match the code; do not change the code." This would close the documentation-mismatch category in F02 but leaves the 13 in-code enumerations to drift again on the next role addition. The operator's directive is to make implementation authoritative; that authority should be expressed structurally, not via a SPEC patch that the next PR can desync. Rejected.

---

## Recommendation

**Proposal A.**

- It is the smallest change that fully closes F02's structural problem: the 13 in-code role enumerations collapse to one declarative roster, the SPEC docs are corrected once, and the supervisor/dispatcher/self-check/conventions/config/router/types/spawner all derive from a single source.
- It does not block F18 (prompts still embed hand-written role lists, but they no longer **can** disagree with the schemas — the schemas are derived from the roster, and F18 will then point prompts at `renderRosterSummary(role)` as a follow-up).
- It does not pre-empt F01: designer remains an unlisted file with no roster entry; F01 adds one entry and one spawner case to wire it in.
- It removes a real piece of dead config (`executor`) without inventing any compat alias.

Proposal B is the right destination, but the right route to it is "land A, then let F18 extract prompts, then add `composePromptHeader`". Doing all three in one commit risks merge conflicts with F18 and bloats the review.
