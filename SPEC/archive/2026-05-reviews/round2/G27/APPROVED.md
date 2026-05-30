# G27 — APPROVED

**Chosen proposal**: Option A (per [02-design-r2.md](02-design-r2.md)) — add `started_at?: string` to active `StageSchema`; stamp on `plan_set_current`; `plan_set_stages` preserves existing `started_at` by id via `preserveStartedAt` helper. `plan_complete_stage` consumes it and rejects with `VALIDATION_ERROR` if missing — no synthetic value.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All 4 r1 changes addressed.

**Sequencing**: G27 MUST land BEFORE G28. G28's `PlanDocumentSchema` consumes the new active-Stage shape. Rollback regime split: Regime A (pre-G28) = single-commit revert; Regime B (post-G28) = forbids G27-only revert (must roll back G28 first).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount.
