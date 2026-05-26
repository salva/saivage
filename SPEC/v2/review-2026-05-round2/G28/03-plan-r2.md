# G28 — Plan r2 (Option B: single `plan.json` with embedded history)

## Steps

1. **Land G27 first**, then start G28. G27 adds `started_at` to the
   active `StageSchema` and changes `plan_set_current` to populate
   it. G28's `PlanDocumentSchema` embeds `StageSchema` by reference,
   so after G27 lands no extra schema work is required. If for any
   reason G28 has to land first, the writer must add the
   `started_at: z.string()` field to `StageSchema` in the same
   commit as a placeholder and flag the change in the commit
   message; G27's plan then becomes a one-line source change for the
   value. The recommended order is G27 → G28 → G29.

2. **Add the new schemas and projection types** in
   [src/types.ts](../../../../src/types.ts):

   ```ts
   export const PlanDocumentSchema = z.object({
     updated_at: z.string(),
     current_stage_id: z.string().nullable(),
     stages: z.array(StageSchema),
     history: z.array(CompletedStageSchema),
   }).superRefine((doc, ctx) => {
     const activeIds = new Set<string>();
     for (const s of doc.stages) {
       if (activeIds.has(s.id)) ctx.addIssue({ code: "custom", message: `Duplicate active stage id '${s.id}'` });
       activeIds.add(s.id);
     }
     const historyIds = new Set<string>();
     for (const s of doc.history) {
       if (historyIds.has(s.id)) ctx.addIssue({ code: "custom", message: `Duplicate history stage id '${s.id}'` });
       historyIds.add(s.id);
       if (activeIds.has(s.id)) ctx.addIssue({ code: "custom", message: `Stage id '${s.id}' appears in both stages and history` });
     }
     if (doc.current_stage_id !== null && !activeIds.has(doc.current_stage_id)) {
       ctx.addIssue({ code: "custom", message: `current_stage_id '${doc.current_stage_id}' is not an active stage` });
     }
   });
   export type PlanDocument = z.infer<typeof PlanDocumentSchema>;
   export type ActivePlanView = Pick<PlanDocument, "updated_at" | "current_stage_id" | "stages">;
   export type PlanHistoryView = { stages: PlanDocument["history"] };
   ```

   Remove the `PlanSchema`, `Plan`, `PlanHistorySchema`,
   `PlanHistory` exports outright. Adjust the section-header
   comments in the file accordingly.

3. **Update the barrel** in
   [src/index.ts](../../../../src/index.ts#L6-L25): drop `Plan` and
   `PlanHistory` from the re-export list; add `PlanDocument`,
   `ActivePlanView`, `PlanHistoryView`.

4. **Drop `paths.planHistory`** in
   [src/store/project.ts](../../../../src/store/project.ts#L30-L74):
   remove the field from the `ProjectContext.paths` type and from
   the `paths` literal in `loadProject`. Update any helper that
   seeds an empty project (search for `plan-history.json` writes
   in `src/store/` and `src/server/`) to seed only a single
   `plan.json` with `{ updated_at, current_stage_id: null, stages:
   [], history: [] }` — never create `.saivage/plan-history.json`.

5. **Rewrite `PlanService`** in
   [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts):
   - Constructor stores `this.docPath = join(projectSaivageDir,
     "plan.json")` and drops `historyPath`.
   - Cache fields collapse to `private doc: PlanDocument | null =
     null`. Delete `this.plan` and `this.history`.
   - `init()` calls `await readDocOrNull(this.docPath,
     PlanDocumentSchema)`. The Zod parse failure (malformed JSON,
     schema mismatch, refinement violation) propagates — do not
     swallow it.
   - **Every** mutator builds `nextDoc` via `structuredClone(this.doc)`
     and only then mutates one slice. The full mutator/reader
     rewrite list (matches the pseudocode in `02-design-r2.md`):
     - `plan_init(stages?)` — refuses if `this.doc !== null`. Builds
       `nextDoc` with empty `history`. Writes once. Returns
       `ActivePlanView`.
     - `plan_get()` — refuses if `this.doc === null`. Returns
       `structuredClone({ updated_at, current_stage_id, stages })`.
     - `plan_get_stage(id)` — refuses if `this.doc === null`.
       Searches `this.doc.stages` then `this.doc.history`. Preserves
       the existing `{ ...stage, source: "active" | "history" }`
       return shape.
     - `plan_get_current_stage()` — refuses if `this.doc === null`.
       Returns the active stage matching `this.doc.current_stage_id`
       or `null`.
     - `plan_set_stages(stages, currentStageId)` — refuses if
       `this.doc === null`. Validates each stage and the
       `currentStageId` invariant. Builds `nextDoc = {
       updated_at, current_stage_id, stages, history:
       this.doc.history }`. Writes once. Updates cache.
     - `plan_add_stage(stage)` — refuses if `this.doc === null`.
       Rejects duplicates by checking both `this.doc.stages` and
       `this.doc.history` (enforces the no-overlap invariant).
       Builds `nextDoc` with `stages` pushed and `history` preserved.
       Writes once.
     - `plan_remove_stage(id)` — refuses if `this.doc === null`.
       Removes from `stages`; nulls `current_stage_id` if matched.
       `history` preserved. Writes once.
     - `plan_set_current(id|null)` — refuses if `this.doc === null`.
       Validates membership in `this.doc.stages`. `history`
       preserved. Writes once.
     - `plan_complete_stage(args)` — refuses if `this.doc === null`.
       Builds `completedStage`, splices the active stage out of
       `nextDoc.stages`, pushes onto `nextDoc.history`, nulls
       `current_stage_id` if matched. **Single** `writeDoc` call.
       Updates cache. Calls `archiveStage` (best-effort, unchanged).
       Remove the acknowledging comment block at
       [#L248-L253](../../../../src/mcp/plan-server.ts#L248-L253).
     - `plan_get_history(lastN?)` — refuses if `this.doc === null`.
       Returns `{ stages: this.doc.history.slice(-lastN) }`.
     - `plan_commit(message)` — git-commits exactly `[this.docPath]`.
       Same noop-detection logic.

6. **Update non-PlanService readers** to consult the combined doc
   and project locally with `ActivePlanView` / `PlanHistoryView`:
   - [src/server/server.ts](../../../../src/server/server.ts#L144-L145),
     [#L176](../../../../src/server/server.ts#L176),
     [#L480-L481](../../../../src/server/server.ts#L480-L481),
     [#L515](../../../../src/server/server.ts#L515),
     [#L609](../../../../src/server/server.ts#L609) — one read per
     handler; existing HTTP response shapes preserved.
   - [src/agents/handoff.ts](../../../../src/agents/handoff.ts#L22-L23)
     — single read.
   - [src/agents/chat.ts](../../../../src/agents/chat.ts#L282-L336)
     — single read.
   - [src/runtime/shutdown-handoff.ts](../../../../src/runtime/shutdown-handoff.ts#L39-L40)
     — drop the second `readOptionalDoc`.
   - [src/server/cli.ts](../../../../src/server/cli.ts#L122) — read
     combined doc.

7. **Update `roster.ts` write territory**: shrink to
   `[".saivage/plan.json"]` at
   [src/agents/roster.ts](../../../../src/agents/roster.ts#L50).

8. **Update tests** to drop `paths.planHistory` and to write
   combined docs where they previously wrote separate files:
   - [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L83-L84)
   - [src/runtime/shutdown-handoff.test.ts](../../../../src/runtime/shutdown-handoff.test.ts#L46-L100)
   - [src/agents/chat.lifecycle.test.ts](../../../../src/agents/chat.lifecycle.test.ts#L79-L80)
   - [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L586-L587)
   - [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts#L57-L58)
   - [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L46-L47)
   - [src/agents/conversation-snapshot.test.ts](../../../../src/agents/conversation-snapshot.test.ts#L62)
     — drop the `planHistory` path reference.
   - [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts#L209-L210)
     — assertion becomes "creating a memory does not mutate
     `plan.json`'s `history` field".
   - [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L123)
     — drop any reference to `plan-history.json`.
   - [src/store/documents.test.ts](../../../../src/store/documents.test.ts#L374-L397)
     — if the test exercised both `plan.json` and
     `plan-history.json` atomicity independently, condense to one
     document.

9. **Add plan-server tests for atomicity and invariants.**
   `writeDoc` is imported as an ESM binding by
   [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L7-L12),
   so the test file mocks the module with `vi.mock` and exposes the
   mock so individual tests can make `writeDoc` throw or succeed at
   will:

   ```ts
   // src/mcp/plan-server.test.ts
   import { vi, describe, it, expect, beforeEach } from "vitest";
   import { mkdtemp, readFile, pathExists } from "node:fs/promises";

   vi.mock("../store/documents.js", async (orig) => {
     const actual = await orig<typeof import("../store/documents.js")>();
     return { ...actual, writeDoc: vi.fn(actual.writeDoc) };
   });
   import { writeDoc } from "../store/documents.js";
   const mockedWriteDoc = vi.mocked(writeDoc);

   beforeEach(() => mockedWriteDoc.mockImplementation(async (...args) => {
     // default: delegate to the real implementation (re-imported via vi.importActual).
   }));
   ```

   Required test cases:
   - **Atomicity (failure)** — seed `plan.json` with one active
     stage and one history entry; make `mockedWriteDoc` reject on
     the next call; invoke `plan_complete_stage`; assert the call
     rejects, `this.doc` still has the active stage, and the
     on-disk file is byte-identical to the seed (`readFile` before
     and after).
   - **Atomicity (success)** — invoke `plan_complete_stage`; assert
     exactly **one** `writeDoc` call, on `this.docPath`, with both
     `stages` (minus the completed one) and `history` (plus the
     new entry) in the same payload.
   - **History preservation, per mutator** — for each of
     `plan_set_stages`, `plan_add_stage`, `plan_remove_stage`,
     `plan_set_current`, `plan_init` (when called on a fresh
     project): seed with a non-empty `history`; invoke the mutator;
     assert that the resulting `this.doc.history` and the on-disk
     `history` array are still byte-equal to the seed.
   - **`plan_get_stage` cross-source** — seed with one active and
     one completed stage; assert `plan_get_stage(activeId)` returns
     `source: "active"` and `plan_get_stage(historyId)` returns
     `source: "history"`, both from one file.
   - **No `plan-history.json` on init/seed** — call `plan_init` on a
     fresh temp project; assert `pathExists(join(saivageDir,
     "plan-history.json"))` is `false`. Repeat for whichever
     `seedProject` helper exists.
   - **`plan_commit` writes one path** — assert the recorded
     `gitCommitFn` argv is exactly `[this.docPath]`.
   - **Projection at the HTTP boundary** — integration test (or
     direct call) that hits the `/api/plan` and `/api/plan-history`
     handlers from one in-memory seed and asserts the two response
     bodies project from the same file.
   - **Invariant hard-fail at `init()`** — write a `plan.json`
     containing a stage id present in both `stages` and `history`;
     assert `PlanService.init()` rejects. Same for
     `current_stage_id` not in `stages`.

10. **Update specs and operator docs** so they describe the single
    document:
    - [SPEC/v2/01-DATA-MODEL.md](../../01-DATA-MODEL.md#L97-L102)
      — replace the two-document section with `PlanDocument`.
    - [SPEC/v2/03-PLAN-MCP-SERVICE.md](../../03-PLAN-MCP-SERVICE.md#L7-L40)
      — describe one cache field, one disk path, and the projection
      types.
    - [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md#L237)
      — drop `plan-history.json` from the file inventory.
    - [docs/internals/plan-mcp.md](../../../../docs/internals/plan-mcp.md#L32-L40)
      — same.
    - [docs/internals/on-disk-layout.md](../../../../docs/internals/on-disk-layout.md#L13-L59)
      — remove `plan-history.json`; describe the embedded `history`
      array. Generated TypeDoc tree `docs/api/` is rebuilt by
      `npm run docs` on the next pass; no manual edits.

11. **Sweep for stale references** to `plan-history.json` and the
    removed schema names across source, tests, specs, and docs:

    ```bash
    cd /home/salva/g/ml/saivage
    rg -n 'plan-history\.json|planHistory|PlanHistorySchema|\bPlanHistory\b|\bPlanSchema\b|\bPlan\b' \
      src/ web/src/ SPEC/v2/ docs/internals/ docs/api/
    ```

    Reconcile each hit — rewrite to the new shape or delete dead
    code. The `\bPlan\b` token is included to catch leftover
    `: Plan` annotations; expect false positives for words like
    "plan_get" (regex word boundary protects against this).

## Validation

Run in order from `/home/salva/g/ml/saivage`:

```bash
npx tsc --noEmit
npx vitest run src/mcp/plan-server.test.ts src/runtime/shutdown-handoff.test.ts src/store/documents.test.ts src/agents/handoff.test.ts
npx vitest run
npm run build
rg -n 'plan-history\.json|planHistory|PlanHistorySchema|\bPlanHistory\b' src/ web/src/ SPEC/v2/ docs/internals/
```

- The first three commands must pass cleanly.
- `npm run build` must produce `dist/cli.js` (bundled via
  [tsup.config.ts](../../../../tsup.config.ts)) without warnings
  about removed exports.
- The final `rg` sweep must return zero hits in `src/`, `web/src/`,
  `SPEC/v2/`, and `docs/internals/`.

## Rollback (operator-gated)

If validation fails or a runtime regression appears after deploy:

1. Stop the change at the git layer with a single `git revert <merge
   sha>` on the feature branch — do not hand-edit reverted code.
2. Rebuild and redeploy the three live daemons (each bind-mounts
   `/home/salva/g/ml/saivage`):
   - `saivage` 10.0.3.111 — `ssh root@10.0.3.111 systemctl restart saivage.service`,
   - `diedrico` 10.0.3.113 — `ssh root@10.0.3.113 systemctl restart saivage.service`,
   - `saivage-v3` 10.0.3.112 — `ssh root@10.0.3.112 systemctl restart saivage.service`.
3. After revert, any deployment that ran the new code has a combined
   `.saivage/plan.json` on disk. The legacy build expects two files,
   so the operator must split the combined doc back into
   `plan.json` (with only `updated_at`, `current_stage_id`,
   `stages`) and `plan-history.json` (with `{ stages: history }`)
   before restart. Operator-only step — do not script in the repo.
   Ask the operator to confirm before executing.

## Cross-finding coordination

- **G27 (`started_at` bug — same handler)** — preferred landing
  order: **G27 first**, so G28's `PlanDocumentSchema` embeds the
  updated `StageSchema` directly. If G28 has to land first, add
  `started_at: z.string()` to `StageSchema` in the G28 commit as a
  placeholder and call it out in the commit message; G27 then only
  changes where the value is sourced. Either way, no file-shape
  conflict.
- **G29 (over-serialisation)** — G29 changes the op queue to allow
  read tools to bypass `serializeOp`. G28 leaves the queue untouched
  but removes the cross-doc write window, so once G29 lands the
  bypassed reads still see a single atomically-renamed file. G28
  lands before G29. The G29 plan should be re-read to confirm
  nothing in G29 depends on the old two-cache split.
- **F34 (round-1 plan-server cache)** — the design retires the
  acknowledging comment that flagged the cross-doc gap as out of
  scope for F34. Reference F34 in the commit message so the
  follow-up note is closed.

## Live deployment coordination

Three live daemons keep real plan + plan-history state on disk
inside their respective project trees. `saivage-v3-getrich-v2`
10.0.3.170 runs a different code path and **must not** be touched as
part of this rollout. For each of the three in-scope hosts, in
order, with operator approval:

### Per-host steps

For each `(host_ip, project_path)` in:

- `(10.0.3.111, /home/salva/g/ml/getrich)` — `saivage` container,
  service `saivage.service`.
- `(10.0.3.113, /work/diedrico)` — `diedrico` container, service
  `saivage.service`.
- `(10.0.3.112, /work/saivage-v3)` — `saivage-v3` container, service
  `saivage.service`.

1. **Stop the service.**

   ```bash
   ssh root@<host_ip> systemctl stop saivage.service
   ssh root@<host_ip> systemctl is-active saivage.service   # expect "inactive"
   ```

2. **Back up the two existing files** to a timestamped
   workspace-local path inside the host's project tree (not printed,
   not copied off-host):

   ```bash
   ssh root@<host_ip> "cd <project_path>/.saivage && \
     ts=\$(date -u +%Y%m%dT%H%M%SZ) && \
     mkdir -p backups/g28-\$ts && \
     cp -a plan.json backups/g28-\$ts/plan.json && \
     cp -a plan-history.json backups/g28-\$ts/plan-history.json && \
     ls -l backups/g28-\$ts"
   ```

   Do **not** `cat` either file. Do not pipe their contents through
   the agent. The backup directory stays on the host.

3. **Merge into the new single shape** in place on the host using
   `jq` so the agent never sees the file contents. The merge keeps
   the existing `updated_at`, `current_stage_id`, and `stages` from
   `plan.json` and copies the `stages` array from
   `plan-history.json` into the new `history` field:

   ```bash
   ssh root@<host_ip> "cd <project_path>/.saivage && \
     jq -s '{updated_at: .[0].updated_at, current_stage_id: .[0].current_stage_id, stages: .[0].stages, history: .[1].stages}' \
       plan.json plan-history.json > plan.json.merged && \
     mv plan.json.merged plan.json && \
     rm plan-history.json"
   ```

   If either source file was absent (fresh project), substitute the
   missing input with `<(echo '{\"stages\":[]}')` rather than
   inventing data — but in practice all three hosts have both
   files.

4. **Validate the merged doc parses against `PlanDocumentSchema`**
   before restart. Use the freshly built `dist/cli.js` from the
   bind-mounted source tree (the same one the service will use):

   ```bash
   ssh root@<host_ip> "cd <project_path> && \
     node -e \"const fs=require('fs');const z=require('/home/salva/g/ml/saivage/dist/types.js');const doc=JSON.parse(fs.readFileSync('.saivage/plan.json','utf-8'));z.PlanDocumentSchema.parse(doc);console.log('OK');\""
   ```

   (Adjust the `require()` path to whatever the built bundle
   exposes; if `dist/types.js` is not a separate entry, point at
   `dist/cli.js` and use the exported schema.) The check must print
   `OK`. If it fails, restore from `backups/g28-<ts>/` and stop the
   rollout for that host.

5. **Restart the service.**

   ```bash
   ssh root@<host_ip> systemctl start saivage.service
   ssh root@<host_ip> systemctl is-active saivage.service   # expect "active"
   ```

6. **Verify both projections from one file.**

   ```bash
   curl -fsS http://<host_ip>:8080/api/plan        | jq '.stages | length, .current_stage_id'
   curl -fsS http://<host_ip>:8080/api/plan-history | jq '.stages | length'
   ```

   Compare the lengths to the backup files; values must match the
   pre-merge counts. Sample one stage id from each endpoint and
   confirm it is present in the merged `plan.json` on disk (via the
   operator, not by piping content through the agent).

7. **Mark the host complete.** Move to the next host only after the
   current one passes step 6.

### Explicit out-of-scope host

`saivage-v3-getrich-v2` 10.0.3.170 runs the Saivage v3 deployment
working on GetRich v2 and does not use this code path. Do **not**
stop, back up, merge, or restart anything on that host as part of
G28. The `/api/plan` shape on 10.0.3.170 is governed by a different
service and is out of scope for this finding.

### Abort criteria

If any host fails step 4 (`PlanDocumentSchema.parse` rejects) or
step 6 (response length mismatch), defer the rollout for that host,
restore `.saivage/plan.json` from the backup directory, and re-open
the finding before touching the next host.
