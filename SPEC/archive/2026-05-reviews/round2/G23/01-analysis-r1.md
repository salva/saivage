# G23 — Analysis (round 1)

**Finding:** [../G23-resolver-silent-profile-cycle.md](../G23-resolver-silent-profile-cycle.md)
**Subsystem:** routing — single file [src/routing/resolver.ts](../../../../src/routing/resolver.ts).

## What the finding claims

`ModelRoutingResolver.mergeRuleChain` walks the `extends`-style chain of routing profiles using a `visited` set and silently stops the walk when it re-encounters a profile. No log line, no thrown error, no diagnostic in the returned route. A misconfigured `profiles.json` with a cycle therefore produces a deterministic but wrong route, and operators have no signal that their config is broken.

## Confirmed in source

- The chain walk and the silent `break`: [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L173-L189).
  - Lines L175-L186 hold the `while (current)` loop; the cycle exit is `if (seen.has(profile)) break;` at L184.
  - Once the loop breaks, the partial `stack` is merged top-down at L190-L201 and returned at L203. No record of the cycle is kept on the resolver, on the route, or in any log.
- The caller path: [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L106-L131) calls `mergeRuleChain` from `resolve()` and packages the result into a `ResolvedModelRoute`. The route shape ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L65-L77)) has no field that could carry a diagnostic even if `mergeRuleChain` wanted to surface one.
- Boot wiring: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L137) builds the resolver once, then immediately calls [src/config-validation.ts validateModelCoverage](../../../../src/config-validation.ts#L41-L72), which iterates the required roles and calls `resolver.resolve(role)` per role. That is the only place that exercises every role at startup.
- No `RoutingTrace` exists. Round-1 finding F12 mentioned one as a future direction but it is not in the codebase. Searching `src/` for `RoutingTrace` returns zero hits. The chat UI cannot show a cycle today because there is nothing to render.

## Behaviour matrix (current vs intended)

| Scenario | Today | Intended |
| --- | --- | --- |
| `profiles.A.profile = "B"`, `profiles.B.profile = "A"`, role → A | `resolve()` returns a route built from A then B then stops at the second A; route is "valid"; no log. | Resolver refuses to construct (or `resolve()` throws), with a typed error naming the cycle. Boot fails loudly. |
| `profiles.A.profile = "A"` (self-loop) | Same silent truncation, route is whatever A defines. | Same loud failure. |
| `profiles.A.profile = "missing"` | `this.profiles["missing"]` is `undefined`, loop exits cleanly. Currently NOT a cycle and NOT this finding. | Out of scope for G23 (dangling reference is its own issue; would overlap with G24/G25/G26 — leave it alone). |

## Why the current behaviour is wrong

- Routing decides which provider/model handles every agent call. A silently-truncated chain looks "fine" but routes to the wrong model — exactly the failure mode operators cannot diagnose by reading logs.
- The `seen.has` branch at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L184) is the only defensive code in the resolver that swallows operator misconfiguration instead of surfacing it. Every other failure mode in this file already throws ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L111) and [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L284) both throw `MissingModelForRoleError`).
- Project rule "remove dead code, no migration shims": the `visited` set exists only to mask a bug we should detect at config-load time. If we validate eagerly, the set becomes dead code.

## Trigger surface and blast radius

- Trigger: any project author who writes a `profiles` map with `extends`/`profile` references and accidentally points two entries at each other (or at themselves).
- Blast radius: every `resolve()` call for any role that lands in the cyclic subgraph. Other roles are unaffected. Provider routing, account selection, and auth profiles all derive from `merged`, so a cycle can also misroute accounts and auth profiles, not just models.
- Detection effort today: zero — the operator only notices when a wrong model answers a chat or a worker run.

## Scope boundary vs G24/G25/G26 (not yet approved)

- G24 (redundant Zod parse on every `resolve`): touches `resolveRoleRule` / constructor parse caching. Independent of cycle detection but lives in the same file. We do not pre-empt or refactor that code path.
- G25 (fail-open `allowed_models`): touches `resolvePreferredModels`. Independent.
- G26 (legacy source tier): touches `resolveSource`. Independent.

The G23 change must stay confined to:

1. profile graph validation,
2. the cycle-related code inside `mergeRuleChain`,
3. one new typed error class,
4. tests for the above.

No changes to caller signatures, no new fields on `ResolvedModelRoute`, no `RoutingTrace`, no changes to `bootstrap.ts` other than letting the new typed error propagate.

## Constraints inherited from the workspace

- Architecture-first, no backward compatibility: delete the silent-break code path rather than wrap it in a feature flag.
- No migration shims: if existing configs in the wild contain cycles, they were already producing wrong routes; failing boot is the correct fix.
- Project-local validation only: no telemetry, no fancy graph library; a plain DFS over the in-memory `this.profiles` map is sufficient (profile counts are O(10) in practice).

## Open questions for the design step

1. Eager (constructor-time) cycle check vs lazy (per-`resolve()`) detection.
2. Whether to keep any "best-effort" walking when a cycle is detected (the recommendation is: no — fail closed).
3. Whether to also reject self-loops in role rules that inline `{ profile: "X" }` where X is not in the profile map (answer: no — that is a dangling reference, not a cycle; out of scope).
4. Error type: new `RoutingProfileCycleError` extending `Error`, or piggyback on `MissingModelForRoleError` (answer for design: dedicated class — different failure mode, different remediation).
