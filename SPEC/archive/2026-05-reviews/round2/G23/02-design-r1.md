# G23 — Design (round 1)

**Analysis:** [01-analysis-r1.md](01-analysis-r1.md)

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
         `Routing profile cycle detected: ${cycle.join(" -> ")}. Fix the "profile"/extends chain in ${configPathStr}.`,
       );
       this.name = "RoutingProfileCycleError";
       this.cycle = cycle;
       this.configPath = configPathStr;
     }
   }
   ```

2. In `ModelRoutingResolver` constructor (today at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L93-L103)), after building `this.profiles`, call a private `validateProfileGraph()`. That helper does a DFS over the profile map, recording the active path; when it re-enters a node already on the path it throws `RoutingProfileCycleError(path.slice(pathIdx))`. Nodes that complete are added to a `done` set to avoid quadratic re-walks; nodes that reference an unknown profile name are silently treated as terminals (out of scope: dangling references).

3. Delete the `visited` / `seen` set from `mergeRuleChain` ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L173-L189)). Replace the loop body with the unconditional walk:

   ```ts
   while (current) {
     stack.unshift(current);
     const profile = current.profile;
     if (!profile) break;
     current = this.profiles[profile];
   }
   ```

   Since the constructor has guaranteed no cycles exist among `this.profiles`, and `current` is either a constructor-validated profile entry or `undefined`, the loop terminates without a guard. The merge block at L190-L201 is unchanged.

4. `configPath()` is already imported by the file ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L4)); the constructor uses it to build the error message. The resolver does not currently take a project path, but the existing `configPath()` is project-aware via env var (see [src/config.ts](../../../../src/config.ts#L261-L290) for the loader contract), matching how `MissingModelForRoleError` is constructed today at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L111).

### Where the failure surfaces

- `new ModelRoutingResolver(project.config, runtimeConfig)` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L134) throws before `validateModelCoverage` is called. Bootstrap already lets `MissingModelForRoleError` propagate up to the CLI fatal handler ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L720-L730)); `RoutingProfileCycleError` follows the same path. No new error handling required.
- Unit tests that build the resolver directly ([src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L140) and [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L40-L130)) keep working because none of them define cyclic profiles; the new validation is a no-op for valid configs.

### Behavioural invariants

- For any valid (acyclic) profile graph, every public method (`resolve`, `getProviderConfig`, `getProviderAccount`) returns exactly what it returns today.
- For any cyclic graph, the constructor throws; nothing observable (no `resolve()` call, no `validateModelCoverage` run) happens.
- The cycle is reported as a `->`-joined path so operators can pinpoint the offending entries.

### Module boundaries

| Module | Change | Reason |
| --- | --- | --- |
| [src/routing/resolver.ts](../../../../src/routing/resolver.ts) | Add `RoutingProfileCycleError`, add `validateProfileGraph()` private method called from constructor, delete `seen` set in `mergeRuleChain`. | Whole feature lives here; cycle is a property of the profile map only. |
| [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts) | Add two new test cases (direct cycle, transitive cycle). No existing test changes. | Coverage of new behaviour. |
| [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) | No code change. The new error propagates through the existing path. | Architecture-first: no new layer. |
| [src/index.ts](../../../../src/index.ts) | Possibly export `RoutingProfileCycleError` if other modules want to typecheck against it — only if needed; not in r1 scope. | Avoid scope creep. |

### Why this passes the layering and dead-code rules

- The `visited`/`seen` set in `mergeRuleChain` exists only to mask cycles. Once the constructor guarantees acyclic input, that set is dead code and is removed.
- No new caller-visible field (no `RoutingTrace`, no flag on `ResolvedModelRoute`) is introduced. The finding asks for "at least a warn"; we go one level up and refuse to run with a broken config, which is strictly stronger and matches how `MissingModelForRoleError` already behaves.
- No backward-compat shim: configs in the wild that contain cycles were already silently wrong; they will now fail boot with a precise message.

## Proposal B (rejected) — Lazy detection in `mergeRuleChain`, throw on encountering the cycle

Keep the `seen` set, but replace `break` with `throw new RoutingProfileCycleError(...)`. Rejected because:

- The same cycle would only fire if the cyclic profile is actually referenced by a resolved role. A cycle that lives in unused profiles stays latent until someone re-points a role at it — i.e., the bug returns after a future config edit that operators believed was unrelated.
- The validation cost at `resolve()` time pays no dividend: with the constructor check, every `resolve()` becomes simpler (no per-call `Set` allocation, no `seen.has` check).
- Doesn't remove the dead-code branch the analysis flagged; we'd still be keeping defensive code inside the hot path.

## Proposal C (rejected) — Surface the cycle through a new `RoutingTrace` returned by `resolve()`

Introduce `RoutingTrace` as a sibling of `ResolvedModelRoute`, embed cycle info, and propagate to the chat UI. Rejected because:

- It overlaps with F12 (routing trace coverage) from round 1, which is not approved. Adopting `RoutingTrace` here either pre-empts F12 or builds something that F12 will replace.
- A cyclic profile graph is an operator-configuration error, not runtime state worth tracing per call. Failing boot is the correct level.
- Caller-signature changes ripple into the chat UI and `validateModelCoverage`, breaking the scope boundary set in the analysis (G23 must not touch G24/G25/G26 territory).

## Recommendation

Adopt Proposal A. It is the minimum architectural change that converts a silent bug into a typed, deterministic boot failure, removes the dead `visited` set, and stays inside the routing subsystem.
