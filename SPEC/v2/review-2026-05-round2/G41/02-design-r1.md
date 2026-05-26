# G41 — Design (r1)

## Problem statement

`pollTitleStatus` in [web/src/App.vue](web/src/App.vue#L126-L143) reads
top-level `status`, `phase`, and `currentStage.id` from `/api/state`. The
endpoint returns `{ state, plan }` and `RuntimeState` is snake_case with no
`phase` field, so every read is `undefined` and the document title never
updates from its initial value. See
[01-analysis-r1.md](./01-analysis-r1.md).

## Constraints

- Architecture-first, no backward compatibility: do not preserve the
  hand-typed `{ status, phase, currentStage }` reading. Delete it.
- No migration shims: there is no historical wire format that ever shipped
  the flat shape; nothing to migrate.
- Remove obsolete code: every other SPA component that reads `/api/state`
  re-declares its own ad-hoc TypeScript shape; the design phase decides
  whether to delete those too.
- Avoid over-engineering: codegen against `src/types.ts` Zod schemas is
  out of scope. The SPA already builds with `tsc` only; no new build step.

## Proposal A — Hand-written shared types module under `web/src/api/`

**Idea.** Introduce a single `web/src/api/types.ts` that declares the
TypeScript shapes returned by every Saivage HTTP endpoint the SPA actually
consumes. Update `App.vue` to consume `ApiState` from that module so the
`pollTitleStatus` reads are type-checked against the canonical shape, and
opportunistically migrate the three components that today re-declare
`AgentState`, `RuntimeState`, and `Plan` to import them from the same place.

**Shape of `web/src/api/types.ts`.** Hand-written, mirroring the Zod
schemas at [src/types.ts](src/types.ts#L241-L259) for the subset the SPA
reads. Snake_case preserved (the wire format is snake_case; renaming on the
client is a fresh source of drift).

```ts
// web/src/api/types.ts
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

export interface ApiState {
  state: RuntimeState | null;
  plan: Plan | null;
}
```

The values `state` and `plan` are nullable because the server uses
`readDocOrNull` at
[src/server/server.ts](src/server/server.ts#L175-L179) — that nullability
is the third inline-typed surface the SPA currently swallows incorrectly.

**Bug-fix in `App.vue`.** Replace [web/src/App.vue](web/src/App.vue#L126-L143)
with:

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

- `phase` is deleted — no fallback, no compatibility branch. It never
  existed.
- `data.state?.current_stage_id` is `string | null`; `?? ""` collapses both
  null and undefined to the empty string that the watch already handles
  correctly at [web/src/App.vue](web/src/App.vue#L160) (`if (stage)`).
- The generic on `apiFetchJson` is the canonical `ApiState`, not an
  inline anonymous type.

**Opportunistic deduplication (architecture-first).** Migrate the
duplicate declarations:

- [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18)
  — delete the local `interface AgentState`; import it from
  `../api/types`.
- [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L42)
  — delete local `AgentState`, `RuntimeState`, `Stage`, `Plan`,
  `HistoryEntry`. Import `AgentState`, `RuntimeState`, `Plan` from
  `../api/types`. `Stage` is renamed `PlanStage` in the new module to
  avoid the noun clash with `runtime/recovery.ts` (server-side).
  `HistoryEntry` stays local: it is not part of `/api/state`; it is part
  of `/api/plan` and is read only by `StatusPanel`.
- [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L19)
  — delete local `interface Plan`; import from `../api/types`.

This is a small, surgical deduplication: four files (one new, three
edited), no new dependencies, no new build step. The shared module is the
single place to edit when the server's Zod schemas change. The next
finding that reshapes `/api/state` (or any other consumed route) edits
one file instead of grepping for inline interfaces.

**Files touched.**

- `web/src/api/types.ts` — new file (~30 lines).
- [web/src/App.vue](web/src/App.vue#L126-L143) — replace the three reads.
- [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L12-L18)
  — delete local interface, add import.
- [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L10-L42)
  — delete five local interfaces, add imports, keep `HistoryEntry` local.
- [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L19)
  — delete local interface, add import.

**Deletion list.**

- Inline interface `AgentState` × 2 (AgentsView, StatusPanel).
- Inline interface `RuntimeState` × 1 (StatusPanel).
- Inline interface `Stage` × 1 (StatusPanel) — replaced by `PlanStage`
  from the shared module.
- Inline interface `Plan` × 2 (StatusPanel, PlanView).
- The non-existent `phase` field reference in `App.vue`.
- The non-existent `currentStage.id` field reference in `App.vue`.

**Risks.** Two SFC components are also being touched (StatusPanel,
PlanView, AgentsView). Per the project memory on Vue SFC corruption, the
diffs must be small, focused on imports, and validated with
`grep -c "<script setup"` after editing. The `tsc` pass will catch
shape mismatches; no behavioural change is intended for those components.

**Test impact.** `npm run build` (Vite + `vue-tsc`) is the load-bearing
check: it type-checks `App.vue` against the new `ApiState` and will
refuse the build if any consumer still references `data.phase` or
`data.currentStage`. No new unit tests required; no test suite covers
`pollTitleStatus` today and writing one against a `<title>` watch is
disproportionate.

## Proposal B — Point fix only

**Idea.** Edit only the three lines in
[web/src/App.vue](web/src/App.vue#L126-L143). Leave the duplicated
interfaces in `AgentsView`, `StatusPanel`, `PlanView` alone. New file:
none.

**Replacement.**

```ts
const data = await apiFetchJson<{
  state?: { status?: string; current_stage_id?: string | null };
}>("/api/state");
runtimeStatus.value = data.state?.status ?? "";
runtimeStage.value = data.state?.current_stage_id ?? "";
```

**Files touched.** Only [web/src/App.vue](web/src/App.vue#L126-L143).

**Pros.** Minimal blast radius. One commit. No risk of corrupting other
SFC files. Lands in minutes.

**Cons.**

- Re-creates the original anti-pattern: a fourth inline-typed approximation
  of `/api/state`, freshly hand-written, in the same file that just had a
  drift bug. The next reshaping of `/api/state` will trip a fifth.
- Violates the architecture-first rule: the project memory explicitly
  rejects "minimal change" defaults. The recurring G40/G41/G45 pattern is
  the headline architectural finding behind this bug; ignoring it here
  guarantees the round-3 review will refile it.
- Loses the `RuntimeStateSchema` union narrowing
  (`"idle"|"running"|"suspended"|"error"`). The inline shape downgrades it
  to `string`, so the watch keeps consuming any string the field ever
  emits — including new ones a future schema change might add.

## Proposal C — Codegen from Zod schemas

**Idea.** Add a build step that walks `src/types.ts`, calls
`zod-to-ts` (or similar) on `RuntimeStateSchema`, `PlanSchema`,
`AgentStateSchema`, etc., and writes a generated `web/src/api/types.gen.ts`.
The SPA imports from that.

**Why it is rejected.**

- New dependency on a Zod-to-TS codegen library.
- New build-time pipeline step (predates `vue-tsc`, must run before Vite
  type-checks).
- Hard to get right cross-package (server is bundled by `tsup`, SPA by
  Vite; the generator script has to live in a third place).
- The SPA today consumes only `/api/state`, `/api/plan`,
  `/api/agents/:id/conversation`, `/api/notes`, `/api/files`, and a
  handful of debug endpoints — ~5 schemas. A 30-line hand-written
  `web/src/api/types.ts` covers them in one file the operator can read
  in 30 seconds. Codegen pays off when the schema surface is larger or
  changes faster than this.
- Cross-finding G40 already records this as a follow-on for the round-2
  metaplan ("Auto-generate operator/internal REST + WS reference").
  Round-2 is not the right time to introduce a Zod-to-TS pipeline for
  a single-file SPA.

## Recommendation

**Proposal A.** It is the smallest change that both fixes the bug and
removes the drift surface that produced it. The file count is small
(one new, three edited), the deletion list is concrete, and there is no
new tooling or dependency. Proposal B is mechanically simpler but
re-creates the anti-pattern in the same file, violating the
architecture-first rule. Proposal C is the right shape for a future
finding once the schema surface justifies the tooling.

## Cross-finding coordination

- **G40 (operator doc).** Orthogonal. G40 documents `/api/state` as
  `{state, plan}`; Proposal A confirms it. If G40 lands first the doc is
  already correct; if G41 lands first the doc still has to be rewritten
  for the other four drifts in the same file.
- **G45 (internals doc).** Orthogonal. Same docs-vs-code drift class,
  different doc.
- **G46 (AgentsView monolith).** Orthogonal but lightly coupled. G41 edits
  imports in `AgentsView.vue`; G46's planned refactor will not collide
  because it touches the render and data-fetching code, not the type
  declarations. If G46 lands first, G41's diff against `AgentsView.vue`
  collapses to one fewer file. Either ordering is safe.
- **F26 (`useAuthState`).** Already shipped. Proposal A is the same
  pattern (shared module, no codegen) applied to a different repeated
  SPA concern (response types instead of auth state).
