# G23 — Design (round 2)

**Analysis:** [01-analysis-r2.md](01-analysis-r2.md)
**R1 design:** [02-design-r1.md](02-design-r1.md)
**R1 review:** [04-review-r1.md](04-review-r1.md) — VERDICT: CHANGES_REQUESTED.

## R2 deltas vs r1

- Rewrote "Where the failure surfaces" to describe the real propagation path (synchronous throw from the constructor inside `bootstrap(path)`, caught by the CLI action's local `try/catch`). Removed the incorrect claim that the bootstrap fatal handlers carry this error.
- Updated the `configPath()` reference to its current location at [src/config.ts](../../../../src/config.ts#L224-L226) with project-root / env resolution at [src/config.ts](../../../../src/config.ts#L200-L218).
- Added an explicit requirement that the test plan must include an unused-transitive-cycle case; that requirement is implemented in [03-plan-r2.md](03-plan-r2.md).
- No change to the proposed shape (Proposal A — eager DFS check in constructor, typed `RoutingProfileCycleError`, delete dead `seen` set). Proposals B and C remain rejected for the same reasons as r1.

## Goal

Make a cyclic `routing.profiles` graph a loud, deterministic boot-time failure. Remove the silent-break code path in `mergeRuleChain`. Keep the change inside [src/routing/resolver.ts](../../../../src/routing/resolver.ts) and its test file, plus one typed-error re-export point if needed.

## Proposal A (recommended) — Eager graph validation in the constructor; remove the lazy `visited` guard

### Shape

1. Add a new error class in [src/routing/resolver.ts](../../../../src/routing/resolver.ts) next to the resolver:

   ```ts
   export class RoutingProfileCycleError extends Error {
     readonly cycle: string[];
     readonly configPath: string;
     constructor(cycle: string[], configPathStr: string) {
       super(
         `Routing profile cycle detected: ${cycle.join(" -> ")}. Fix the "profile" chain in ${configPathStr}.`,
       );
       this.name = "RoutingProfileCycleError";
       this.cycle = cycle;
       this.configPath = configPathStr;
     }
   }
   ```

2. In `ModelRoutingResolver`'s constructor (today at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L93-L103)), after building `this.profiles`, call a private `validateProfileGraph()`. The helper does a DFS over the profile map, recording the active path; when it re-enters a node already on the path it throws `RoutingProfileCycleError` with the cycle segment. Nodes that complete are added to a `done` set to avoid quadratic re-walks; nodes that reference an unknown profile name are silently treated as terminals (out of scope: dangling references).

3. Delete the `seen` set from `mergeRuleChain` ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L173-L189)). The loop becomes an unconditional walk over `this.profiles[current.profile]`. Since the constructor has guaranteed the profile graph is acyclic and every traversed node is either a constructor-validated entry or `undefined`, the loop terminates without a guard. The merge block at L190-L201 is unchanged.

4. The error message uses `configPath()` from [src/config.ts](../../../../src/config.ts#L224-L226). That function consults `SAIVAGE_ROOT` via `saivageDir()` at [src/config.ts](../../../../src/config.ts#L220-L223) and falls back through `resolveProjectRoot()` at [src/config.ts](../../../../src/config.ts#L200-L218). It is already imported by [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L4) and used by the existing `MissingModelForRoleError` site at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L111).

### Where the failure surfaces (corrected for r2)

The resolver is constructed at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L136), before `validateModelCoverage` runs at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L136). The bootstrap fatal handlers at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L705-L734) are installed only later, at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L250), and even when installed they only intercept process-level `uncaughtException` / `unhandledRejection`. They are **not** part of this propagation path.

The real path for a `start` invocation is:

1. `new ModelRoutingResolver(...)` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L136) throws `RoutingProfileCycleError` synchronously.
2. The throw propagates up the `await bootstrap(path)` call inside the CLI `start` action at [src/server/cli.ts](../../../../src/server/cli.ts#L70).
3. The CLI's `try { ... } catch (err) { ... }` at [src/server/cli.ts](../../../../src/server/cli.ts#L70-L95) writes `Fatal: <error.message>` to stderr and sets `process.exitCode = 1`.
4. The `finally` block at [src/server/cli.ts](../../../../src/server/cli.ts#L95-L97) calls `await runtime?.shutdown()`, but `runtime` is still `undefined` (because `bootstrap` never returned), so no shutdown side effects run, no runtime state is written, no lockfile is released (it was never acquired — lock acquisition is at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L181), well after the resolver constructor).

The `serve` CLI action has the same try/catch shape and exhibits the same behaviour. No bootstrap or CLI code change is required to make this work; this is purely the existing error path that `MissingModelForRoleError` already rides on (it is thrown by `validateModelCoverage` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L136) and lands in the same CLI catch).

Existing unit tests that build the resolver directly ([src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L140) and [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L40-L130)) keep working because none of them define cyclic profiles; the new validation is a no-op for valid configs.

### Behavioural invariants

- For any valid (acyclic) profile graph, every public method (`resolve`, `getProviderConfig`, `getProviderAccount`) returns exactly what it returns today.
- For any cyclic graph — including subgraphs that no role currently references — the constructor throws; nothing observable (no `resolve()` call, no `validateModelCoverage` run, no MCP startup, no lockfile) happens after.
- The cycle is reported as a `->`-joined path so operators can pinpoint the offending entries.

### Required test coverage (tightened for r2)

The plan must include all three of the following, because each one pins a distinct property of Proposal A:

1. **Direct cycle referenced by a role** (A → B → A, `roles.coder = "A"`): asserts the constructor throws and `err.cycle` contains the loop.
2. **Self-loop referenced by a role** (A → A, `roles.coder = "A"`): asserts the constructor throws with `err.cycle = ["A", "A"]`.
3. **Unused transitive cycle** (A → B → C → B, with `roles` pointing at a fourth, acyclic profile or omitted entirely, and no `default_profile`): asserts the constructor throws with `err.cycle = ["B", "C", "B"]`. This is the case that the existing role-iterating validator at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L70) cannot catch, and the only case that distinguishes Proposal A from Proposal B. Required by the r1 review.

### Module boundaries

| Module | Change | Reason |
| --- | --- | --- |
| [src/routing/resolver.ts](../../../../src/routing/resolver.ts) | Add `RoutingProfileCycleError`, add `validateProfileGraph()` private method called from constructor, delete `seen` set in `mergeRuleChain`. | Whole feature lives here; cycle is a property of the profile map only. |
| [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts) | Add three new test cases (direct cycle, self-loop, unused transitive cycle). | Coverage of new behaviour plus the architectural-property regression. |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) | No change. The new error propagates synchronously and is caught by the CLI. | Architecture-first: no new layer. |
| [src/server/cli.ts](../../../../src/server/cli.ts) | No change. Existing `try/catch` already handles synchronous throws from `bootstrap(...)`. | Same as above. |
| [src/index.ts](../../../../src/index.ts) | Possibly export `RoutingProfileCycleError` only if a future consumer wants to typecheck against it; not in r2 scope. | Avoid scope creep. |

### Why this passes the layering and dead-code rules

- The `seen` set in `mergeRuleChain` exists only to mask cycles. Once the constructor guarantees acyclic input, that set is dead code and is removed.
- No new caller-visible field (no `RoutingTrace`, no flag on `ResolvedModelRoute`) is introduced. The finding asks for at least a warn; we go one level up and refuse to run with a broken config, which is strictly stronger and matches how `MissingModelForRoleError` already behaves at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L111) and [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L284).
- No backward-compat shim: configs in the wild that contain cycles were already silently wrong; they now fail boot with a precise message.

## Proposal B (rejected) — Lazy detection in `mergeRuleChain`, throw on encountering the cycle

Keep the `seen` set, but replace `break` with `throw new RoutingProfileCycleError(...)`. Rejected because:

- The cycle only fires if the cyclic profile is reached by a resolved role. A cycle in unused profiles stays latent until a future config edit re-points a role at it — the bug returns when operators believed they were making an unrelated change. This is exactly the unused-transitive-cycle test case the r1 review demands.
- Validation cost at `resolve()` time pays no dividend: with the constructor check, every `resolve()` becomes simpler (no per-call `Set` allocation, no `seen.has` check).
- Does not remove the dead branch the analysis flagged; defensive code stays inside the hot path.

## Proposal C (rejected) — Surface the cycle through a new `RoutingTrace` returned by `resolve()`

Introduce `RoutingTrace` as a sibling of `ResolvedModelRoute`, embed cycle info, and propagate to the chat UI. Rejected because:

- Overlaps with F12 (routing-trace coverage) from round 1, which is not approved. Adopting `RoutingTrace` here either pre-empts F12 or builds something F12 will replace.
- A cyclic profile graph is an operator-configuration error, not runtime state worth tracing per call. Failing boot is the correct level.
- Caller-signature changes ripple into the chat UI and `validateModelCoverage`, breaking the scope boundary set in the analysis.

## Recommendation

Adopt Proposal A. It is the minimum architectural change that converts a silent bug into a typed, deterministic boot failure caught by the existing CLI error path, removes the dead `seen` set, and stays inside the routing subsystem.
