# G23 — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r2.md](02-design-r2.md)) — perform eager DFS profile-cycle validation inside the `ModelRoutingResolver` constructor. A typed `RoutingProfileCycleError` carries the offending profile name and the full cycle segment; any direct self-loop, transitive cycle, or unused-transitive cycle (a cycle reachable only through profiles that no rule references) is rejected synchronously. The dead `seen` parameter and dead-set plumbing inside `mergeRuleChain` ([src/routing/resolver.ts](../../../../src/routing/resolver.ts)) is removed because cycle detection now happens once at construction time, not lazily per merge call. Proposal B (lazy detection on merge) is rejected because it lets unused-but-cyclic profile graphs persist undetected and keeps the dead `seen` plumbing.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md). The synchronous constructor throw propagates through `bootstrap(path)` and is caught by the existing CLI `serve` action `try/catch` at [src/server/cli.ts](../../../../src/server/cli.ts#L70-L97), which emits a Fatal error and exits with a non-zero status. Tests cover direct self-loop, two-node cycle, deep cycle, and an unused-transitive cycle regression.

**Sequencing**: Coordinate with G24, G25, and G26 because they all touch [src/routing/resolver.ts](../../../../src/routing/resolver.ts). Implement the resolver findings in one tightly sequenced batch to avoid merge churn.

**Daemon impact**: None observable for valid configs. Invalid configs that previously bootstrapped silently and would have failed later are now rejected at startup with a typed error. Any saivage-v3 restart remains operator-gated.
