# G23 — Analysis (round 2)

**Finding:** [../G23-resolver-silent-profile-cycle.md](../G23-resolver-silent-profile-cycle.md)
**R1 analysis:** [01-analysis-r1.md](01-analysis-r1.md)
**R1 review:** [04-review-r1.md](04-review-r1.md) — VERDICT: CHANGES_REQUESTED.
**Subsystem:** routing — single file [src/routing/resolver.ts](../../../../src/routing/resolver.ts).

## R2 deltas vs r1

This round does not change the finding or the proposal direction. It corrects the description of the failure propagation path and tightens the test contract so the architectural property (constructor-time graph validation) is exercised by a case that the existing role-driven validator cannot catch.

- **Failure surface (r1 review change 1).** The r1 analysis correctly named the constructor site at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L136) but the r1 design implied the cycle error would land on the fatal-handler path. It will not: at constructor time the fatal handlers do not exist yet. R2 records the real propagation path here so the design and plan can describe it accurately.
- **Architectural-property test (r1 review change 2).** R1 listed only role-referenced cycles in tests. R2 makes the unused-transitive-cycle test a required regression because that is the only case that distinguishes constructor-time graph validation from the existing role-iterating validator.
- **Stale line reference (r1 review note).** R2 records the current line ranges for `configPath()` and its project-root/env resolution. The design and plan follow this.

## What the finding still claims (unchanged from r1)

`ModelRoutingResolver.mergeRuleChain` walks the `extends`-style chain of routing profiles using a `visited` set and silently stops the walk when it re-encounters a profile. No log, no thrown error, no diagnostic in the returned route. A misconfigured `profiles.json` with a cycle therefore produces a deterministic but wrong route, and operators have no signal that their config is broken.

## Confirmed in source (refreshed)

- The chain walk and the silent `break`: [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L173-L189).
  - Lines L175-L186 hold the `while (current)` loop; the cycle exit is `if (seen.has(profile)) break;` at L184.
  - Once the loop breaks, the partial `stack` is merged top-down at L190-L201 and returned at L203. No record of the cycle is kept on the resolver, on the route, or in any log.
- The caller path: [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L106-L131) calls `mergeRuleChain` from `resolve()` and packages the result into a `ResolvedModelRoute`. The route shape ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L65-L77)) has no field that could carry a diagnostic even if `mergeRuleChain` wanted to surface one.
- Boot wiring: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L136) constructs the resolver, then [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L136) calls [validateModelCoverage](../../../../src/config-validation.ts#L41-L70), which iterates the required roles and `try`/`catch`-es every `routing.resolve(role)` call. That is the only place that exercises every required role at startup.
- `configPath()` and friends: [src/config.ts](../../../../src/config.ts#L224-L226) is the current location; project-root / env-var resolution is at [src/config.ts](../../../../src/config.ts#L200-L218) (`resolveProjectRoot`) and [src/config.ts](../../../../src/config.ts#L220-L223) (`saivageDir`).
- No `RoutingTrace` exists. Round-1 finding F12 mentioned one as a future direction but it is not in the codebase. Searching `src/` for `RoutingTrace` returns zero hits.

## Real propagation path for a constructor-time throw

The r1 design called the path "the bootstrap fatal-handler path". That is wrong for this error. The fatal handlers in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L705-L734) are installed by `installFatalHandlers(...)` called at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L250). The resolver is constructed earlier, at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L136), so a `throw` from the constructor cannot reach those handlers — they do not exist yet, and even when installed they only cover process-level `uncaughtException` / `unhandledRejection`, not synchronous throws inside `bootstrap()`.

The actual propagation is:

1. `new ModelRoutingResolver(...)` throws `RoutingProfileCycleError` synchronously inside `bootstrap(path)` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L136).
2. The throw propagates up the `await bootstrap(path)` call inside the CLI `start` action at [src/server/cli.ts](../../../../src/server/cli.ts#L70).
3. The CLI's local `try { ... } catch (err) { ... }` at [src/server/cli.ts](../../../../src/server/cli.ts#L70-L95) catches it and writes `Fatal: <message>` to stderr, then sets `process.exitCode = 1`. The `finally` block at [src/server/cli.ts](../../../../src/server/cli.ts#L95-L97) calls `await runtime?.shutdown()` — `runtime` is still `undefined` because `bootstrap` never returned, so `shutdown()` is not invoked. No partial state is written, no lockfile is touched (the lock is acquired later in bootstrap, at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L181)).

This is the right level: the CLI catch prints a precise message ("Routing profile cycle detected: A -> B -> A. Fix the ..."), exits non-zero, and leaves no on-disk side effects from the partially-started run. It is symmetric with how `MissingModelForRoleError` thrown by `validateModelCoverage` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L136) is caught by the same CLI `catch`. The `installFatalHandlers` machinery is irrelevant to this finding and should not be referenced by the design.

For the `serve` action ([src/server/cli.ts](../../../../src/server/cli.ts#L100-L160) range, similar shape) the same constructor throw lands in that action's own `catch` and exits the process. No code change is needed there either.

## Behaviour matrix (current vs intended)

| Scenario | Today | Intended |
| --- | --- | --- |
| `profiles.A.profile = "B"`, `profiles.B.profile = "A"`, role → A | `resolve()` returns a route built from A then B then stops at the second A; route is "valid"; no log. | Resolver refuses to construct, CLI catch prints `Fatal: Routing profile cycle detected: A -> B -> A. ...`, exit code 1. |
| `profiles.A.profile = "A"` (self-loop), referenced by a role | Same silent truncation, route is whatever A defines. | Same loud failure. |
| `profiles.A → profiles.B → profiles.C → profiles.B`, no role and no `default_profile` references A, B, or C | `validateModelCoverage` iterates required roles ([src/config-validation.ts](../../../../src/config-validation.ts#L41-L70)) and never traverses A/B/C; cycle stays latent until a future config edit re-points a role at one of them. | Constructor throws on the unused subgraph at boot. |
| `profiles.A.profile = "missing"` (dangling reference, no cycle) | Loop exits cleanly because `this.profiles["missing"]` is `undefined`. | Out of scope for G23; dangling reference is a separate concern. |

## Why the unused-transitive-cycle test matters

The whole reason Proposal A picks eager constructor-time validation over Proposal B (lazy throw inside `mergeRuleChain`) is that it catches cycles in profile subgraphs that no role currently references — see [02-design-r1.md](02-design-r1.md#L75-L78). The existing validator at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L70) only walks required roles and swallows every exception via the per-role `try`/`catch`, so it cannot distinguish "no cycle anywhere" from "cycle exists but no required role reaches it". A regression test that wires up exactly that case — profiles `A -> B -> C -> B` with `roles.coder` pointing to a fourth profile and no `default_profile` — and asserts the constructor throws `RoutingProfileCycleError` with the cycle segment `["B", "C", "B"]` is what guarantees the architectural property survives future edits.

R1's two tests (direct cycle, self-loop) only cover Proposal B's intersection with Proposal A. They would still pass if someone reverted the constructor check and re-introduced a lazy-throw variant. The transitive-unused-cycle case is the one Proposal B fails by construction.

## Trigger surface and blast radius

- Trigger: any project author who writes a `profiles` map with `extends`/`profile` references and accidentally points two entries at each other (or at themselves), including profiles temporarily orphaned during an in-progress config edit.
- Blast radius (today): every `resolve()` call for any role that lands in the cyclic subgraph. Other roles are unaffected. Provider routing, account selection, and auth profiles all derive from `merged`, so a cycle can also misroute accounts and auth profiles, not just models. Detection effort: zero — the operator only notices when a wrong model answers a chat or a worker run.
- Blast radius (after fix): bootstrap fails fast at the CLI layer with a precise message. No partial runtime is started, no lockfile is left behind.

## Scope boundary vs G24/G25/G26 (unchanged from r1)

- G24 (redundant Zod parse on every `resolve`): independent; do not touch.
- G25 (fail-open `allowed_models`): independent.
- G26 (legacy source tier): independent.

The G23 change stays confined to:

1. profile graph validation in `ModelRoutingResolver`'s constructor,
2. the cycle-related code inside `mergeRuleChain`,
3. one new typed error class,
4. tests for the above, including the unused-transitive-cycle regression.

No changes to caller signatures, no new fields on `ResolvedModelRoute`, no `RoutingTrace`, no changes to [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) or [src/server/cli.ts](../../../../src/server/cli.ts).

## Constraints inherited from the workspace

- Architecture-first, no backward compatibility: delete the silent-break code path; do not gate it behind a flag.
- No migration shims: cycles in existing configs were already producing wrong routes; failing boot is the correct fix.
- Project-local validation only: no telemetry, no graph library; plain DFS over `this.profiles` is sufficient (profile counts are O(10) in practice).

## Resolved questions (carried from r1)

1. Eager constructor-time check, not lazy per-`resolve()` detection.
2. Fail closed on cycle; no best-effort partial walk.
3. Dangling references (`profile: "missing"`) treated as terminal; not a G23 concern.
4. Dedicated `RoutingProfileCycleError` class; do not piggyback on `MissingModelForRoleError`.

## Open questions for the design step

None. R2 design and plan must reflect the corrected propagation path and the new required test case.
