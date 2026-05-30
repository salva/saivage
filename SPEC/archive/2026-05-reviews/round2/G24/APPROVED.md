# G24 — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r2.md](02-design-r2.md)) — narrow the resolver input to a `ProjectRoutingInput` type derived from `ProjectConfig` (so the `project.routing` field is already statically known to satisfy the schema by the time it reaches the resolver), cache the routing reference once in the constructor as `this.routing`, and delete both redundant `projectRoutingSchema.parse(project.routing)` calls plus the now-obsolete `ProjectRoutingConfigLike` alias. The sole sanctioned `projectRoutingSchema.parse` call left in the tree is the one inside the resolver test helper (treated as an explicit test-only gate). Proposal B (single parse without input narrowing) is rejected because it keeps the unsafe `ProjectRoutingConfigLike` shim and merely deduplicates one of the two parse sites.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md). Touches [src/routing/resolver.ts](../../../../src/routing/resolver.ts) and [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts). Production grep gate: zero `projectRoutingSchema.parse` hits outside the resolver test helper. Test grep gate: exactly one helper-scoped parse remains.

**Sequencing**: Coordinate with G23, G25, and G26 because they all touch [src/routing/resolver.ts](../../../../src/routing/resolver.ts). Implement the resolver findings in one tightly sequenced batch.

**Daemon impact**: None observable; behaviour is preserved for any input that already passes `ProjectConfig` schema validation upstream. Any saivage-v3 restart remains operator-gated.
