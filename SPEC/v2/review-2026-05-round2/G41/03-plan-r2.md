# G41 — Plan (r2, Design A)

## Implementation steps

1. **Create the shared types module.** Add new file
   `web/src/api/types.ts` with the following content. Field names mirror
   the Zod schemas at [src/types.ts](src/types.ts#L34-L48) and
   [src/types.ts](src/types.ts#L241-L259); literal string unions mirror
   the `z.enum(...)` arms.

   ```ts
   // web/src/api/types.ts
   //
   // Hand-written mirror of the Saivage HTTP response shapes the SPA
   // consumes from /api/state. Canonical source: src/types.ts (Zod
   // schemas). When the server schemas change, edit this file too;
   // vue-tsc on the web package is the load-bearing enforcement.

   // Mirrors z.enum(ALL_ROLES) at src/types.ts L242 and the ROSTER tuple at
   // src/agents/roster.ts L41-L211. Hand-duplicated; the server typecheck
   // breaks on any roster change, which keeps this list honest.
   export type AgentRole =
     | "planner"
     | "manager"
     | "coder"
     | "researcher"
     | "data_agent"
     | "reviewer"
     | "designer"
     | "inspector"
     | "chat";

   // Mirrors AgentStateSchema at src/types.ts L242-L249.
   export interface AgentState {
     agent_type: AgentRole;
     agent_id: string;
     status: "running" | "suspended" | "idle";
     current_task_id?: string;
     channel?: string;
     started_at: string;
   }

   // Mirrors RuntimeStateSchema at src/types.ts L251-L259.
   export interface RuntimeState {
     status: "idle" | "running" | "suspended" | "error";
     current_stage_id: string | null;
     active_agents: AgentState[];
     started_at: string;
     updated_at: string;
     pid: number;
   }

   // Mirrors StageSchema at src/types.ts L34-L42. All seven fields are
   // required; the array fields are required arrays, not optional.
   export interface PlanStage {
     id: string;
     objective: string;
     starting_points: string[];
     expected_outcomes: string[];
     acceptance_criteria: string[];
     references: string[];
     tags: string[];
   }

   // Mirrors PlanSchema at src/types.ts L44-L48.
   export interface Plan {
     updated_at: string;
     current_stage_id: string | null;
     stages: PlanStage[];
   }

   // GET /api/state response envelope.
   // src/server/server.ts L173-L180 — both fields read with readDocOrNull,
   // hence nullable.
   export interface ApiState {
     state: RuntimeState | null;
     plan: Plan | null;
   }
   ```

2. **Wire vue-tsc into the web build.** Edit
   [web/package.json](web/package.json#L1-L18):

   - In `scripts`, replace `"build": "vite build"` with
     `"build": "vue-tsc --noEmit -p tsconfig.json && vite build"` and add
     `"typecheck": "vue-tsc --noEmit -p tsconfig.json"`.
   - In `devDependencies`, add `"vue-tsc": "^2.1.0"`.

   Then from `saivage/web/` run `npm install` so the new devDep resolves
   into `web/node_modules/`. No root install is needed — the SPA package
   is self-contained.

   Rationale: without this step the shared module from step 1 is not
   load-bearing. `vite build` does not type-check SFC `<script setup>`
   blocks; only `vue-tsc` does. The reviewer of r1 flagged this gap
   explicitly.

3. **Fix `pollTitleStatus` in `App.vue`.** Open
   [web/src/App.vue](web/src/App.vue#L1-L20). Add the type-only import
   alongside the existing `./utils/api` import:

   ```ts
   import type { ApiState } from "./api/types";
   ```

   Replace [web/src/App.vue](web/src/App.vue#L126-L143) (the whole
   `pollTitleStatus` body) with:

   ```ts
   async function pollTitleStatus() {
     try {
       const data = await apiFetchJson<ApiState>("/api/state");
       runtimeStatus.value = data.state?.status ?? "";
       runtimeStage.value = data.state?.current_stage_id ?? "";
     } catch (err) {
       if (err instanceof ApiError && err.status === 401) {
         markUnauthorized();
         runtimeStatus.value = "";
         runtimeStage.value = "";
         return;
       }
       runtimeStatus.value = "";
       runtimeStage.value = "";
     }
   }
   ```

   Explicit deletions in this edit:

   - The inline anonymous generic
     `<{ status?: string; phase?: string; currentStage?: { id?: string } | null }>`.
   - The `data.phase` read.
   - The `data.currentStage?.id` read.
   - The `(data.status ?? data.phase ?? "").toString()` coalescing (the
     enum union narrows it for free; no `.toString()` needed).

4. **Deduplicate `AgentsView.vue`.** Open
   [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L20).
   Delete the local `interface AgentState` block at
   [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18).
   Add to the imports at the top of the `<script setup>` block:

   ```ts
   import type { AgentState } from "../api/types";
   ```

   No other code in the file changes. The `agent.agent_type !== "chat"`
   filter at
   [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L142)
   continues to narrow correctly against the canonical `AgentRole` union.

5. **Deduplicate `StatusPanel.vue`.** Open
   [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L1-L50).
   Delete the four local interface declarations at
   [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L41)
   in this order: `AgentState`, `RuntimeState`, `Stage`, `Plan`.

   Keep the local `HistoryEntry` at
   [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L42-L48).
   It backs the live `history` ref at
   [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L50)
   and is sourced from `/api/plan-history`, which is out of G41's scope.

   Add to the imports:

   ```ts
   import type { AgentState, RuntimeState, Plan, PlanStage } from "../api/types";
   ```

   Verify with grep that no surviving in-file token references the local
   `Stage` by name (the local `Plan` carried `stages: Stage[]`, which
   becomes `stages: PlanStage[]` transitively through the imported `Plan`;
   no explicit `Stage` reference should remain).

6. **Deduplicate `PlanView.vue`.** Open
   [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L1-L30).
   Delete both local interface declarations:

   - `interface Stage` at
     [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L17).
   - `interface Plan` at
     [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L19-L23).

   Add the type-only import:

   ```ts
   import type { Plan, PlanStage } from "../api/types";
   ```

   Keep the local `interface HistoryEntry` (PlanView reads it from
   `/api/plan-history`, same reason as StatusPanel).

   Template reads in PlanView at
   [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L243-L257)
   (`stage.expected_outcomes?.length`, `stage.acceptance_criteria?.length`,
   `stage.references?.length`, `stage.tags?.length`) remain valid: optional
   chaining on the canonical required-array fields is a redundant no-op that
   TypeScript allows. No template edits.

7. **Type-check + build.** From `saivage/web/`:

   ```sh
   npm run typecheck
   npm run build
   ```

   The `typecheck` invocation (added in step 2) runs `vue-tsc --noEmit`
   over every `.ts` and `.vue` file in `web/src/`. It is the load-bearing
   assertion that the five edited files agree on the shared `ApiState` /
   `RuntimeState` / `AgentState` / `Plan` / `PlanStage` shapes. The `build`
   invocation reruns `vue-tsc` and then `vite build`; both must succeed.

   Alternatively from `saivage/`:

   ```sh
   npm run build
   ```

   delegates to `web/npm run build` via
   [package.json](package.json#L13-L14) and continues into `tsup` for the
   server bundle.

8. **Self-check duplicate-interface elimination.** From `saivage/`:

   ```sh
   grep -rn "interface RuntimeState\|interface AgentState\|interface Plan\b\|interface Stage\b" web/src/
   ```

   Expected hits after the change:

   - `web/src/api/types.ts:…: interface AgentState`
   - `web/src/api/types.ts:…: interface RuntimeState`
   - `web/src/api/types.ts:…: interface PlanStage` — note: matches `Plan\b`
     only if the grep alternation includes it. With the regex above, the
     `interface Plan\b` alternative matches the canonical `Plan` (the `\b`
     boundary excludes `PlanStage`).
   - `web/src/api/types.ts:…: interface Plan`

   No matches outside `web/src/api/`. Any match in a component file means
   the deduplication step missed it. (`HistoryEntry` is not in the grep —
   it is intentionally kept local in two files; deleting it would break
   the live history rendering as flagged by the r1 review.)

9. **SFC sanity check (per workspace memory).** Before committing, run:

   ```sh
   for f in web/src/App.vue web/src/components/*.vue; do
     c=$(grep -c "<script setup" "$f")
     [ "$c" = "1" ] || echo "DUPLICATE SCRIPT BLOCK in $f ($c)"
   done
   ```

   No output is the pass condition. This catches the "edits silently
   reverting on long files" failure mode the user memory calls out.

## Validation

1. **Type-check (load-bearing).** `npm run typecheck` from `saivage/web/`
   (added in step 2) must complete with zero errors. Specifically inspect
   the `vue-tsc` output for:

   - `Property 'phase' does not exist on type 'ApiState'` — means an old
     reference survived; fix the source.
   - `Type 'string | null | undefined' is not assignable to type 'string'`
     — means the `?? ""` coalescing was missed; add it.
   - Any `Property 'stages' does not exist` or
     `Property 'expected_outcomes' does not exist on type 'PlanStage'` —
     means the shared `PlanStage` is missing a field; reconcile against
     [src/types.ts](src/types.ts#L34-L42).

2. **Vite build.** `npm run build` from `saivage/web/` (or `saivage/`)
   must succeed. Combined with step 1 this is the architecture-first
   replacement for the r1 plan's incorrect "`npm run build` runs vue-tsc"
   claim — r2 actually wires the type-checker in.

3. **Live smoke test against `saivage-v3` container.** With the daemon
   running on the dedicated v2 harness:

   ```sh
   curl -fsS http://10.0.3.112:8080/api/state | jq '.state.status, .state.current_stage_id'
   ```

   Then open `http://10.0.3.112:8080/` in a browser, wait at least 8 s (one
   `pollTitleStatus` interval; see
   [web/src/App.vue](web/src/App.vue#L149)), and confirm the document
   title is one of:

   - `Saivage · idle · Dashboard`
   - `Saivage · running · stg-XX · Agents`
   - `Saivage · suspended · stg-XX · Plan`
   - `Saivage · error · Debug`

   The pre-change title was always `Saivage · · Dashboard` (the `· ·`
   collapse at [web/src/App.vue](web/src/App.vue#L162) absorbed two empty
   segments) regardless of runtime state; any non-empty status/stage
   segment confirms the fix.

4. **Unauthorized path regression check.** With `SAIVAGE_API_TOKEN` set in
   the container and the SPA loaded without a token, confirm the title
   becomes `Saivage · ⚠ unauthorized · Dashboard` — the 401 branch in
   `pollTitleStatus` (unchanged by this edit) still calls
   `markUnauthorized()` and zeroes the refs. This guards the F26 contract.

5. **No new unit tests.** `pollTitleStatus` was not under test before, and
   writing a JSDOM test against a document-title watch is disproportionate
   to the three-line fix. `vue-tsc` plus the live smoke test cover the
   contract.

## Rollback

```sh
git checkout -- web/src/App.vue \
                web/src/components/AgentsView.vue \
                web/src/components/StatusPanel.vue \
                web/src/components/PlanView.vue \
                web/package.json
rm -f web/src/api/types.ts
rmdir web/src/api 2>/dev/null || true
( cd web && npm install )   # restore lockfile if vue-tsc was added
```

No persisted state, no on-disk schema, no daemon configuration is touched.
The SPA bundle is rebuilt at the next `npm run build`.

## Cross-finding coordination

- **G40 (operator doc).** No ordering dependency. G40 documents `/api/state`
  as `{state, plan}` — the same shape Proposal A asserts in `ApiState`.
  Land in either order; both finishing makes the doc, the server, and every
  SPA consumer agree.
- **G45 (internals doc).** No ordering dependency. Same drift class applied
  to `docs/internals/server.md`. G41 does not edit `docs/`.
- **G46 (AgentsView monolith).** No ordering dependency. If G46 lands first,
  this finding's edit against AgentsView collapses to a single import line.
  If G41 lands first, G46's refactor inherits the shared `AgentState` type
  and does not re-declare it. Either ordering is safe.
- **F26 (`useAuthState`).** Already shipped. Step 3 keeps the existing
  `useAuthState()`-driven 401 branch verbatim; no F26 surface changes.
- **Sequencing.** Orthogonal to every other open round-2 finding. Can land
  on its own commit, with or without any other G-series fix in flight.
