# G28 — Design r1

Two designs. Option B is recommended.

## Option A — Focused fix: cross-doc write-ahead journal + recovery

Keep `plan.json` and `plan-history.json` as separate files. Add a
small write-ahead journal that records the intent of
`plan_complete_stage` before either target is touched, then drive a
recovery step at `PlanService.init()` that replays or rolls back any
half-applied completion.

### Shape

- New file: `.saivage/plan/pending-completion.json` (a single-record
  journal — only one completion can be in flight because the op queue
  serialises writes per G29's existing gate).
- New helper in `PlanService`: `applyCompletionTransaction(record)`
  that does:
  1. `writeDoc(journalPath, record, JournalSchema)`,
  2. `writeDoc(planPath, nextPlan, PlanSchema)`,
  3. `writeDoc(historyPath, nextHistory, PlanHistorySchema)`,
  4. `unlink(journalPath)`.
- New `recoverPendingCompletion()` called from `init()`. If the
  journal exists:
  - if the history already contains the recorded completion id → finish
    by deleting the journal,
  - else → re-derive `nextPlan` and `nextHistory` from the journal
    record and the on-disk docs, redo steps 2–4.

### Files touched

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — new
  journal path, `applyCompletionTransaction`, `recoverPendingCompletion`,
  changes to `init()` and `plan_complete_stage`.
- [src/store/project.ts](../../../../src/store/project.ts#L72-L75) —
  new `paths.planJournal`.
- [src/types.ts](../../../../src/types.ts) — add `PlanJournalSchema`.
- Tests for the new recovery branch in `src/mcp/plan-server.test.ts`.

### Public API impact

- No tool name changes.
- `PlanService.init()` now does I/O for a new path even when no
  recovery is needed (one extra `pathExists`).

### Deletion list

- Delete the acknowledging comment on
  [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L248-L253).
- Nothing else removed — the two-file layout stays.

### Test impact

- Net-new tests for journal-replay paths (process killed after step
  1, after step 2, journal present but redundant).
- Existing plan-server tests untouched.

### Drawbacks

- Adds a third file and a recovery code path on top of a structural
  problem rather than removing it. Every future writer that touches
  both files has to opt into the journal or re-introduce the gap.
- Violates the project guideline "no migration shims, REMOVE old
  paths". A journal sidecar is essentially a runtime patch.
- Other readers (`server.ts`, `chat.ts`, `handoff.ts`,
  `shutdown-handoff.ts`) still read the two files independently, so
  the inter-process inconsistency window between the plan write and
  the history write described in `01-analysis-r1.md` survives even on
  the happy path.

---

## Option B — One conceptual level up: single `plan.json` document with embedded history (RECOMMENDED)

Collapse the two documents into one. The "plan" and its history are
two arrays of stages that the same writer mutates together; they only
exist as separate files for historical reasons. Make them one document
and atomicity falls out of the existing `writeDoc` primitive — no
journal, no recovery code, no cross-file race for any reader.

### Shape

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

`StageSchema` and `CompletedStageSchema` stay (they are still the
element types). `PlanSchema` and `PlanHistorySchema` are removed
outright per architecture-first.

On disk: `.saivage/plan.json` is the single document. `.saivage/plan-history.json`
is deleted from the project layout — there is no migration code that
splits or merges files. Existing deployments need an operator step to
combine the two files once (see `03-plan-r1.md` "Cross-finding
coordination / live deployments").

`PlanService` collapses to one cache field and one disk path:

```ts
private doc: PlanDocument | null = null;
// init():
this.doc = await readDocOrNull(this.docPath, PlanDocumentSchema);
// every mutation: build nextDoc, await writeDoc(this.docPath, nextDoc, PlanDocumentSchema); this.doc = nextDoc;
```

`plan_complete_stage` becomes a single `writeDoc` call that updates
both arrays in one atomic rename. The acknowledged cross-doc gap
disappears structurally.

All non-PlanService readers move to the combined doc:

- [src/server/server.ts](../../../../src/server/server.ts#L144-L145),
  [#L176](../../../../src/server/server.ts#L176),
  [#L480-L481](../../../../src/server/server.ts#L480-L481),
  [#L515](../../../../src/server/server.ts#L515),
  [#L609](../../../../src/server/server.ts#L609) — one read instead of
  two; existing API shapes (`/api/plan`, `/api/plan-history`) keep
  returning the same JSON shapes by projecting from the combined doc.
- [src/agents/handoff.ts](../../../../src/agents/handoff.ts#L22-L23),
  [src/agents/chat.ts](../../../../src/agents/chat.ts#L282-L336),
  [src/runtime/shutdown-handoff.ts](../../../../src/runtime/shutdown-handoff.ts#L39-L40),
  [src/server/cli.ts](../../../../src/server/cli.ts#L122) — same.

### Files touched

- [src/types.ts](../../../../src/types.ts) — add
  `PlanDocumentSchema`/`PlanDocument`; remove `PlanSchema`,
  `PlanHistorySchema`, `Plan`, `PlanHistory`.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) —
  single cache field, single path, `plan_complete_stage` writes once,
  remove acknowledging comment; tool return shapes for `plan_get`,
  `plan_get_history` etc. stay backward-compatible at the tool
  boundary (they project the relevant slice from the combined doc).
- [src/store/project.ts](../../../../src/store/project.ts#L72-L75) —
  drop `paths.planHistory`; keep `paths.plan` only.
- [src/server/server.ts](../../../../src/server/server.ts),
  [src/agents/handoff.ts](../../../../src/agents/handoff.ts),
  [src/agents/chat.ts](../../../../src/agents/chat.ts),
  [src/runtime/shutdown-handoff.ts](../../../../src/runtime/shutdown-handoff.ts),
  [src/server/cli.ts](../../../../src/server/cli.ts) — read combined
  doc.
- [src/agents/roster.ts](../../../../src/agents/roster.ts#L50) —
  `writeTerritory` becomes `[".saivage/plan.json"]`.
- [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts#L209-L210),
  [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L123),
  [src/store/documents.test.ts](../../../../src/store/documents.test.ts#L374-L397),
  [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L83-L84),
  [src/runtime/shutdown-handoff.test.ts](../../../../src/runtime/shutdown-handoff.test.ts#L46-L100),
  [src/agents/chat.lifecycle.test.ts](../../../../src/agents/chat.lifecycle.test.ts#L79-L80),
  [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L586-L587),
  [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts#L57-L58),
  [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L46-L47)
  — drop `planHistory` path references; tests that wrote synthetic
  history files now write the combined doc.
- Planner prompt bootstrap blurb mentioning `plan.json` at
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L546)
  — wording stays accurate (still `plan.json`).

### Public API impact

- MCP tool contracts unchanged: `plan_get`, `plan_get_history`,
  `plan_complete_stage` return the same shapes (they project from the
  combined doc).
- HTTP `/api/plan` and `/api/plan-history` keep their response
  shapes; their handlers now read from a single source.
- Planner write territory shrinks from two files to one — visible in
  any tool that introspects `roster.ts`.

### Deletion list (architecture-first; no migration shim)

- `PlanSchema`, `Plan`, `PlanHistorySchema`, `PlanHistory` exports in
  [src/types.ts](../../../../src/types.ts) — removed; any external
  importers in-repo move to `PlanDocument` or local projections.
- `paths.planHistory` from `ProjectContext` in
  [src/store/project.ts](../../../../src/store/project.ts) — removed.
- The acknowledging comment block at
  [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L248-L253).
- One of `this.plan` / `this.history` fields plus the two-arg
  `writeDoc` sequence in `plan_complete_stage`.
- `.saivage/plan-history.json` from any seed/init helper that creates
  empty docs.

### Test impact

- Existing plan-server tests that read `plan-history.json` after a
  completion update to read the `history` array on the combined doc.
- New test: kill `plan_complete_stage` mid-call (simulate by stubbing
  `writeDoc` to throw after the first rename attempt would be
  irrelevant since there is only one rename now). Confirm that either
  both arrays are updated or neither is.
- All test files that compose `paths` (listed above) drop the
  `planHistory` entry.

### Why this beats Option A

- Atomicity is a property of the data model, not an opt-in protocol.
  Any future writer (recovery code, future stage-completion variants,
  migration tooling) inherits it without having to remember to take
  the journal.
- Removes code rather than adding it — net negative LOC, matches the
  architecture-first rule.
- Eliminates the inter-process race between independent readers of
  the two files (the gap that even Option A's journal doesn't close
  for non-PlanService readers).
- Leaves clean room for G27 (`started_at`) and G29 (read/write split):
  G27 only touches the `plan_complete_stage` body; G29 only touches
  the op queue dispatch. Neither depends on the two-file layout.

### Risk

- Live deployments contain real `plan-history.json` files. Since the
  guideline forbids in-code migration shims, the operator instructions
  in `03-plan-r1.md` cover a one-shot manual merge step per
  deployment, gated on operator approval.
