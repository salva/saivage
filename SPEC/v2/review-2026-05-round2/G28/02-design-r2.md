# G28 — Design r2

Two designs. Option B is recommended.

## Option A — Focused fix: cross-doc write-ahead journal + recovery

Keep `plan.json` and `plan-history.json` as separate files. Add a
small write-ahead journal that records the intent of
`plan_complete_stage` before either target is touched, then drive a
recovery step at `PlanService.init()` that replays or rolls back any
half-applied completion.

### Shape

- New file: `.saivage/plan/pending-completion.json` (single-record;
  only one completion can be in flight because `serializeOp`
  serialises plan writes per
  [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L347-L357)).
- New helper in `PlanService`: `applyCompletionTransaction(record)`
  that does:
  1. `writeDoc(journalPath, record, JournalSchema)`,
  2. `writeDoc(planPath, nextPlan, PlanSchema)`,
  3. `writeDoc(historyPath, nextHistory, PlanHistorySchema)`,
  4. `unlink(journalPath)`.
- New `recoverPendingCompletion()` called from `init()`. If the
  journal exists:
  - if the history already contains the recorded completion id →
    finish by deleting the journal,
  - else → re-derive `nextPlan` and `nextHistory` from the journal
    record and the on-disk docs, redo steps 2–4.

### Files touched

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — new
  journal path, `applyCompletionTransaction`,
  `recoverPendingCompletion`, changes to `init()` and
  `plan_complete_stage`.
- [src/store/project.ts](../../../../src/store/project.ts#L72-L75) —
  new `paths.planJournal`.
- [src/types.ts](../../../../src/types.ts) — add `PlanJournalSchema`.
- Tests for the new recovery branch in `src/mcp/plan-server.test.ts`.

### Drawbacks

- Adds a third file and a recovery code path on top of a structural
  problem rather than removing it. Every future writer that touches
  both files has to opt into the journal or re-introduce the gap.
- Violates the project guideline "no migration shims, REMOVE old
  paths". A journal sidecar is a runtime patch.
- Other readers (`server.ts`, `chat.ts`, `handoff.ts`,
  `shutdown-handoff.ts`, `cli.ts`) still read the two files
  independently, so the inter-process inconsistency window between
  the plan write and the history write described in
  `01-analysis-r2.md` survives even on the happy path.

REJECTED.

---

## Option B — Single `plan.json` document with embedded history (RECOMMENDED)

Collapse the two documents into one. The "plan" and its history are
two arrays of stages that the same writer mutates together; they only
exist as separate files for historical reasons. Make them one
document and atomicity falls out of the existing `writeDoc`
primitive — no journal, no recovery code, no cross-file race for any
reader.

### Schema

New combined schema in [src/types.ts](../../../../src/types.ts):

```ts
export const PlanDocumentSchema = z.object({
  updated_at: z.string(),
  current_stage_id: z.string().nullable(),
  stages: z.array(StageSchema),              // active stages
  history: z.array(CompletedStageSchema),    // completed/failed/escalated/aborted
});
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;
```

`StageSchema` and `CompletedStageSchema` stay (they are the element
types). `PlanSchema`, `Plan`, `PlanHistorySchema`, `PlanHistory` are
removed outright per architecture-first.

#### Projection types (public surface)

The MCP tool contracts and HTTP endpoints continue to return slices
that look like the old `Plan` / `PlanHistory` shapes. Those slices
get explicit typed projection aliases so callers and tests are not
left with untyped object literals after the old names are gone:

```ts
// Returned by plan_get and GET /api/plan.
export type ActivePlanView = Pick<
  PlanDocument,
  "updated_at" | "current_stage_id" | "stages"
>;

// Returned by plan_get_history and GET /api/plan-history.
export type PlanHistoryView = { stages: PlanDocument["history"] };
```

Both aliases live in [src/types.ts](../../../../src/types.ts)
alongside `PlanDocument`. The barrel
[src/index.ts](../../../../src/index.ts#L6-L25) replaces the
`Plan`/`PlanHistory` re-exports with `PlanDocument`, `ActivePlanView`
and `PlanHistoryView`.

#### Document invariants (enforced at `init()` and at every write)

`PlanDocumentSchema` is extended with a `.superRefine` that hard-fails
on any of:

- `current_stage_id !== null` and is not the id of any active stage
  in `stages`.
- Any id appears in both `stages` and `history`.
- Any duplicate id within `stages` or within `history`.

`PlanService.init()` reads the doc via `readDocOrNull(docPath,
PlanDocumentSchema)`. If the parse fails (malformed JSON, schema
mismatch, refinement violation), `init()` throws — the service does
**not** silently fall back to an empty doc. Operators see the failure
at startup instead of running on a corrupted plan.

### On-disk layout

`.saivage/plan.json` is the single document. `.saivage/plan-history.json`
is removed from the project layout (no longer written by seed/init,
no longer read by anyone). No migration code is shipped; existing
deployments need an operator step to merge the two files once
(see `03-plan-r2.md` "Live deployment coordination").

### `PlanService` shape

```ts
export class PlanService {
  private docPath: string;       // join(saivageDir, "plan.json")
  private projectRoot: string;
  private opQueue: Promise<unknown> = Promise.resolve();
  private doc: PlanDocument | null = null;
  // ... gitCommitFn, lastCommitSha unchanged

  async init(): Promise<void> {
    await ensureDir(dirname(this.docPath));
    this.doc = await readDocOrNull(this.docPath, PlanDocumentSchema);
  }
}
```

Every mutator follows the same shape — build `nextDoc`, write once,
update cache, return a projection. Pseudocode for each:

- `plan_init(stages?)` — refuses if `this.doc !== null`. Builds
  `nextDoc = { updated_at, current_stage_id: null, stages: parsed,
  history: [] }`. Writes once. Returns `ActivePlanView`.
- `plan_get()` — refuses if `this.doc === null`. Returns
  `structuredClone({ updated_at, current_stage_id, stages })` from
  `this.doc`.
- `plan_get_stage(id)` — refuses if `this.doc === null`. Searches
  `this.doc.stages` first (returns `{ ...stage, source: "active" }`),
  then `this.doc.history` (returns `{ ...completed, source: "history" }`).
- `plan_get_current_stage()` — refuses if `this.doc === null`.
  Returns the active stage matching `this.doc.current_stage_id` or
  `null`.
- `plan_set_stages(stages, currentStageId)` — refuses if
  `this.doc === null`. Validates each stage and the
  `currentStageId` invariant. Builds `nextDoc = { ...this.doc,
  updated_at, current_stage_id, stages }` — **`history` is copied
  from `this.doc.history` verbatim**. Writes once. Updates cache.
- `plan_add_stage(stage)` — refuses if `this.doc === null`. Rejects
  duplicate id (checks both `stages` and `history` to enforce the
  no-overlap invariant). Builds `nextDoc` with `stages` pushed,
  `history` preserved. Writes once. Updates cache.
- `plan_remove_stage(id)` — refuses if `this.doc === null`. Removes
  from `stages`; nulls `current_stage_id` if it matched. `history`
  preserved. Writes once. Updates cache.
- `plan_set_current(id|null)` — refuses if `this.doc === null`.
  Validates that `id` is `null` or in `this.doc.stages`. Builds
  `nextDoc` with `current_stage_id` updated, `history` preserved.
  Writes once. Updates cache.
- `plan_complete_stage(args)` — refuses if `this.doc === null`.
  Builds `completedStage` from the active stage. Splices the stage
  out of `nextDoc.stages`, pushes it onto `nextDoc.history`, nulls
  `current_stage_id` if matched, bumps `updated_at`. Writes once.
  Updates cache. Then calls `archiveStage` (best-effort, unchanged).
- `plan_get_history(lastN?)` — refuses if `this.doc === null`.
  Returns `{ stages: this.doc.history.slice(-lastN) }`.
- `plan_commit(message)` — git-commits exactly `[this.docPath]`.
  Same noop-detection logic.

Every mutator preserves the non-mutated array. The mistake the
review flagged — accidentally dropping `history` on a normal
active-plan edit — is prevented structurally: every mutator builds
`nextDoc` via `structuredClone(this.doc)` (or equivalent spread of
all four fields) and only then mutates the relevant slice.

### Non-PlanService readers

All direct file readers move to the combined doc. Each handler does
one `readDoc(paths.plan, PlanDocumentSchema)` and projects to either
`ActivePlanView` or `PlanHistoryView` for its existing response
shape:

- [src/server/server.ts](../../../../src/server/server.ts#L144-L145),
  [#L176](../../../../src/server/server.ts#L176),
  [#L480-L481](../../../../src/server/server.ts#L480-L481),
  [#L515](../../../../src/server/server.ts#L515),
  [#L609](../../../../src/server/server.ts#L609) — `/api/plan` and
  `/api/plan-history` keep their existing JSON response shapes
  (projections from the same file).
- [src/agents/handoff.ts](../../../../src/agents/handoff.ts#L22-L23)
  — single read.
- [src/agents/chat.ts](../../../../src/agents/chat.ts#L282-L336)
  — single read.
- [src/runtime/shutdown-handoff.ts](../../../../src/runtime/shutdown-handoff.ts#L39-L40)
  — drop the second `readOptionalDoc`; one read.
- [src/server/cli.ts](../../../../src/server/cli.ts#L122) — single
  read.

### Files touched (full list)

- [src/types.ts](../../../../src/types.ts) — add
  `PlanDocumentSchema`, `PlanDocument`, `ActivePlanView`,
  `PlanHistoryView`; remove `PlanSchema`, `PlanHistorySchema`,
  `Plan`, `PlanHistory`.
- [src/index.ts](../../../../src/index.ts#L6-L25) — barrel: drop
  `Plan` / `PlanHistory` re-exports, add `PlanDocument`,
  `ActivePlanView`, `PlanHistoryView`.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) —
  single cache field, single path, every tool body rewritten per the
  pseudocode above, acknowledging comment removed.
- [src/store/project.ts](../../../../src/store/project.ts#L72-L75) —
  drop `paths.planHistory`; keep `paths.plan` only.
- [src/server/server.ts](../../../../src/server/server.ts),
  [src/agents/handoff.ts](../../../../src/agents/handoff.ts),
  [src/agents/chat.ts](../../../../src/agents/chat.ts),
  [src/runtime/shutdown-handoff.ts](../../../../src/runtime/shutdown-handoff.ts),
  [src/server/cli.ts](../../../../src/server/cli.ts) — read combined
  doc; project as needed.
- [src/agents/roster.ts](../../../../src/agents/roster.ts#L50) —
  `writeTerritory` becomes `[".saivage/plan.json"]`.
- Tests enumerated in `03-plan-r2.md` step 6.
- Specs and operator docs:
  [SPEC/v2/01-DATA-MODEL.md](../../01-DATA-MODEL.md#L97-L102),
  [SPEC/v2/03-PLAN-MCP-SERVICE.md](../../03-PLAN-MCP-SERVICE.md#L7-L40),
  [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md#L237),
  [docs/internals/plan-mcp.md](../../../../docs/internals/plan-mcp.md#L32-L40),
  [docs/internals/on-disk-layout.md](../../../../docs/internals/on-disk-layout.md#L13-L59).
- Generated TypeDoc tree `docs/api/` — regenerated by `npm run docs`
  on the next pass; no manual edits.

### Public API impact

- MCP tool contracts unchanged at the wire: `plan_get`,
  `plan_get_history`, `plan_complete_stage`, etc. return the same
  JSON shapes (now typed as `ActivePlanView` / `PlanHistoryView`).
- HTTP `/api/plan` and `/api/plan-history` keep their existing
  response shapes; their handlers read from one file.
- Planner write territory shrinks from two files to one — visible in
  any tool that introspects `roster.ts`.

### Deletion list (architecture-first; no migration shim)

- `PlanSchema`, `Plan`, `PlanHistorySchema`, `PlanHistory` exports in
  [src/types.ts](../../../../src/types.ts) — removed outright.
- `paths.planHistory` from `ProjectContext` in
  [src/store/project.ts](../../../../src/store/project.ts) — removed.
- The acknowledging comment block at
  [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L248-L253).
- The `this.plan` / `this.history` two-field cache plus the two-arg
  `writeDoc` sequence in `plan_complete_stage`.
- `.saivage/plan-history.json` from any seed/init helper that creates
  empty docs.
- Authoritative references to `plan-history.json` in
  [SPEC/v2/01-DATA-MODEL.md](../../01-DATA-MODEL.md),
  [SPEC/v2/03-PLAN-MCP-SERVICE.md](../../03-PLAN-MCP-SERVICE.md),
  [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md),
  [docs/internals/plan-mcp.md](../../../../docs/internals/plan-mcp.md),
  [docs/internals/on-disk-layout.md](../../../../docs/internals/on-disk-layout.md)
  — rewritten so the docs do not imply the file is still
  authoritative.

### G27 / G29 coordination embedded in the design

- **G27 (`started_at` on active `Stage`)** — `PlanDocumentSchema`
  embeds `StageSchema` by reference, so whichever lands first
  decides `StageSchema`'s exact field set. The recommended landing
  order, repeated in `03-plan-r2.md`, is **G27 first**: it adds
  `started_at` to `StageSchema` and updates `plan_set_current` to
  populate it. G28 then inherits the updated schema with no
  additional design change.
- **G29 (read-bypass on the op queue)** — G28 collapses the
  cross-doc disk window, which makes G29's read-bypass safe: once a
  reader bypasses the queue, it still reads a single
  schema-validated file written atomically. G29 lands after G28.

### Why this beats Option A

- Atomicity is a property of the data model, not an opt-in protocol.
  Any future writer (recovery code, future stage-completion variants)
  inherits it without having to remember to take the journal.
- Removes code rather than adding it — net negative LOC, matches the
  architecture-first rule.
- Eliminates the inter-process race between independent readers of
  the two files (the gap Option A's journal does not close for
  non-PlanService readers).
- Document invariants catch corruption at `init()` instead of letting
  the planner act on a broken disk state.

### Risk

- Live deployments contain real `plan-history.json` files. Since the
  guideline forbids in-code migration shims, the operator
  instructions in `03-plan-r2.md` cover a one-shot manual merge step
  per deployment, gated on operator approval. The merge target is
  precisely defined so an existing deployment cannot boot into a
  schema parse failure.
