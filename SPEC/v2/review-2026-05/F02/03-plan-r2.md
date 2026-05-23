# F02 — Plan (r2)

Plan for **Proposal A (extended)** — single declarative roster, mechanical derivation, prompt-header composition from `renderRosterSummary`, removal of dead model keys (`executor`, `planner`, `manager`, `inspector`), SPEC docs updated, SPEC↔roster consistency asserted in tests.

## Changes from r1

- **Accepted (reviewer point 1).** New step 6 adds `renderRosterSummary(forRole)` and a new step 7 rewrites each agent's hardcoded "## The Saivage System" bullet list as a `${renderRosterSummary("<role>")}` interpolation in the same module-level template literal. The old step numbering shifts; per-step links updated. The rollback text no longer claims handwritten prompts "cannot disagree" with schemas — the guarantee is grounded in the renderer.
- **Accepted (reviewer point 2).** Step 10 (was 9) is rewritten with the explicit accepted-keys list (`orchestrator, coder, researcher, data_agent, reviewer, chat, default`) and explicit deletions (`planner, manager, inspector, executor`). Step 11 (was 10) confirms the resolver entries removed (`executor` only; planner/manager/inspector entries still map to `orchestrator` and stay). The rollback paragraph is corrected: Zod default behaviour silently strips unknown keys, so operators with stale `models.executor` (or `.planner` / `.manager` / `.inspector`) see no parse error — the keys are simply dropped, identical to current behaviour for typos.
- **Accepted (reviewer point 3).** Step 12 (was 11) specifies `DispatchableRole` and `DISPATCHABLE_ROLES` exports from `roster.ts`, threads `DispatchableRole` through `DISPATCH_ROLE_MAP` value type, `ChildSpawner.role`, and `createChildSpawner()` return signature. The recursive manager-case `createChildSpawner(runtime)` call type-checks unchanged because the recursive spawner has the same narrowed type. The note about narrowing on `assertExhaustive()` is no longer needed.
- **Accepted (reviewer point 4).** New step 16 adds the SPEC↔roster consistency assertion to the new `roster.test.ts`: parse the enum strings in `SPEC/v2/01-DATA-MODEL.md` for `assigned_to`, `TaskReport.agent`, and `agent_type`; assert each set equals `WORKER_ROLES`, `WORKER_ROLES`, and `ALL_ROLES` respectively. The analysis claim therefore stands.
- **Rejected:** none.

## Ordered edit steps

1. **Create `src/agents/roster.ts`.** New file. Defines:
   - `RosterEntry` interface (fields per the analysis Contract section, plus `summary: string` consumed by `renderRosterSummary`).
   - `ROSTER` constant as `readonly RosterEntry[]` with eight entries (`planner`, `manager`, `coder`, `researcher`, `data_agent`, `reviewer`, `inspector`, `chat`). Each entry is a lift-and-tabulate from the existing sites — no behaviour change.
   - Derived exports: `AgentRole`, `WorkerRole`, `DispatchableRole`, `ALL_ROLES`, `WORKER_ROLES`, `DISPATCHABLE_ROLES` (use `as const satisfies readonly RosterEntry[]` plus the `as unknown as readonly [T, ...T[]]` idiom for Zod compatibility).
   - Helpers: `getRoster(role)`, `getRosterByDispatchTool(name)`, `renderRosterSummary(forRole)`.
   - `assertExhaustive(_: never): never`.

2. **Edit [src/agents/types.ts](src/agents/types.ts#L20-L28).** Delete the inline `AgentRole` union literal; replace with `export type { AgentRole } from "./roster.js";`. Re-verify type imports of `AgentRole` still resolve (`src/agents/base.ts`, `src/agents/conventions.ts`, `src/runtime/dispatcher.ts`, `src/runtime/self-check.ts`, `src/runtime/supervisor.ts`, `src/skills/loader.ts`, `src/server/bootstrap.ts`).

3. **Edit [src/types.ts](src/types.ts).** Add `import { WORKER_ROLES, ALL_ROLES } from "./agents/roster.js";` at the top, then:
   - Line ~109: `assigned_to: z.enum(WORKER_ROLES),`
   - Line ~160: `agent: z.enum(WORKER_ROLES),`
   - Lines ~269–278: `agent_type: z.enum(ALL_ROLES),`
   Confirm inferred TS types of `Task["assigned_to"]`, `TaskReport["agent"]`, `AgentState["agent_type"]` are byte-identical string-literal unions to the current ones (`npm run typecheck`).

4. **Edit [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L16-L39).** Replace inline `DISPATCH_TOOLS` and `DISPATCH_ROLE_MAP` with derivations:
   ```ts
   import { ROSTER, type DispatchableRole } from "../agents/roster.js";

   export const DISPATCH_ROLE_MAP: Record<string, DispatchableRole> = Object.fromEntries(
     ROSTER.filter(e => e.dispatchTool).map(e => [e.dispatchTool!, e.role as DispatchableRole]),
   );
   export const DISPATCH_TOOLS = new Set(Object.keys(DISPATCH_ROLE_MAP));
   ```
   Narrow `ChildSpawner.role` from `AgentRole` to `DispatchableRole`:
   ```ts
   export type ChildSpawner = (
     role: DispatchableRole,
     input: unknown,
     parentCtx: AgentContext,
   ) => Promise<AgentResult>;
   ```

5. **Edit [src/agents/base.ts](src/agents/base.ts#L807-L1018).**
   - Replace the six per-role schema constants (`RUN_MANAGER_SCHEMA`, `RUN_INSPECTOR_SCHEMA`, `RUN_CODER_SCHEMA`, `RUN_RESEARCHER_SCHEMA`, `RUN_DATA_AGENT_SCHEMA`, `RUN_REVIEWER_SCHEMA`) with: one `makeWorkerDispatchSchema(rosterEntry)` factory (covers coder/researcher/data_agent/reviewer — identical input shape modulo `name`/`description`) and the two non-uniform schemas (manager takes a stage object, inspector takes a request object) kept as explicit functions parametrised by the roster entry's `dispatchTool`/`description`.
   - Replace `ROLE_DISPATCH_TOOLS` (lines 953-957) with a derivation from `ROSTER`'s `dispatchableBy` arrays, producing the same three-key `Partial<Record<AgentRole, ToolSchema[]>>` (`planner`, `manager`, `chat`).
   - Replace `ROLE_TOOL_FILTER` (lines 992-1018) with a switch keyed on `getRoster(role).toolFilter` returning one of the filter functions (worker/planner/reviewer/inspector/chat).

6. **Add `renderRosterSummary(forRole)` to `roster.ts`.** Returns a markdown bullet list:
   ```
   - **Planner** (you): The top-level strategist. Owns the project plan...
   - **Manager**: A tactical executor scoped to one stage...
   ...
   ```
   The bullet for `forRole` carries the `(you)` marker; other bullets do not. Bullet text is the roster entry's `summary` field. The renderer is pure and called at module-load time during template-literal interpolation.

7. **Rewrite each agent prompt's role bullet list.** For each of:
   - [src/agents/planner.ts](src/agents/planner.ts#L21-L40)
   - [src/agents/manager.ts](src/agents/manager.ts#L21-L40)
   - [src/agents/coder.ts](src/agents/coder.ts)
   - [src/agents/researcher.ts](src/agents/researcher.ts)
   - [src/agents/data-agent.ts](src/agents/data-agent.ts)
   - [src/agents/reviewer.ts](src/agents/reviewer.ts)
   - [src/agents/inspector.ts](src/agents/inspector.ts)
   - [src/agents/chat.ts](src/agents/chat.ts)

   Replace the hardcoded `- **Planner**: ... \n - **Manager**: ...` bullet list (everything between "## The Saivage System" and the next `###` subheading) with `${renderRosterSummary("<role>")}` interpolation inside the existing module-level `const PROMPT = \`...\`` template literal. Surrounding prose (communication-protocol paragraphs, examples) is untouched. The "(you)" / "(your boss)" / "(your worker)" parentheticals collapse to a single "(you)" marker on the focal role's bullet only. [src/agents/designer.ts](src/agents/designer.ts) is out of scope here (F01 owns it); leave its hardcoded list untouched until F01 lands a roster entry, at which point a single line will replace it.

8. **Edit [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19).** Replace `ROLE_ABORT_PRIORITY` with:
   ```ts
   const ROLE_ABORT_PRIORITY: AgentRole[] = ROSTER
     .filter(e => e.abortPriority !== null)
     .sort((a, b) => a.abortPriority! - b.abortPriority!)
     .map(e => e.role);
   ```
   Verify the resulting array equals `["reviewer","data_agent","coder","researcher","manager"]` (the current production ordering at [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L13-L19)).

9. **Edit [src/runtime/self-check.ts](src/runtime/self-check.ts#L10-L19).** Replace `DEFAULT_SELF_CHECK_FREQUENCY` with `Object.fromEntries(ROSTER.map(e => [e.role, e.selfCheckFrequency])) as Record<AgentRole, number>;`. Confirm `chat` maps to `0`.

10. **Edit [src/agents/conventions.ts](src/agents/conventions.ts#L20-L66).** Replace the inline `CONVENTIONS` object with a derivation over `ROSTER`, skipping entries where `convention === null`. Keep `checkConvention` and `getConvention` signatures unchanged.

11. **Edit [src/config.ts](src/config.ts#L34-L46).** Rewrite the `models` block with the explicit accepted-keys set:
    ```ts
    const modelsBlockSchema = z
      .object({
        orchestrator: modelAssignmentSchema.optional(),
        coder: modelAssignmentSchema.optional(),
        researcher: modelAssignmentSchema.optional(),
        data_agent: modelAssignmentSchema.optional(),
        reviewer: modelAssignmentSchema.optional(),
        chat: modelAssignmentSchema.optional(),
        default: modelAssignmentSchema.optional(),
      })
      .default({ orchestrator: "anthropic/claude-sonnet-4-20250514" });
    ```
    Removed keys: `planner`, `manager`, `inspector`, `executor`. The schema stays a plain `z.object` (no `.strict()`); unknown keys in operator config are silently stripped (Zod default).

    Optionally, to keep the keys derived from the roster:
    ```ts
    const ROSTER_MODEL_KEY_FIELDS = Object.fromEntries(
      Array.from(new Set(ROSTER.map(e => e.defaultModelKey)))
        .map(k => [k, modelAssignmentSchema.optional()]),
    );
    const modelsBlockSchema = z
      .object({ ...ROSTER_MODEL_KEY_FIELDS, default: modelAssignmentSchema.optional() })
      .default({ orchestrator: "anthropic/claude-sonnet-4-20250514" });
    ```
    Both forms produce the same accepted-keys set. Pick the explicit form for clarity unless `tsc` infers a richer field-by-field optional union from the explicit one (it does).

12. **Edit [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16).** Replace `ROUTING_ROLE_TO_MODEL_KEY` with:
    ```ts
    export const ROUTING_ROLE_TO_MODEL_KEY: Record<string, string> = {
      ...Object.fromEntries(ROSTER.map(e => [e.role, e.defaultModelKey])),
      supervisor: "supervisor",
      security: "security",
      default: "default",
    };
    ```
    This produces entries `planner: "orchestrator"`, `manager: "orchestrator"`, `inspector: "orchestrator"`, `coder: "coder"`, `researcher: "researcher"`, `data_agent: "data_agent"`, `reviewer: "reviewer"`, `chat: "chat"` plus the three pseudo-roles. The `executor: "executor"` entry at [src/routing/resolver.ts](src/routing/resolver.ts#L11) is removed (no agent role maps to `executor`).

    Update [src/providers/router.test.ts](src/providers/router.test.ts#L12) — the fixture line `executor: "anthropic/claude-haiku-3"` no longer matches the schema and would be silently stripped at parse time. Replace it with `coder: "anthropic/claude-haiku-3"` (preserves the test's intent of exercising a per-role override; both `executor` and `coder` previously routed to themselves).

13. **Edit [src/server/bootstrap.ts](src/server/bootstrap.ts#L268-L378).** Tighten the spawner end-to-end:
    - `createChildSpawner()` return type becomes `ChildSpawner` (now parametrised by `DispatchableRole` per step 4).
    - The lambda parameter at [src/server/bootstrap.ts](src/server/bootstrap.ts#L274-L277) becomes `role: DispatchableRole`.
    - Append `default: return assertExhaustive(role);` to the spawner `switch`. With the narrowed type, the six cases (`manager`, `coder`, `researcher`, `data_agent`, `reviewer`, `inspector`) are exhaustive; adding a roster entry with a `dispatchTool` without a switch case becomes a `tsc` error.
    - Planner construction at [src/server/bootstrap.ts](src/server/bootstrap.ts#L462) is unchanged (it never flows through `ChildSpawner`).

14. **Edit [SPEC/v2/00-AGENT-SYSTEM.md](SPEC/v2/00-AGENT-SYSTEM.md).** Add §2.x subsections for Data Agent and Reviewer mirroring the existing Coder / Researcher format. Update the hierarchy diagram (§3) to show the manager dispatching `run_data_agent` and `run_reviewer`. Update the agent-count table. Add a footnote: "The canonical list of roles is `src/agents/roster.ts`; this document follows that list."

15. **Edit [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md).**
    - Line 163: change `assigned_to: "coder" | "researcher";` to `assigned_to: "coder" | "researcher" | "data_agent" | "reviewer";`.
    - In the `TaskReport` interface (around line 190-210): same update on `agent`.
    - Line 351: update `agent_type` to `"planner" | "manager" | "coder" | "researcher" | "data_agent" | "reviewer" | "inspector" | "chat"`.

16. **Remove `executor` references.** `git grep -n '\bexecutor\b' src/ SPEC/v2/ tests/` (where applicable). After steps 11 and 12, only the SPEC docs and any leftover code/test references should remain. Delete them in this same commit (no migration shim).

## Test strategy

**Existing tests that cover this area:**

- [src/agents/agents.test.ts](src/agents/agents.test.ts) — constructs agents with literal `agentRole` values. Passes without edits (literals remain valid `AgentRole`).
- [src/providers/router.test.ts](src/providers/router.test.ts#L12) — uses `models.executor`; updated to `models.coder` per step 12.
- Zod-parse tests of `Task`, `TaskReport`, `AgentState`, `SaivageConfig` — pass without edits because worker-role enum is byte-identical and `AgentState.agent_type` enumerates the same 8 live roles.

**New tests (single file, `src/agents/roster.test.ts`):**

1. `ROSTER` has unique `role` values.
2. `ROSTER` has unique non-null `dispatchTool` values.
3. `WORKER_ROLES` cardinality equals `ROSTER.filter(e => e.worker).length`.
4. `DISPATCHABLE_ROLES` cardinality equals `ROSTER.filter(e => e.dispatchTool != null).length`.
5. `DISPATCH_ROLE_MAP` (imported from `dispatcher.ts`) has exactly the entries the roster declares as dispatchable.
6. Computed `ROLE_ABORT_PRIORITY` array equals `["reviewer","data_agent","coder","researcher","manager"]` (locks the priority order against silent reshuffles on roster edits).
7. `DEFAULT_SELF_CHECK_FREQUENCY[role]` equals the previous per-role values.
8. `renderRosterSummary("planner")` includes the substring `**Planner** (you)` and includes `**Data Agent**` and `**Reviewer**` (defends against the original F02 symptom of planner-prompt omission).
9. `renderRosterSummary("manager")` includes `**Manager** (you)` and `**Data Agent**` and `**Reviewer**`.
10. **SPEC↔roster consistency (reviewer point 4).** Read [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md) once; regex-extract the union strings for `assigned_to`, `TaskReport.agent`, and `agent_type`; assert each parsed set equals `new Set(WORKER_ROLES)`, `new Set(WORKER_ROLES)`, and `new Set(ALL_ROLES)` respectively. The test fails loudly if SPEC and roster drift.
11. **Spawner exhaustiveness (type-level).** A `// @ts-expect-error` block in the test file asserting that calling the spawner with `role: "planner" as DispatchableRole` is a type error (planner is excluded from `DispatchableRole`).

**Exact validation commands** (Vitest, per repo conventions):

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/agents/roster.test.ts src/agents/agents.test.ts src/providers/router.test.ts
npx vitest run   # full suite
```

If `typecheck` fails on the `as unknown as readonly [T, ...T[]]` cast in `roster.ts`, fall back to declaring tuples explicitly (`export const ALL_ROLES = ["planner","manager",...] as const;` then assert `ALL_ROLES.length === ROSTER.length` and `new Set(ALL_ROLES).size === ROSTER.length` in the new test file).

## Rollback strategy

Single commit covering all 16 steps. If a regression appears post-merge: `git revert <sha>`. There is no on-disk format change, no migration script, no config migration — every consumer derives at module-load time, and the Zod-enum value sets are unchanged from current behaviour (only the source-of-truth moves).

**Externally observable change:** four model keys are removed from the accepted `models` block schema: `planner`, `manager`, `inspector`, `executor`. Because `configSchema` is a plain `z.object` (no `.strict()`), Zod's default behaviour silently strips unknown keys at parse time — operators with `models.planner` (or any of the four) in their `saivage.json` see **no parse error** after upgrading. The stripped keys simply have no effect, which matches the current behaviour for `models.executor` and `models.planner` (the resolver already ignored those keys: `executor` had no agent, and `planner`/`manager`/`inspector` were mapped to `orchestrator` by [src/routing/resolver.ts](src/routing/resolver.ts#L4-L6)). Per the architecture-first / no-backward-compat guideline, this is the correct removal; the rollback path for an operator who wants to assign per-role overrides is "set `models.orchestrator` (for planner/manager/inspector overrides) or `models.coder`/`researcher`/`data_agent`/`reviewer`/`chat` for worker overrides."

## Cross-issue ordering

- **Before F01 (designer wiring):** F01's writer should land after F02 so designer can be added as a single roster entry plus one spawner case. The `renderRosterSummary` interpolation in every other agent's prompt automatically advertises the new role on F01 merge.
- **Before F09 (worker helper dedup):** F09 benefits from the `WorkerRole` type and `getRoster()` helper. F09 should depend on F02.
- **Independent of F04 (default models):** F04 changes default model strings; F02 only moves the `models` block keys. No conflict, either order works.
- **Independent of F18 (prompt extraction):** F18 extracts prompt bodies to files; F02 leaves prompt bodies untouched apart from the single `${renderRosterSummary(role)}` interpolation. F18 carries the interpolation into the extracted file. No conflict.
- **Independent of F32 (config undocumented blocks):** F32 documents `security`/`supervisor`/`mcpServers`/`runtime.continuousImprovement`. F02 only touches the `models` block (and removes four dead keys). No conflict.
- **Subsumes part of F23 (supervisor priority incomplete):** the abort-priority decision becomes a per-role roster field. F23 then becomes purely a policy question ("should inspector and chat be abortable?") answered by setting those roster entries' `abortPriority` field.
