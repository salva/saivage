# G28 — Plan r1 (Option B: single `plan.json` with embedded history)

## Steps

1. **Add `PlanDocumentSchema`** in
   [src/types.ts](../../../../src/types.ts) with fields
   `updated_at`, `current_stage_id`, `stages: Stage[]`,
   `history: CompletedStage[]`. Export `PlanDocument`. Remove
   `PlanSchema`, `Plan`, `PlanHistorySchema`, `PlanHistory` exports;
   adjust the section header comment block accordingly.

2. **Drop `paths.planHistory`** in
   [src/store/project.ts](../../../../src/store/project.ts#L73-L74).
   Update `ProjectContext.paths` type so the field is gone. Update
   `seedProject` (and any helper that writes empty plan/history files
   on init) to seed a single `plan.json` with empty `stages` and
   `history` arrays — do not create `plan-history.json`.

3. **Rewrite `PlanService`** in
   [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts):
   - Replace `planPath` + `historyPath` with a single `docPath`.
   - Replace `plan: Plan | null` + `history: PlanHistory` cache with
     `doc: PlanDocument | null`.
   - `init()` reads the combined doc with `readDocOrNull`; if absent,
     leave `doc = null` so `plan_init` is required.
   - `plan_get` returns the projected `{ updated_at, current_stage_id,
     stages }` slice; `plan_get_history` returns
     `{ stages: history.slice(-lastN) }`. Tool response shapes are
     preserved at the MCP boundary.
   - `plan_complete_stage` builds `nextDoc` (one structuredClone),
     splices stage from `nextDoc.stages`, pushes `completedStage` to
     `nextDoc.history`, calls `writeDoc(this.docPath, nextDoc,
     PlanDocumentSchema)` once, then sets `this.doc = nextDoc`. Remove
     the acknowledging comment block at
     [#L248-L253](../../../../src/mcp/plan-server.ts#L248-L253).
   - `plan_commit` commits a single file path.

4. **Update non-PlanService readers** to consult the combined doc
   (`PlanDocumentSchema`) and project locally:
   - [src/server/server.ts](../../../../src/server/server.ts#L144-L145),
     [#L176](../../../../src/server/server.ts#L176),
     [#L480-L481](../../../../src/server/server.ts#L480-L481),
     [#L515](../../../../src/server/server.ts#L515),
     [#L609](../../../../src/server/server.ts#L609) — one read per
     handler; preserve existing HTTP response shapes.
   - [src/agents/handoff.ts](../../../../src/agents/handoff.ts#L22-L23)
     — single read; project `plan` and `history` from the combined
     doc.
   - [src/agents/chat.ts](../../../../src/agents/chat.ts#L282-L336)
     — same.
   - [src/runtime/shutdown-handoff.ts](../../../../src/runtime/shutdown-handoff.ts#L39-L40)
     — single read; drop the second `readOptionalDoc`.
   - [src/server/cli.ts](../../../../src/server/cli.ts#L122) — read
     combined doc.

5. **Update `roster.ts` write territory**: shrink to
   `[".saivage/plan.json"]` at
   [src/agents/roster.ts](../../../../src/agents/roster.ts#L50).

6. **Update tests** to drop the `planHistory` path and to write
   combined docs where they previously wrote separate files:
   - [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L83-L84)
   - [src/runtime/shutdown-handoff.test.ts](../../../../src/runtime/shutdown-handoff.test.ts#L46-L100)
   - [src/agents/chat.lifecycle.test.ts](../../../../src/agents/chat.lifecycle.test.ts#L79-L80)
   - [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L586-L587)
   - [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts#L57-L58)
   - [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L46-L47)
   - [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts#L209-L210)
     — assertion becomes "creating a memory does not mutate
     `plan.json` history field".
   - [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L123)
     — adjust any reference to `plan-history.json`.
   - [src/store/documents.test.ts](../../../../src/store/documents.test.ts#L374-L397)
     — if the test exercised both `plan.json` and `plan-history.json`
     atomicity independently, condense to one document.

7. **Add a plan-server test for atomicity**: assert that after
   `plan_complete_stage` resolves, both `stages` and `history` on the
   combined doc reflect the move; and that a forced `writeDoc` failure
   (mocked) leaves the cache and disk in the pre-call state.

8. **Sweep for stale references** to `plan-history.json` and to the
   removed schema names:

   ```bash
   rg -n 'plan-history\.json|planHistory|PlanHistorySchema|PlanHistory\b|\bPlan\b' \
     --type ts src/ web/src/
   ```

   Reconcile each hit — either rewrite to the new shape or delete
   dead code.

## Validation

Run in order from `/home/salva/g/ml/saivage`:

```bash
npx tsc --noEmit
npx vitest run src/mcp/plan-server.test.ts src/runtime/shutdown-handoff.test.ts src/store/documents.test.ts src/agents/handoff.test.ts
npx vitest run
npm run build
rg -n 'plan-history\.json|planHistory|PlanHistorySchema' src/ web/src/
```

- The first three commands must pass cleanly.
- `npm run build` must produce `dist/cli.js` (bundled with
  [tsup.config.ts](../../../../tsup.config.ts)) without warnings about
  removed exports.
- The final `rg` sweep must return zero hits in `src/` and `web/src/`.

## Rollback (operator-gated)

If validation fails or a runtime regression appears after deploy:

1. Stop the change at the git layer with a single `git revert <merge
   sha>` on the feature branch — do not hand-edit reverted code.
2. Rebuild and redeploy the three live daemons (each bind-mounts
   `/home/salva/g/ml/saivage`):
   - `saivage` at 10.0.3.111 — `systemctl restart saivage.service`,
   - `diedrico` at 10.0.3.113 — `systemctl restart saivage.service`,
   - `saivage-v3` at 10.0.3.112 — `systemctl restart saivage.service`.
3. After revert, the on-disk combined `plan.json` from any deployment
   that ran the new code must be split back into the legacy two-file
   layout before restart. Operator-only step — do not script this in
   the repo (architecture-first: no migration shims either way). Ask
   the operator to confirm before executing.

## Cross-finding coordination

- **G27 (`started_at` bug — same handler)**: G27 changes where the
  `started_at` value comes from. After G28 lands, G27 still mutates
  `plan_complete_stage`, but only by sourcing one field. No file
  shape conflict. Land G28 first because G27 touches the same lines
  but is a smaller diff; if G27 lands first, expect a trivial
  conflict in the `completedStage` builder.
- **G29 (over-serialisation)**: G29 changes the op queue to allow
  read tools to bypass `serializeOp`. G28 leaves the queue untouched
  but removes the cross-doc write window, which makes G29's
  read-bypass safer (one writeDoc call, narrower window). Land G28
  first.
- **F34 (round-1 plan-server cache)**: the design retires the
  acknowledging comment that flagged the cross-doc gap as out of
  scope for F34. Reference F34 in the commit message so the F34
  follow-up note is closed.

## Live deployment coordination

The three live daemons keep real plan + plan-history state on disk
inside their respective project trees. The change drops
`plan-history.json` from the schema and the seed path.

- Before deploy: ask the operator for a maintenance window. For each
  deployment, stop the service, take a backup of `.saivage/plan.json`
  and `.saivage/plan-history.json`, and merge them by hand into a
  single `plan.json` with the new `history` array. This is an
  operator-driven one-shot — do not commit a migration script.
- After deploy: restart the services and confirm `/api/plan` returns
  the expected stages and `/api/plan-history` returns the expected
  completions for each deployment.
- If any deployment cannot be paused for the merge, defer the
  rollout for that host and keep it on the prior commit.
