# F02 — Design (r2)

## Changes from r1

- **Accepted (reviewer point 1).** The recommended path is no longer "Proposal A leaves prompt headers handwritten until F18". Proposal A is extended in-place to compose the per-role "## The Saivage System" bullet list at template-literal interpolation time from `renderRosterSummary(role)`. The false claim that handwritten prompts "no longer can disagree with the schemas" is removed; the new wording grounds the guarantee in the renderer. Proposal B is retained as the further level-up (it adds the `enabled: false` designer slot and the roster-derived `models` record); Proposal A is now the recommendation and structurally closes the planner-prompt-omits-data_agent-and-reviewer drift.
- **Accepted (reviewer point 2).** The `models` block semantics are made precise. The roster's `defaultModelKey` set today is `{ orchestrator, coder, researcher, data_agent, reviewer, chat }` (planner/manager/inspector all resolve to `orchestrator` per [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16)). The accepted keys become exactly that set plus the fixed extra `default`. Old keys `planner`, `manager`, `inspector`, and `executor` are removed from `configSchema`. The behavioural consequence is now stated correctly: the schema stays a plain `z.object` (no `.strict()`), so unknown keys are *silently stripped* by Zod's default behaviour — they are not rejected. The router-test fixture line that sets `models.executor` is updated accordingly.
- **Accepted (reviewer point 3).** A derived `DispatchableRole` type and `DISPATCHABLE_ROLES` tuple are exported from `roster.ts` and threaded end-to-end: `DISPATCH_ROLE_MAP` value type, `ChildSpawner.role` parameter, and `createChildSpawner()` return type all become `DispatchableRole`. The bootstrap planner and chat creation paths in [src/server/bootstrap.ts](src/server/bootstrap.ts#L450-L500) do not flow through `ChildSpawner` (they are instantiated directly), so narrowing the spawner's parameter does not require a separate widening helper. The `assertExhaustive(role)` default is added at the end of the spawner `switch`.
- **Accepted (reviewer point 4).** The doctests-style SPEC enum consistency check is delegated to the plan/tests (see r2 plan step 15). The analysis claim is retained unchanged; the r2 plan now backs it.
- **Rejected:** none.

---

Two proposals. Both establish a single roster source of truth; they differ in how aggressively the surrounding code is restructured to consume it. A third proposal is rejected at the bottom with reasoning.

## Proposal A — Single declarative roster with renderer-composed prompt header

**Scope (files touched):**

- New: `src/agents/roster.ts` (~100-140 lines, the only place a role's metadata is written; includes `renderRosterSummary()`).
- Edited:
  - [src/agents/types.ts](src/agents/types.ts#L20-L28) — `AgentRole` becomes a re-export from `roster.ts`.
  - [src/types.ts](src/types.ts#L109) — `TaskSchema.assigned_to` becomes `z.enum(WORKER_ROLES)`.
  - [src/types.ts](src/types.ts#L160) — `TaskReportSchema.agent` becomes `z.enum(WORKER_ROLES)`.
  - [src/types.ts](src/types.ts#L268-L278) — `AgentStateSchema.agent_type` becomes `z.enum(ALL_ROLES)`.
  - [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L16-L33) — `DISPATCH_TOOLS` and `DISPATCH_ROLE_MAP` derived from roster entries with `dispatchTool != null`; `DISPATCH_ROLE_MAP` value type and `ChildSpawner.role` parameter become `DispatchableRole`.
  - [src/agents/base.ts](src/agents/base.ts#L807-L1018) — six per-role schema constants collapse into one worker factory plus two non-uniform schemas (`manager`, `inspector`) parametrised by the roster entry; `ROLE_DISPATCH_TOOLS` derived from `dispatchableBy`; `ROLE_TOOL_FILTER` keyed off `toolFilter`.
  - [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19) — `ROLE_ABORT_PRIORITY` derived by sorting roster entries with `abortPriority != null`.
  - [src/runtime/self-check.ts](src/runtime/self-check.ts#L10-L19) — `DEFAULT_SELF_CHECK_FREQUENCY` derived.
  - [src/agents/conventions.ts](src/agents/conventions.ts#L20-L66) — `CONVENTIONS` derived; entries with `convention === null` opt out.
  - [src/config.ts](src/config.ts#L34-L46) — `models` block keys derived strictly from `{ ROSTER[*].defaultModelKey } ∪ { "default" }`. Concretely, the accepted keys become `orchestrator, coder, researcher, data_agent, reviewer, chat, default`. The keys `planner`, `manager`, `inspector`, and `executor` are removed. The schema stays a plain `z.object` (default Zod stripping behaviour: unknown keys are dropped silently, no parse error).
  - [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16) — `ROUTING_ROLE_TO_MODEL_KEY` derived; pseudo-roles `supervisor`, `security`, `default` stay as fixed extras. The `executor` entry is removed (no agent has this role).
  - [src/server/bootstrap.ts](src/server/bootstrap.ts#L268-L378) — `createChildSpawner()` return type becomes `ChildSpawner` parametrised by `DispatchableRole`; the spawner `switch` gains `default: return assertExhaustive(role);`. Planner and chat construction at [src/server/bootstrap.ts](src/server/bootstrap.ts#L450-L500) is unchanged (they never go through the spawner).
  - **Prompt headers composed from the roster.** The hardcoded "## The Saivage System" role bullet lists at the top of [src/agents/planner.ts](src/agents/planner.ts#L21-L40), [src/agents/manager.ts](src/agents/manager.ts#L21-L40), [src/agents/coder.ts](src/agents/coder.ts), [src/agents/researcher.ts](src/agents/researcher.ts), [src/agents/data-agent.ts](src/agents/data-agent.ts), [src/agents/reviewer.ts](src/agents/reviewer.ts), [src/agents/inspector.ts](src/agents/inspector.ts), [src/agents/chat.ts](src/agents/chat.ts), and (currently orphaned, F01 scope) [src/agents/designer.ts](src/agents/designer.ts) become `${renderRosterSummary("planner")}` (etc.) interpolations inside the module-level template literal. No runtime restructuring is needed — interpolation happens once at module load.
  - [SPEC/v2/00-AGENT-SYSTEM.md](SPEC/v2/00-AGENT-SYSTEM.md) — add §2.x sections for Data Agent and Reviewer; update hierarchy diagram and agent-count table; add footnote: "The canonical list of roles is `src/agents/roster.ts`; this document follows that list."
  - [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L163) — update `assigned_to` enum; [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L190-L210) — update `TaskReport.agent`; [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L351) — update `agent_type`.

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
      summary: "The top-level strategist. Owns the project plan and drives stage dispatch.",
    },
    // manager, coder, researcher, data_agent, reviewer, inspector, chat ...
  ] as const satisfies readonly RosterEntry[];

  export type AgentRole = (typeof ROSTER)[number]["role"];
  export type WorkerRole = Extract<typeof ROSTER[number], { worker: true }>["role"];
  export type DispatchableRole = Extract<typeof ROSTER[number], { dispatchTool: string }>["role"];

  export const ALL_ROLES = ROSTER.map(r => r.role) as unknown as readonly [AgentRole, ...AgentRole[]];
  export const WORKER_ROLES = ROSTER.filter(r => r.worker).map(r => r.role) as unknown as readonly [WorkerRole, ...WorkerRole[]];
  export const DISPATCHABLE_ROLES = ROSTER.filter(r => r.dispatchTool).map(r => r.role) as unknown as readonly [DispatchableRole, ...DispatchableRole[]];
  ```

- Helpers: `getRoster(role)`, `getRosterByDispatchTool(name)`, `assertExhaustive(_: never): never`.
- `renderRosterSummary(forRole)` — returns the markdown bullet list every agent prompt currently hardcodes. Each entry's bullet is `- **${humanName}**${forRole === role ? " (you)" : ""}: ${summary}`. Agents that today phrase the list slightly differently ("(your boss)", "(your worker)") are normalised to the `(you)` marker only; the surrounding prose around the list is unchanged.

**What gets removed:**

- The standalone `AgentRole` union literal at [src/agents/types.ts](src/agents/types.ts#L20-L28).
- All hand-typed role lists in dispatcher / supervisor / self-check / conventions / config / resolver listed above.
- The vestigial `executor` model key at [src/config.ts](src/config.ts#L44) and [src/routing/resolver.ts](src/routing/resolver.ts#L11) — no agent has this role.
- The vestigial `planner`, `manager`, `inspector` model keys at [src/config.ts](src/config.ts#L38-L43) — the resolver maps those roles to `orchestrator` at [src/routing/resolver.ts](src/routing/resolver.ts#L4-L6) and [src/routing/resolver.ts](src/routing/resolver.ts#L273), so these keys are never read. Per architecture-first / no-backward-compat, dead config surface is deleted.
- Per-tool `RUN_*_SCHEMA` duplication in [src/agents/base.ts](src/agents/base.ts#L807-L955) for the four worker schemas (byte-identical apart from name/description), replaced by one factory.
- The hardcoded "## The Saivage System" role bullet list in each of the eight live agent prompt files (and the dead designer file, for whichever PR re-lands it).

**Risk:**

- *Type-level:* The `as unknown as readonly [T, ...T[]]` cast is the standard Zod-tuple idiom; if `tsc --strict` rejects, fall back to explicit-tuple literals plus a roster-length assertion in the test (see plan).
- *Zod stripping behaviour:* Removing `planner`, `manager`, `inspector`, `executor` from `models` does not raise a parse error for operators with stale config — those keys are dropped silently. This matches existing behaviour and is consistent with how the resolver already ignores `models.planner` (it maps `planner -> orchestrator`). The change is documented in plan step 14.
- *Prompt header composition:* `renderRosterSummary` is called at module-load time during template-literal interpolation. There is no test-time snapshot of these prompts (verified by inspecting `src/agents/agents.test.ts` — only behaviour is asserted). The rendered text is a near-byte-identical replacement for the existing bullet lists; only the per-agent "(you)" / "(your boss)" / "(your worker)" markers normalise to a single "(you)" marker on the line of the prompt's own role.
- *Schema parsing:* The Zod role enums today are subsets of what the code allows (e.g. `assigned_to` accepts only 4 of 8 live roles). The change preserves that subset (worker roles remain 4). Existing `tasks.json` files validate identically.
- *Spawner exhaustiveness:* Adding `default: assertExhaustive(role)` requires the spawner parameter to be `DispatchableRole`. `createChildSpawner()` is only called via the dispatcher tool-call path (which already filters via `DISPATCH_TOOLS`), and at the recursive self-call inside the `manager` case (also under the same constraint). Planner and chat are constructed directly in bootstrap, never through this spawner.

**What it enables (cross-issue):**

- F01 (designer wiring): adding `designer` becomes one roster entry + one spawner case; `renderRosterSummary` automatically advertises it to every other agent's prompt.
- F09 (worker helper dedup): worker base class can iterate `WORKER_ROLES`.
- F18 (prompt extraction): prompt bodies can be extracted to files; the header line continues to be `renderRosterSummary(role)` so the two changes are non-overlapping.
- F23 (supervisor priority incomplete): becomes a one-field-per-role decision in the roster.

**What it forbids:**

- Any future role addition that skips `roster.ts` will fail to compile (Zod enum types derived; spawner exhaustive; tool filters and dispatch maps derived; prompt header rendered from the same roster, so prompts cannot diverge).
- The `executor`, `planner`, `manager`, `inspector` model keys cannot be re-introduced silently — re-adding requires a roster entry whose `defaultModelKey` is one of those strings.

**Recommendation note:** smallest change that closes both the schema-level drift and the prompt-level drift in one commit. Recommended.

---

## Proposal B — Proposal A + designer placeholder + roster-record `models` schema

Everything from Proposal A, plus three structural additions.

**Additional scope:**

- `enabled: boolean` field on roster entries. When `enabled: false`, the role is excluded from Zod enums and from `DISPATCH_TOOLS` but still exists at the type level so an orphaned implementation file like [src/agents/designer.ts](src/agents/designer.ts#L74) typechecks against `agentRole: "designer"`. F01's wiring change is then a one-line `enabled: true` flip plus a spawner case.
- `models` block schema is rewritten from `z.object({...})` to `z.object` whose `defaultModelKey`-derived fields are spread programmatically via `z.record(z.enum(MODEL_KEYS), modelAssignmentSchema.optional())`-style helper, so future role additions auto-extend the accepted key set with no `configSchema` edit.
- A second renderer variant, `renderRosterSummary(forRole, { include: "interactsWith" })`, returns only the bullets for roles the focal role can dispatch to or is dispatched by. Used by manager/planner/chat prompts where the existing wording calls out only the relevant subset.

**What gets added beyond A:**

- `enabled: boolean` field on `RosterEntry`.
- `models` schema rewrite to a roster-keyed shape.
- `renderRosterSummary` variant with `interactsWith` mode.

**What gets removed beyond A:**

- Nothing additional; A already removes the eight hardcoded role lists.

**Risk:**

- The `enabled` flag is a roster-level capability for "role exists at the type level, not exposed at runtime yet". This is not a backward-compat shim — it is a legitimate state for an in-development role. Still, it adds a roster field that nobody currently needs; better added together with F01.
- `models` schema rewrite touches Zod ergonomics in a less-trivial way; the gain (auto-extending accepted keys) only pays off on roster additions, which are rare.
- `interactsWith` mode is one renderer parameter — small.

**What it enables:**

- Closes designer-orphan-without-roster ahead of F01 landing.
- Removes the need to touch `configSchema` when a new role is added.

**What it forbids:**

- Same forbidden surface as A, plus: ad-hoc per-config-version key additions to `models` (the record's key set is roster-derived).

**Recommendation note:** larger blast radius, partially overlaps with F01 and F32. Take only if F01 lands in the same review cycle.

---

## Proposal C (rejected) — Pure SPEC-only rewrite

"Update the SPEC enumerations to match the code; do not change the code." Closes the documentation-mismatch category but leaves the 13 in-code enumerations to drift again on the next role addition. The operator's directive is to make implementation authoritative; that authority should be expressed structurally, not via a SPEC patch the next code change can desync. Rejected.

---

## Recommendation

**Proposal A (extended).**

- It is the smallest change that fully closes F02's structural problem: 13 in-code role enumerations collapse to one declarative roster, the SPEC docs are corrected once, schemas/dispatcher/supervisor/self-check/conventions/config/router/types/spawner all derive from the same source, and every agent's prompt-header role bullet list is composed from the same renderer that feeds the schemas. The prompts and schemas are therefore guaranteed to agree at module-load time — not as a stylistic policy, but as a derivation.
- It does not block F18: prompt bodies stay where they are; F18 can extract them to files while the one-line `${renderRosterSummary(role)}` interpolation moves with them.
- It does not pre-empt F01: designer remains an unlisted file with no roster entry; F01 adds one entry and one spawner case to wire it in. (Proposal B's `enabled: false` placeholder is a nicer surface for that change but is not required to land F02.)
- It removes real dead config (`executor`, `planner`, `manager`, `inspector` model keys) without inventing any compat alias.

Proposal B is the right long-term destination. The right route is "land A now, let F01 add designer (with or without an `enabled` flag), and let F18 extract prompt bodies while preserving the header interpolation." Doing all three in one commit risks merge conflicts and bloats the review.
