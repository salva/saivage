# G28 — APPROVED

**Chosen proposal**: Design B (per [02-design-r2.md](02-design-r2.md)) — collapse `plan.json` + `plan-history.json` into a single `PlanDocument` with embedded `history`. Atomicity becomes a property of `writeDoc`. Define `ActivePlanView` / `PlanHistoryView` projection types; `PlanDocumentSchema` invariants enforced via `superRefine`.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All 7 r1 changes addressed.

**Coordinates with**: G27 (must land FIRST — adds `started_at` to active Stage), G29 (reader semantics clarified).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount. Live deploy requires `.saivage/plan.json` + `.saivage/plan-history.json` merge via `jq` per host (file contents must NOT reach agent). `saivage-v3-getrich-v2` unaffected.
