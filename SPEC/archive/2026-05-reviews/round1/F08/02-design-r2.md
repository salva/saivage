# F08 — Design (r2)

## Changes from r1

- Proposal B: replaced every `tracker.setStatus("failed")` with `tracker.setStatus("error")`, matching the existing `RuntimeStateSchema.status` enum `["idle", "running", "suspended", "error"]` in [src/types.ts](src/types.ts#L287-L288) and the actual fatal-handler write in [src/server/bootstrap.ts](src/server/bootstrap.ts#L687-L689).
- Proposal B: removed the speculative "`RuntimeStateSchema` enum extension if not already present" decision — verification against the schema shows `"error"` is already the correct value, so no schema change is needed.
- Proposal B: re-described the bootstrap fatal-handler call site as the existing error-state write rather than a distinct `"failed"` status.

No other content changed. Recommendation remains Proposal A.

---

Two proposals. Both delete the legacy mirror; they differ in how much surrounding runtime-state ownership is restructured.

## Proposal A — Focused delete of the legacy mirror

**Scope (files touched):**

- [src/runtime/recovery.ts](src/runtime/recovery.ts#L297-L315) — collapse `writeRuntimeState` to a single `writeDoc` call; delete `legacyRuntimeStatePath` helper.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1026-L1043) — delete the `"writeRuntimeState mirrors the compatibility runtime-state path"` test case.
- [src/agents/planner.ts](src/agents/planner.ts#L47) — shorten the bullet to `\`.saivage/tmp/state/runtime.json\` — authoritative live agent status visible on the dashboard.` Drop the trailing "Older artifacts may mention…" clause.

**What gets added:** nothing.

**What gets removed:**

- The second `writeDoc(legacyPath, state, RuntimeStateSchema)` call.
- The `legacyRuntimeStatePath(path)` helper function (7 lines).
- The unit test case asserting the mirror exists (18 lines).
- The compatibility-mirror sentence inside the planner system prompt.
- The `node:path`'s `join` usage inside the helper drops one of two consumers in this file; the import stays (used by `recoverFromCrash`).
- Operationally: the `<saivageDir>/runtime/` directory is no longer created by Saivage. Existing instances retain their orphan file — see Constraint 3 in the analysis.

**Risk:** Minimal. The mirror has zero readers in `src/`. The only behavioural change visible to an external observer is that the second file stops updating; since nobody reads it, nobody notices.

- Test-suite impact is one deleted case; no other test in `src/` reads the mirror path.
- Web UI is unaffected: `/api/status` reads `paths.runtimeState`, not the mirror.
- The hot-path improvement is exactly one fewer `writeDoc` (i.e. two fewer fsyncs) per agent activity tick.

**What it enables:**

- **F22** (sync fs blocks the event loop): halving the per-tick fsync count reduces the symptom severity F22 cites but does not change F22's recommended fix (move `documents.ts` to `fs/promises`). F22 can proceed afterwards without conflict.
- **F18** (system prompt bloat): the planner prompt loses one defensive paragraph, contributing to F18 incrementally without overlapping its scope.

**What it forbids:**

- Reintroducing a second on-disk copy "for backups" without explicit design.
- Adding a transitional "read legacy if primary missing" shim — explicitly forbidden by Constraint 1.

**Recommendation note:** A is the right shape for a "dead-code" / "low severity" finding. The change is localised, easily reviewed, and creates no coupling to F06/F22/F24 plans. The level-up in Proposal B is desirable but belongs to its own ticket because it touches plumbing that other Fxx already plan to rework.

## Proposal B — Consolidate runtime-state ownership in `RuntimeTracker`

**Scope (files touched):**

- [src/runtime/recovery.ts](src/runtime/recovery.ts#L297-L407) — collapse the dual-write (same as A), then:
  - Make `writeRuntimeState` module-private (no `export`).
  - Add `RuntimeTracker.setStatus(status: RuntimeState["status"]): void` so the three direct `writeRuntimeState` calls in bootstrap become tracker method calls. The accepted `status` values are exactly the existing enum `"idle" | "running" | "suspended" | "error"` from [src/types.ts](src/types.ts#L287-L288); no new status is introduced.
  - Add `RuntimeTracker.initialise(): void` that performs the initial state write currently done at [src/server/bootstrap.ts](src/server/bootstrap.ts#L198-L199).
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L25), [src/server/bootstrap.ts](src/server/bootstrap.ts#L199), [src/server/bootstrap.ts](src/server/bootstrap.ts#L235), [src/server/bootstrap.ts](src/server/bootstrap.ts#L687-L689) — remove `writeRuntimeState` from the import list; route the three remaining direct writes through `tracker.initialise()`, `tracker.setStatus("idle")`, and `tracker.setStatus("error")` respectively. The third call replaces the existing fatal-handler error-state write, which already sets `failState.status = "error"`; no `RuntimeStateSchema` change is needed.
- [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1026-L1043) — delete the mirror test (same as A); update any test that imports `writeRuntimeState` directly (lines 46, 1114, 1203, 1246) to use `RuntimeTracker` instead, or expose a test-only helper.
- [src/agents/planner.ts](src/agents/planner.ts#L47) — same one-line trim as in A.

**What gets added:**

- `RuntimeTracker.setStatus(status)` (~6 lines), constrained to the existing `RuntimeState["status"]` union.
- `RuntimeTracker.initialise()` (~4 lines).

**What gets removed:**

- Everything Proposal A removes, plus:
- The `export` keyword on `writeRuntimeState` (now an implementation detail of `RuntimeTracker`).
- Two of the three direct `writeRuntimeState(…)` calls in `bootstrap.ts` (the third — the fatal-handler error-state write — becomes `tracker.setStatus("error")`).
- The three test sites in `runtime.test.ts` that call `writeRuntimeState` directly (lines 1114, 1203, 1246) re-routed through the tracker; if the tests genuinely need to inject a malformed prior state for recovery scenarios, they keep using `writeDoc` directly with the schema.

**Risk:** Medium. The bootstrap-side refactor touches the failure path at [src/server/bootstrap.ts](src/server/bootstrap.ts#L687-L689) — that path runs only after a planner crash, so regression coverage is thin. The `RuntimeTracker.freeze()` interaction with a new `setStatus("idle")` call must be verified: today the freeze happens before the final `writeRuntimeState` in shutdown ordering ([src/runtime/recovery.ts](src/runtime/recovery.ts#L379-L391)); if `setStatus("idle")` is called after freeze, it would no-op silently, breaking the on-disk record. The fatal-handler path similarly calls `tracker.freeze(label)` immediately before the new `tracker.setStatus("error")` call, so the freeze/setStatus ordering contract has to permit (or explicitly exempt) the terminal `"error"` write.

**What it enables:**

- A single ownership invariant ("`RuntimeTracker` is the only writer of runtime state") that **F22** can leverage when converting the document store to `fs/promises`: only one site needs to await the async writes, the tracker's `flush()`.
- Makes **F06**-style auditing easier — a debugger can put a single breakpoint inside `RuntimeTracker` and see every state transition.
- Makes **F24**'s shutdown-handoff rework simpler — any new transition (e.g. a `"shutting_down"` status, if F24 adds one to the schema) becomes a one-line `tracker.setStatus(...)` rather than a fresh `writeRuntimeState` call.

**What it forbids:**

- Bootstrap (or any other caller) writing runtime state outside the tracker. The non-exported `writeRuntimeState` enforces this at the import-graph level.
- The "lock file vs state file" timing currently relied upon in [src/server/bootstrap.ts](src/server/bootstrap.ts#L166-L199) (lock acquired, then initial state written) stays the same; the change only relocates the write into a method.

**Recommendation note:** B is a real improvement but it expands the patch from ~30 lines to ~120 lines and overlaps the conceptual surface of F22 and F24, increasing merge-conflict probability. It is the right second commit, not the right first commit, for the F08 finding.

## Recommendation

**Proposal A.** F08 is explicitly tagged `severity: low`, `category: dead-code`. The right response is the minimum patch that deletes the dead mirror and the assertion holding it in place, and removes the stale apologetic paragraph from the planner prompt. The hot-path fsync halving is a free incidental benefit. The ownership consolidation in B is correct but is a separate concern — write it as a follow-up after F22 lands, when there is a real async-ownership reason to centralise the writer.

A third proposal ("turn the mirror into a symlink to the primary file") was considered and rejected: symlinks are platform-flaky on Windows-without-developer-mode, the planner prompt would still need to explain the path, and the operational complexity is worse than the dead-code it pretends to clean up.
