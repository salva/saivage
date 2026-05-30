# F02 — Plan (r1)

Plan for **Proposal A** (single declarative roster, mechanical derivation; `executor` model key removed; SPEC docs updated).

## Ordered edit steps

1. **Create `src/agents/roster.ts`.** New file. Defines:
   - `RosterEntry` interface (fields per the analysis Contract section).
   - `ROSTER` constant as `readonly RosterEntry[]` with eight entries (`planner`, `manager`, `coder`, `researcher`, `data_agent`, `reviewer`, `inspector`, `chat`). Populate each entry by extracting the existing values from the sites listed in step 4 — this is a **lift-and-tabulate**, not a behaviour change.
   - `AgentRole`, `WorkerRole`, `ALL_ROLES`, `WORKER_ROLES`, `DISPATCHABLE_ROLES` exports as derived types/tuples (use `as const satisfies readonly RosterEntry[]` plus the `as unknown as readonly [T, ...T[]]` idiom for Zod compatibility).
   - `getRoster(role)`, `getRosterByDispatchTool(name)`, `getWorkerRoles()`, `renderRosterSummary(forRole)` helpers.
   - `assertExhaustive(_: never): never` for switch checks (or import from a shared util if one already exists).

2. **Edit [src/agents/types.ts](src/agents/types.ts#L20-L28).** Delete the inline `AgentRole` union literal; replace with `export type { AgentRole } from "./roster.js";`. Re-verify all type imports of `AgentRole` still resolve (`src/agents/base.ts`, `src/agents/conventions.ts`, `src/runtime/dispatcher.ts`, `src/runtime/self-check.ts`, `src/runtime/supervisor.ts`, `src/skills/loader.ts`, `src/server/bootstrap.ts`).

3. **Edit [src/types.ts](src/types.ts).** Add `import { WORKER_ROLES, ALL_ROLES } from "./agents/roster.js";` at the top, then:
   - Line ~109: `assigned_to: z.enum(WORKER_ROLES),`
   - Line ~160: `agent: z.enum(WORKER_ROLES),`
   - Lines ~269–284: `agent_type: z.enum(ALL_ROLES),`
   Confirm the inferred TS types of `Task["assigned_to"]`, `TaskReport["agent"]`, `AgentState["agent_type"]` are byte-identical string-literal unions to the current ones (run `npm run typecheck`).

4. **Edit [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L16-L33).** Replace the inline `DISPATCH_TOOLS` and `DISPATCH_ROLE_MAP` constants with derivations:
   ```ts
   export const DISPATCH_ROLE_MAP: Record<string, AgentRole> = Object.fromEntries(
     ROSTER.filter(e => e.dispatchTool).map(e => [e.dispatchTool!, e.role]),
   );
   export const DISPATCH_TOOLS = new Set(Object.keys(DISPATCH_ROLE_MAP));
   ```

5. **Edit [src/agents/base.ts](src/agents/base.ts#L807-L1018).**
   - Replace the six per-role schema constants (`RUN_MANAGER_SCHEMA`, `RUN_INSPECTOR_SCHEMA`, `RUN_CODER_SCHEMA`, `RUN_RESEARCHER_SCHEMA`, `RUN_DATA_AGENT_SCHEMA`, `RUN_REVIEWER_SCHEMA`) with two factories: `makeWorkerDispatchSchema(rosterEntry)` (covers coder/researcher/data_agent/reviewer — identical input shape modulo name/description) and keep the two non-uniform schemas (manager takes a stage object, inspector takes a request object) as explicit constants but parametrised by the roster's `dispatchTool` name.
   - Replace `ROLE_DISPATCH_TOOLS` (lines 953–957) with `ROSTER.reduce<...>((acc, entry) => { ... acc[entry.role] = entry.dispatchableBy.map(...); ...}, {})` — or equivalently iterate `dispatchableBy` arrays.
   - Replace `ROLE_TOOL_FILTER` (lines 992–1018) with a switch keyed on `getRoster(role).toolFilter` returning one of the five filter functions (worker/planner/reviewer/inspector/chat). Move the filter functions next to the switch.

6. **Edit [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L14-L20).** Replace `ROLE_ABORT_PRIORITY` with:
   ```ts
   const ROLE_ABORT_PRIORITY: AgentRole[] = ROSTER
     .filter(e => e.abortPriority !== null)
     .sort((a, b) => a.abortPriority! - b.abortPriority!)
     .map(e => e.role);
   ```
   Verify the resulting array equals `["reviewer","data_agent","coder","researcher","manager"]` (the current production ordering).

7. **Edit [src/runtime/self-check.ts](src/runtime/self-check.ts#L10-L19).** Replace `DEFAULT_SELF_CHECK_FREQUENCY` with `Object.fromEntries(ROSTER.map(e => [e.role, e.selfCheckFrequency])) as Record<AgentRole, number>;`. Confirm `chat` still maps to `0`.

8. **Edit [src/agents/conventions.ts](src/agents/conventions.ts#L20-L66).** Replace the inline `CONVENTIONS` object with a derivation over `ROSTER`, skipping entries where `convention === null`. Keep the function signatures of `checkConvention` and `getConvention` unchanged.

9. **Edit [src/config.ts](src/config.ts#L36-L50).** Rewrite the `models` block:
   - Remove the `executor: modelAssignmentSchema.optional()` line.
   - Keep `orchestrator` and `default` as fixed keys.
   - Replace the per-role optional lines with a programmatic derivation over `ROSTER` — either a static `z.object({ ... })` shape built by iterating `ROSTER` (preserves field-by-field optionality) or, more idiomatic Zod, a `z.object` whose keys are spread from a helper. A pragmatic shape:
     ```ts
     const rosterModelFields = Object.fromEntries(
       ROSTER.map(e => [e.defaultModelKey, modelAssignmentSchema.optional()]),
     );
     const modelsBlockSchema = z.object({
       orchestrator: modelAssignmentSchema.optional(),
       default: modelAssignmentSchema.optional(),
       ...rosterModelFields,
     }).default({ orchestrator: "anthropic/claude-sonnet-4-20250514" });
     ```
   - Keep the existing default value for `orchestrator`.

10. **Edit [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16).** Replace `ROUTING_ROLE_TO_MODEL_KEY` with:
    ```ts
    export const ROUTING_ROLE_TO_MODEL_KEY: Record<string, string> = {
      ...Object.fromEntries(ROSTER.map(e => [e.role, e.defaultModelKey])),
      supervisor: "supervisor",
      security: "security",
      default: "default",
    };
    ```
    Remove the `executor: "executor"` entry. Verify [src/providers/router.test.ts](src/providers/router.test.ts#L12) — the test sets `executor: "anthropic/claude-haiku-3"` in a `models` block; update or remove that line since the schema no longer accepts `executor`.

11. **Edit [src/server/bootstrap.ts](src/server/bootstrap.ts#L293-L370).** Append `default: return assertExhaustive(role);` to the spawner `switch`. Narrow the parameter type so only roles with `dispatchTool != null` are accepted (the spawner is only ever called from the dispatcher), e.g. `role: DispatchableRole` where `DispatchableRole = Exclude<AgentRole, "planner" | "chat">` derived from `ROSTER.filter(e => e.dispatchTool != null)`.

12. **Edit [SPEC/v2/00-AGENT-SYSTEM.md](SPEC/v2/00-AGENT-SYSTEM.md).** Add §2.x subsections for Data Agent and Reviewer mirroring the existing §2.3 Coder / §2.4 Researcher format (inputs, lifecycle, outputs, behaviour, transitions). Update the hierarchy diagram in §3 to show the manager dispatching `run_data_agent` and `run_reviewer`. Update the agent-count table at line ~360-367 to include the two new roles. Add a footnote: "The canonical list of roles is `src/agents/roster.ts`; this document follows that list."

13. **Edit [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md).**
    - Line ~163: change `assigned_to: "coder" | "researcher";` to `assigned_to: "coder" | "researcher" | "data_agent" | "reviewer";`.
    - Line ~193: same update on `TaskReport.agent`.
    - Line ~351: update `agent_type` to include `data_agent` and `reviewer`.

14. **Remove `executor` references.** `git grep -n '\bexecutor\b'` across `src/`, `SPEC/v2/`, and tests. After steps 9 and 10, only the test in [src/providers/router.test.ts](src/providers/router.test.ts#L12) and any leftover SPEC mention should remain. Delete them in this same commit (no migration shim).

## Test strategy

**Existing tests that cover this area:**

- [src/agents/agents.test.ts](src/agents/agents.test.ts) — constructs agents with literal `agentRole` values. Must still pass without edits (the literal strings remain valid `AgentRole` values).
- [src/providers/router.test.ts](src/providers/router.test.ts) — uses `executor` in a `models` block; update to use a real role (`coder` or remove that line).
- Any Zod-parse tests of `Task`, `TaskReport`, `AgentState`, `SaivageConfig` — must still pass without edits because the worker-role enum is byte-identical and `AgentState.agent_type` widens to its already-correct 8-role set.

**New tests (single file, `src/agents/roster.test.ts`):**

- `ROSTER` has unique `role` values.
- `ROSTER` has unique non-null `dispatchTool` values.
- `WORKER_ROLES.length === ROSTER.filter(e => e.worker).length`.
- `DISPATCH_ROLE_MAP` (imported from `dispatcher.ts`) has exactly the entries the roster declares as dispatchable.
- Computed `ROLE_ABORT_PRIORITY` array equals the previously-hardcoded `["reviewer","data_agent","coder","researcher","manager"]` (locks down the priority order to prevent silent reshuffling on roster edits).
- `DEFAULT_SELF_CHECK_FREQUENCY[role]` equals the previous values for each of the 8 roles.
- Spawner exhaustiveness: a type-level test (`// @ts-expect-error` block) confirming that adding a new dispatchable role without a spawner case fails `tsc`.

**Exact validation commands** (Vitest, per repo conventions):

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/agents/roster.test.ts src/agents/agents.test.ts src/providers/router.test.ts
npx vitest run   # full suite
```

If `typecheck` fails on the `as unknown as readonly [T, ...T[]]` cast in `roster.ts`, fall back to declaring the tuples explicitly (`export const ALL_ROLES = ["planner","manager",...] as const;` then assert `ALL_ROLES.length === ROSTER.length` in the new test file). This is a known Zod-tuple ergonomics issue and the explicit-tuple workaround is the standard fix.

## Rollback strategy

Single commit covering all 14 steps. If a regression appears post-merge: `git revert <sha>`. There is no on-disk format change, no migration script, no config migration — every consumer derives at module-load time, and the Zod-enum value sets are unchanged from current behaviour (only the source-of-truth moves).

The only externally observable change is the removal of the `executor` model key. Operators who had `models.executor` in their `saivage.json` would now get a Zod-strict-parse error. Per the architecture-first / no-backward-compat guideline, this is the correct behaviour; the rollback path for an operator hit by this is "remove the `executor` line from `saivage.json`" (it was never wired to anything).

## Cross-issue ordering

- **Before F01 (designer wiring):** F01's writer should land after F02 so designer can be added as a single roster entry plus one spawner case. Marking F02 as a prerequisite for F01 in the metaplan.
- **Before F09 (worker helper dedup):** F09's writer benefits from the `WorkerRole` type and `getWorkerRoles()` helper. F09 should depend on F02.
- **Independent of F04 (default models):** F04 changes default model strings; F02 only moves the `models` block keys. No conflict, either order works.
- **Independent of F18 (prompt extraction):** F18 extracts prompt bodies to files; F02 leaves prompt bodies untouched. F18 will then point the header bullet list at `renderRosterSummary(role)`. No conflict.
- **Independent of F32 (config undocumented blocks):** F32 documents `security`/`supervisor`/`mcpServers`/`runtime.continuousImprovement`. F02 only touches the `models` block (and removes `executor`). No conflict.
- **Subsumes part of F23 (supervisor priority incomplete):** the abort-priority decision becomes a per-role roster field. F23 then becomes purely a policy question ("should inspector and chat be abortable?") answered by setting those roster entries' `abortPriority` field.
