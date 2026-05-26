# G23 — Review of round 1

## Findings

1. Medium — The failure-surface description points at the wrong error path.

   [02-design-r1.md](SPEC/v2/review-2026-05-round2/G23/02-design-r1.md#L47-L49) says constructor-time RoutingProfileCycleError follows the same path as MissingModelForRoleError into the bootstrap fatal handler. That is not what the current startup path does. The resolver is constructed before model coverage at [src/server/bootstrap.ts](src/server/bootstrap.ts#L130-L136), while fatal handlers are installed only later at [src/server/bootstrap.ts](src/server/bootstrap.ts#L250) and only cover process-level uncaughtException / unhandledRejection after installation at [src/server/bootstrap.ts](src/server/bootstrap.ts#L705-L734). For the normal start command, a constructor failure from bootstrap(path) is caught by the CLI action's local catch at [src/server/cli.ts](src/server/cli.ts#L70-L95). The proposed implementation can still fail boot correctly, but the design should describe the real propagation path so operators and implementers do not look for runtime-state fatal-handler behavior that will not happen for this pre-runtime configuration error.

2. Medium — The plan does not test the architectural property that justified eager validation.

   Proposal A rejects lazy detection because a cycle in unused profiles would otherwise remain latent until a later role edit, as stated in [02-design-r1.md](SPEC/v2/review-2026-05-round2/G23/02-design-r1.md#L75-L78). The design also asks for direct and transitive cycle coverage at [02-design-r1.md](SPEC/v2/review-2026-05-round2/G23/02-design-r1.md#L62-L63), but the plan only adds a referenced two-node cycle and a referenced self-loop at [03-plan-r1.md](SPEC/v2/review-2026-05-round2/G23/03-plan-r1.md#L120-L158). That misses the key regression: a cyclic profile subgraph that no role or default profile currently resolves. This matters because [config-validation.ts](src/config-validation.ts#L47-L50) exercises only required roles and catches all routing.resolve(role) exceptions, while the planned correctness depends on constructor-time graph validation immediately after profile normalization at [src/routing/resolver.ts](src/routing/resolver.ts#L96-L103), before the per-call guard is deleted from [src/routing/resolver.ts](src/routing/resolver.ts#L173-L183). Add a test for an unused transitive cycle, for example profiles A -> B -> C -> B with roles pointing elsewhere or omitted, and assert the constructor throws RoutingProfileCycleError with the expected cycle segment.

## Notes

- The core remediation direction is right: fail closed in the resolver constructor, remove the silent `seen.has(profile) break` path, and do not introduce a routing trace or migration shim for a broken config.
- The scope boundary is otherwise clean. Keeping the change in [src/routing/resolver.ts](src/routing/resolver.ts) and [src/routing/resolver.test.ts](src/routing/resolver.test.ts) matches the subsystem map and avoids G24/G25/G26 overlap.
- Update the stale `configPath()` line reference in [02-design-r1.md](SPEC/v2/review-2026-05-round2/G23/02-design-r1.md#L45) while revising the design; the current function is at [src/config.ts](src/config.ts#L224-L226), with project-root/env resolution feeding it via [src/config.ts](src/config.ts#L200-L218).

VERDICT: CHANGES_REQUESTED