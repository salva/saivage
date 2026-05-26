# G46 — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r4.md](02-design-r4.md)) — decompose web/src/components/AgentsView.vue (~1,492 lines) into a coordinator plus 5 leaf components under web/src/components/agents/, with 3 composables, a pure timeline transformer (unit-tested), and a `web/src/components/agents/constants.ts` module for previously-hardcoded UI tunables. Reuses G41's `PlanStage`/`AgentRole`/`AgentState` types from `web/src/api/types.ts` (no duplication). Replaces the regex/prefix-check round-id parser with a strict deterministic byte-level decimal scanner exported from `round-id.ts`; every consumer (bucket classifier, pending-round inference, sort tiebreaker, compacted-bucket classification) goes through `parseRoundId(id).kind` / `roundIdSortKey`. Entries without `toolUseId` are warned + dropped (no heuristic matching). Proposal B (Pinia store) and Proposal C (layout-only split) rejected.

**Approved by**: GPT-5.5 (copilot) reviewer at round 4 — see [04-review-r4.md](04-review-r4.md). All four rounds of blockers resolved: r1 framed decomposition; r2 added strict round-id parser + threadBody ownership + root-vitest validation; r3 fixed the SFC line-cap contradiction (flat ≤300 lines, CSS-extraction fallback at >300, no slack) and wired strict parsing into compacted timeline classification (replacing `startsWith("r-compacted-")`); r4 broadened the round-id consumer audit to a 10-arm `rg -F` literal-pattern set catching anchored forms like `/^r(\d+)$/`.

**Implementation pointer**: [03-plan-r4.md](03-plan-r4.md). Sequencing: depends on G41 (web type cleanup) landing first.

**Daemon impact**: Web-only; rebuild + restart `saivage` (10.0.3.111), `saivage-v3` (10.0.3.112), `diedrico` (10.0.3.113) operator-gated.
