# G41 — Design (r2)

## Problem statement

`pollTitleStatus` in [web/src/App.vue](web/src/App.vue#L126-L143) reads
top-level `status`, `phase`, and `currentStage.id` from `/api/state`. The
endpoint returns `{ state, plan }` and `RuntimeState` is snake_case with no
`phase` field, so every read is `undefined` and the document title never
updates from its initial value. See
[01-analysis-r2.md](./01-analysis-r2.md).

## Constraints

- Architecture-first, no backward compatibility: do not preserve the
  hand-typed `{ status, phase, currentStage }` reading. Delete it.
- No migration shims: there is no historical wire format that ever shipped
  the flat shape; nothing to migrate.
- Remove obsolete code: every SPA component that reads `/api/state` re-declares
  its own ad-hoc TypeScript shape; the design phase decides whether to delete
  those too. The reviewer of r1 also required including PlanView's local
  `Stage` in the deletion list.
- Avoid over-engineering: codegen against [src/types.ts](src/types.ts) Zod
  schemas is out of scope.
- Validate what you claim: the web build is Vite-only today
  ([web/package.json](web/package.json#L8)); the plan must either stop claiming
  template type safety or wire `vue-tsc` in. r2 wires it in.

## Reviewer-required changes addressed

1. **Shared `PlanStage` mirrors the full canonical `StageSchema`.** Round 1
   defined `PlanStage` as `{ id, objective, tags? }`, a subset that broke
   PlanView's template reads of `expected_outcomes`, `acceptance_criteria`,
   and `references`. r2's shared type mirrors all seven required fields of
   [src/types.ts](src/types.ts#L34-L42) — including required arrays. PlanView's
   `stage.expected_outcomes?.length` template chains remain valid TypeScript
   against the wider type (optional chaining on a defined value is a no-op).
2. **Duplicate-interface deletion list is internally consistent.** `HistoryEntry`
   stays local in StatusPanel — it is a partial read of `/api/plan-history`,
   not `/api/state`, and broadening the shared module to `CompletedStage` is
   out of scope for G41. The deletion list covers the four shapes that mirror
   `/api/state` and `/api/plan` only: `AgentState`, `RuntimeState`, `Stage`,
   `Plan`. PlanView's local `Stage` at
   [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L17)
   is included.
3. **Validation no longer claims `vue-tsc` runs out of the box.** r2 adds
   `vue-tsc` as a `devDependency` in `web/package.json` and adds a
   `typecheck` npm script that runs `vue-tsc --noEmit -p tsconfig.json`. The
   validation step then invokes that script explicitly. Without this addition
   the shared module is not load-bearing: nothing would refuse a future build
   that re-introduces `data.phase`.
4. **`AgentState.agent_type` narrowing is intentional and documented.** The
   shared module mirrors the `z.enum(ALL_ROLES)` literal union (nine roles
   from [src/agents/roster.ts](src/agents/roster.ts#L41-L211)), with a
   pointer comment to roster.ts. Drift risk is minimal — the roster is a
   server-side enum that any schema change would trip immediately on the
   server typecheck.

## Proposal A — Hand-written shared types module under `web/src/api/`

**Idea.** Introduce a single `web/src/api/types.ts` that declares the
TypeScript shapes returned by every Saivage HTTP endpoint the SPA currently
consumes through `/api/state`. Update `App.vue` to consume `ApiState` from
that module so the `pollTitleStatus` reads are type-checked against the
canonical shape, and migrate the three components that today re-declare
`AgentState`, `RuntimeState`, `Stage`, and `Plan` to import them from the
same place. Wire `vue-tsc` into the web build so the shared module is
actually enforced.

**Shape of `web/src/api/types.ts`.** Hand-written, mirroring the Zod schemas
at [src/types.ts](src/types.ts#L34-L48) and [src/types.ts](src/types.ts#L241-L259).
Snake_case preserved (the wire format is snake_case; renaming on the client
is a fresh source of drift).

```ts
// web/src/api/types.ts
//
// Hand-written mirror of the Saivage HTTP response shapes the SPA consumes
// from /api/state. Canonical source: src/types.ts (Zod schemas). When the
// server schemas change, edit this file too; vue-tsc on the web package
// is the load-bearing enforcement.

// Mirrors z.enum(ALL_ROLES) at src/types.ts L242 and the ROSTER tuple at
// src/agents/roster.ts L41-L211. Hand-duplicated; server typecheck catches
// any roster change immediately, which is the forcing function that keeps
// this list honest.
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

// Mirrors StageSchema at src/types.ts L34-L42. All seven fields required;
// the array fields are required arrays, not optional. Snake_case preserved.
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

**Bug-fix in `App.vue`.** Replace
[web/src/App.vue](web/src/App.vue#L126-L143) with:

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

Notes:

- `phase` is deleted — no fallback, no compatibility branch. It never existed.
- `data.state?.current_stage_id` is `string | null`; `?? ""` collapses both
  null and undefined to the empty string the watch already handles correctly
  at [web/src/App.vue](web/src/App.vue#L160) (`if (stage)`).
- The generic on `apiFetchJson` is the canonical `ApiState`, not an inline
  anonymous type.

**Opportunistic deduplication (architecture-first).** Migrate the duplicate
declarations:

- [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18):
  delete the local `interface AgentState`; import `AgentState` from
  `../api/types`.
- [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L42):
  delete the local `AgentState`, `RuntimeState`, `Stage`, and `Plan`. Keep
  the local `HistoryEntry` at
  [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L42-L48)
  (it is sourced from `/api/plan-history`, out of G41's scope). Import
  `AgentState`, `RuntimeState`, `Plan`, and `PlanStage` from `../api/types`.
  The single in-file reference to the now-deleted local `Stage` (in the
  `stages` array typing inherited via `Plan`) is satisfied transitively by
  the imported `Plan.stages: PlanStage[]`; no other in-file code refers to
  `Stage` by name.
- [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L23):
  delete both the local `interface Stage` and the local `interface Plan`.
  Import `Plan` and `PlanStage` from `../api/types`. The single explicit
  reference to the local name `Stage` is the `stages: Stage[]` member of the
  local `Plan` — both vanish together; remaining template reads
  (`stage.expected_outcomes?.length` etc.) resolve against the imported
  `PlanStage`. The local `HistoryEntry` at PlanView (used by the history
  rendering block) stays local.

This is a small, surgical deduplication: four files (one new, three edited),
no new product dependency, one devDependency added (`vue-tsc`) so the
shared module is actually checked. The shared module is the single place to
edit when the server Zod schemas change. The next finding that reshapes
`/api/state` (or `/api/plan`) edits one file instead of grepping for inline
interfaces.

**Build wiring.** Add `vue-tsc` to `web/package.json` devDependencies and a
`typecheck` script:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit -p tsconfig.json && vite build",
    "typecheck": "vue-tsc --noEmit -p tsconfig.json",
    "preview": "vite preview"
  },
  "devDependencies": {
    "vue-tsc": "^2.1.0"
  }
}
```

`vue-tsc` chains into the existing `npm run build` (root delegates to
`web/npm run build` via [package.json](package.json#L14)). The version is
picked to match Vue 3.5 — `vue-tsc 2.x` is the current stable line for that
Vue minor and ships its own bundled `typescript` toolchain compatible with
the existing `typescript ^5.9.0` devDep.

**Files touched.**

- `web/src/api/types.ts` — new file (~50 lines, all types + comments).
- [web/src/App.vue](web/src/App.vue#L126-L143) — replace the three reads,
  add one type-only import.
- [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18)
  — delete one local interface, add one type-only import.
- [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L42)
  — delete four local interfaces (`AgentState`, `RuntimeState`, `Stage`,
  `Plan`); keep `HistoryEntry`; add one type-only import.
- [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L9-L23)
  — delete two local interfaces (`Stage`, `Plan`); keep local `HistoryEntry`;
  add one type-only import.
- [web/package.json](web/package.json#L8) — add `vue-tsc` devDep and
  `typecheck` script; chain `vue-tsc` into `build`.

**Deletion list.**

- Inline interface `AgentState` × 2 (AgentsView, StatusPanel).
- Inline interface `RuntimeState` × 1 (StatusPanel).
- Inline interface `Stage` × 2 (StatusPanel, PlanView) — replaced by the
  canonical `PlanStage` from the shared module.
- Inline interface `Plan` × 2 (StatusPanel, PlanView).
- The non-existent `phase` field reference in `App.vue`.
- The non-existent `currentStage.id` field reference in `App.vue`.
- Total: seven inline declarations + two phantom field reads.

**Risks.** Three SFC files are edited (AgentsView, StatusPanel, PlanView).
Per the workspace memory on Vue SFC corruption, edits must be small, focused
on the imports/interface block, and validated with
`grep -c "<script setup"` after each. The new `vue-tsc` pass catches shape
mismatches; no behavioural change is intended for those components.

**Test impact.** With the added `vue-tsc` script and chained-into-build call,
`npm run build` becomes the load-bearing check: it type-checks every SFC
against the new shared module and refuses the build if any consumer still
references `data.phase` or `data.currentStage`, or if any component's
template reads a field that does not exist on the canonical `PlanStage` /
`RuntimeState`. No new unit tests required.

## Proposal B — Point fix only

**Idea.** Edit only the three lines in
[web/src/App.vue](web/src/App.vue#L126-L143). Leave the duplicated interfaces
in `AgentsView`, `StatusPanel`, `PlanView` alone. New file: none. `vue-tsc`:
not wired.

**Replacement.**

```ts
const data = await apiFetchJson<{
  state?: { status?: string; current_stage_id?: string | null };
}>("/api/state");
runtimeStatus.value = data.state?.status ?? "";
runtimeStage.value = data.state?.current_stage_id ?? "";
```

**Pros.** Minimal blast radius. One file. No risk of SFC corruption.

**Cons.**

- Re-creates the original anti-pattern: a fourth inline-typed approximation
  of `/api/state`, freshly hand-written, in the same file that just had a
  drift bug.
- Violates the architecture-first rule: the workspace memory explicitly
  rejects "minimal change" defaults. G40/G41/G45 is the same defect class
  three times; ignoring it here guarantees a fourth.
- Without `vue-tsc`, even the point fix is unenforced — a future regression
  to `data.phase` would build cleanly.

## Proposal C — Codegen from Zod schemas

**Idea.** Walk `src/types.ts`, call `zod-to-ts` on the relevant schemas, emit
`web/src/api/types.gen.ts`.

**Why rejected.**

- New runtime dependency on a Zod-to-TS codegen library.
- New build pipeline step that must precede `vite build`.
- Cross-package layout problem (server is bundled by `tsup`, SPA by Vite;
  the generator lives nowhere natural).
- The SPA today consumes ~5 schemas. A 50-line hand-written
  `web/src/api/types.ts` covers them in one file an operator reads in 30
  seconds. Codegen pays off when the schema surface is larger or changes
  faster than this.
- G40 already records this as a follow-on for the round-2 metaplan
  ("Auto-generate operator/internal REST + WS reference"). Round 2 is not
  the right time to introduce Zod-to-TS for a single-file SPA.

## Recommendation

**Proposal A.** It is the smallest change that fixes the bug, removes the
drift surface that produced it, and adds the only check (`vue-tsc`) that
makes the new shared module load-bearing. The file count is small (one new,
four edited, one package.json bump), the deletion list is concrete, and the
new devDependency is a standard Vue 3 toolchain piece, not a bespoke
addition. Proposal B is mechanically simpler but re-creates the
anti-pattern in the same file, violating the architecture-first rule and
leaving the bug class unenforced. Proposal C is the right shape for a
future finding once the schema surface justifies the tooling.

## Cross-finding coordination

- **G40 (operator doc).** Orthogonal. G40 documents `/api/state` as
  `{state, plan}`; Proposal A asserts the same in `ApiState`. If G40 lands
  first the doc is already correct; if G41 lands first the doc still needs
  the rewrite for the four drifts in the same file.
- **G45 (internals doc).** Orthogonal. Same drift class, different doc.
- **G46 (AgentsView monolith).** Orthogonal but lightly coupled. G41 edits
  imports in AgentsView; G46's planned refactor will not collide because it
  touches render and data-fetching code, not type declarations. Either
  ordering is safe.
- **F26 (`useAuthState`).** Already shipped. Proposal A is the same pattern
  (shared module, no codegen) applied to a different repeated SPA concern
  (response types instead of auth state). The 401 branch in `pollTitleStatus`
  is preserved verbatim.
