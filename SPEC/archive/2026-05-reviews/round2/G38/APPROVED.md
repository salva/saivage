# G38 — APPROVED

**Chosen proposal**: Design B (per [02-design-r2.md](02-design-r2.md)) — promote the existing `bootstrap()` runtime-lock to a hard contract via `assertRuntimeLockHeld(saivageRoot)` on every public knowledge writer in `lifecycle.ts`. Delete misleading public lock primitives. Replace with private `withChainLock`/`withScopeLifecycleLock`/`withSupersedeLock` helpers built with `prev.catch(()=>{})` (this removes G39's poisonable lock chain).

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All 5 r1 changes addressed.

**Subsumes**: G39 (lock-chain poisoning — `prev.catch(()=>{})` is the canonical fix).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount the saivage source. `saivage-v3-getrich-v2` unaffected.
