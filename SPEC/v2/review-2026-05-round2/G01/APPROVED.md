# G01 — APPROVED

**Chosen proposal**: Design B (per [02-design-r2.md](02-design-r2.md)) — derive role policy from `ROSTER` via four pure accessors in `src/agents/tool-filters.ts` and roster accessors; delete all hand-rolled parallel tables.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md).

**Subsumes**: G02, G03, G04 (conditional on the consumer-level tests and daemon-rollback coverage attached in [03-plan-r2.md](03-plan-r2.md)).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md). 9 paths total (5 modified prod + 1 new prod + 2 modified tests + 1 new test).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount the saivage source. `saivage-v3-getrich-v2` (10.0.3.170) unaffected.
