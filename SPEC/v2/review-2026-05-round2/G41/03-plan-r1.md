# G41 — Plan (r1, Design A)

## Implementation steps

1. **Create the shared types module.** Add new file
   `web/src/api/types.ts` with the following content. Field names mirror
   the Zod schemas at [src/types.ts](src/types.ts#L241-L259); literal
   string unions mirror the `z.enum(...)` arms.

   ```ts
   // web/src/api/types.ts
   //
   // Hand-written mirror of the Saivage HTTP response shapes consumed by the
   // SPA. Canonical source: src/types.ts (Zod schemas). When the server
   // schemas change, edit this file too.

   export interface AgentState {
     agent_type: string;
     agent_id: string;
     status: "running" | "suspended" | "idle";
     current_task_id?: string;
     channel?: string;
     started_at: string;
   }

   export interface RuntimeState {
     status: "idle" | "running" | "suspended" | "error";
     current_stage_id: string | null;
     active_agents: AgentState[];
     started_at: string;
     updated_at: string;
     pid: number;
   }

   export interface PlanStage {
     id: string;
     objective: string;
     tags?: string[];
   }

   export interface Plan {
     updated_at: string;
     current_stage_id: string | null;
     stages: PlanStage[];
   }

   // GET /api/state response envelope.
   // server.ts L173-L180 — both fields are read with readDocOrNull, hence nullable.
   export interface ApiState {
     state: RuntimeState | null;
     plan: Plan | null;
   }
   ```

2. **Fix `pollTitleStatus` in `App.vue`.** Open
   [web/src/App.vue](web/src/App.vue#L1-L20). Add the import alongside
   the existing `./utils/api` import:

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
   - The `(data.status ?? data.phase ?? "").toString()` coalescing.

3. **Deduplicate `AgentsView.vue`.** Open
   [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L20).
   Delete the local `interface AgentState` block at
   [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18).
   Add to the imports at the top of the `<script setup>` block:

   ```ts
   import type { AgentState } from "../api/types";
   ```

   No other code in the file changes (the `agent.agent_type !== "chat"`
   filter at
   [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L142)
   already matches the canonical type).

4. **Deduplicate `StatusPanel.vue`.** Open
   [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L1-L50).
   Delete the five local interface declarations at
   [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L42)
   in the order they appear (`AgentState`, `RuntimeState`, `Stage`,
   `Plan`, `HistoryEntry`). Add to the imports:

   ```ts
   import type { AgentState, RuntimeState, Plan, PlanStage } from "../api/types";
   ```

   Rename every in-file reference to the local `Stage` interface to
   `PlanStage`. `HistoryEntry` is not part of `/api/state` — it stays as
   a local interface declaration; keep it.

5. **Deduplicate `PlanView.vue`.** Open
   [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L1-L30).
   Delete the local `interface Plan` at
   [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L19).
   Add the import:

   ```ts
   import type { Plan } from "../api/types";
   ```

   Confirm no other interfaces in `PlanView.vue` collide with the new
   module exports; only `Plan` is being centralised in this step.

6. **Type-check + build.** From `saivage/`:

   ```sh
   npm run build
   ```

   This runs `vue-tsc --noEmit` plus `vite build`. The build must
   succeed; the type-checker is the load-bearing assertion that the four
   edited files agree on the shared `ApiState` / `RuntimeState` /
   `AgentState` / `Plan` shapes.

7. **Self-check duplicate-interface elimination.** From `saivage/`:

   ```sh
   grep -rn "interface RuntimeState\|interface AgentState\|interface Plan\b" web/src/
   ```

   Expected hits after the change:

   - `web/src/api/types.ts:…: interface AgentState`
   - `web/src/api/types.ts:…: interface RuntimeState`
   - `web/src/api/types.ts:…: interface Plan`

   No matches outside `web/src/api/`. Any match in a component file
   means the deduplication step missed it.

8. **SFC sanity check (per project memory).** Before committing, run:

   ```sh
   for f in web/src/App.vue web/src/components/*.vue; do
     c=$(grep -c "<script setup" "$f")
     [ "$c" = "1" ] || echo "DUPLICATE SCRIPT BLOCK in $f ($c)"
   done
   ```

   No output is the pass condition. This catches the "edits silently
   reverting on long files" failure mode the memory notes call out.

## Validation

1. **Type-check.** `npm run build` (Step 6) — must complete with no
   errors. Pay attention to `vue-tsc` output: any "Property 'phase' does
   not exist on type 'ApiState'" type error means an old reference
   survived; any "Type 'string | null | undefined' is not assignable to
   type 'string'" means the `?? ""` coalescing was missed somewhere.
2. **Live smoke test against `saivage-v3` container.** With the daemon
   running on the dedicated v2 harness:

   ```sh
   curl -fsS http://10.0.3.112:8080/api/state | jq '.state.status, .state.current_stage_id'
   ```

   Then open `http://10.0.3.112:8080/` in a browser, wait ≥ 8 s (one
   `pollTitleStatus` interval at
   [web/src/App.vue](web/src/App.vue#L149)), and confirm the browser
   tab title is one of:

   - `Saivage · idle · Dashboard` (no stage)
   - `Saivage · running · stg-XX · Agents` (running with a current stage)
   - `Saivage · suspended · stg-XX · Plan`
   - `Saivage · error · Debug`

   The pre-change title was always `Saivage · · Dashboard` (collapsed by
   the `replace("· ·", "·")` cleanup at
   [web/src/App.vue](web/src/App.vue#L162)) regardless of runtime state;
   any non-empty status/stage segment confirms the fix.
3. **Unauthorized path regression check.** Set `SAIVAGE_API_TOKEN` and
   reload the SPA without a token. Confirm the title becomes
   `Saivage · ⚠ unauthorized · Dashboard` (the 401 branch in
   `pollTitleStatus` still calls `markUnauthorized()` and zeroes the
   refs). The branch is unchanged by this finding; this check guards
   the F26 contract.
4. **No new unit tests.** `pollTitleStatus` was not under test before
   this change, and writing a JSDOM test against a `<title>` watch is
   disproportionate to the three-line fix. The `vue-tsc` pass plus the
   live smoke test cover the contract.

## Rollback

`git checkout -- web/src/App.vue web/src/components/AgentsView.vue web/src/components/StatusPanel.vue web/src/components/PlanView.vue && rm web/src/api/types.ts && rmdir web/src/api 2>/dev/null || true`.

No persisted state, no schema, no build configuration is touched. The
SPA bundle is rebuilt at the next `npm run build`; nothing has to be
migrated on disk.

## Cross-finding coordination

- **G40 (operator doc).** No ordering dependency. G40 documents
  `/api/state` as `{state, plan}` which is the same shape Proposal A
  asserts in `ApiState`. Land in either order; both finishing makes the
  doc, the server, and every SPA consumer agree.
- **G45 (internals doc).** No ordering dependency. Same drift class
  applied to `docs/internals/server.md`. G41 does not edit `docs/`.
- **G46 (AgentsView monolith).** No ordering dependency. If G46 lands
  first, this finding's edit against `AgentsView.vue` collapses to a
  single import line. If G41 lands first, G46's refactor inherits the
  shared `AgentState` type and does not need to re-declare it. Either
  ordering is safe; do not block.
- **F26 (`useAuthState`).** Already shipped. Step 2 keeps the existing
  `useAuthState()`-driven 401 branch verbatim; no F26 surface changes.
- **Sequencing.** Orthogonal to every other open round-2 finding. Can
  land on its own commit, with or without any other G-series fix in
  flight.
