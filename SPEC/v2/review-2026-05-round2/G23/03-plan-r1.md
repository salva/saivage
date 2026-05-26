# G23 — Plan (round 1)

**Analysis:** [01-analysis-r1.md](01-analysis-r1.md)
**Design:** [02-design-r1.md](02-design-r1.md) — Proposal A.

## Files touched

- [src/routing/resolver.ts](../../../../src/routing/resolver.ts) — new class, new private method, deleted `seen` set.
- [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts) — two new test cases.

No other files. No edits to bootstrap, no edits to validators, no edits to web/.

## Step-by-step

### Step 1 — Add `RoutingProfileCycleError`

In [src/routing/resolver.ts](../../../../src/routing/resolver.ts), after the `MissingModelForRoleError` import (line 3) and before the public schemas (around line 13), add:

```ts
export class RoutingProfileCycleError extends Error {
  readonly cycle: string[];
  readonly configPath: string;
  constructor(cycle: string[], configPathStr: string) {
    super(
      `Routing profile cycle detected: ${cycle.join(" -> ")}. ` +
        `Fix the "profile" chain in ${configPathStr}.`,
    );
    this.name = "RoutingProfileCycleError";
    this.cycle = cycle;
    this.configPath = configPathStr;
  }
}
```

### Step 2 — Add `validateProfileGraph` and invoke from the constructor

In `ModelRoutingResolver` ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L92-L104)):

1. After `this.defaultProfile = routing?.default_profile;` (currently L103), append:

   ```ts
   this.validateProfileGraph();
   ```

2. Add the private method after `getProviderAccount` (around [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L138)):

   ```ts
   private validateProfileGraph(): void {
     const done = new Set<string>();
     for (const name of Object.keys(this.profiles)) {
       if (done.has(name)) continue;
       const path: string[] = [];
       const onPath = new Set<string>();
       let cursor: string | undefined = name;
       while (cursor) {
         if (onPath.has(cursor)) {
           const start = path.indexOf(cursor);
           throw new RoutingProfileCycleError(
             [...path.slice(start), cursor],
             configPath(),
           );
         }
         if (done.has(cursor)) break;
         onPath.add(cursor);
         path.push(cursor);
         const next: string | undefined = this.profiles[cursor]?.profile;
         cursor = next && this.profiles[next] ? next : undefined;
       }
       for (const visited of path) done.add(visited);
     }
   }
   ```

   Notes:
   - `cursor = next && this.profiles[next] ? next : undefined` makes a dangling reference (`profile: "missing"`) a terminal, not a cycle. That stays out of scope per the analysis.
   - The reported `cycle` array includes the closing edge (e.g. `["A", "B", "A"]`) so operators see the loop.
   - Time complexity: O(N) over `Object.keys(this.profiles)` because `done` prevents re-traversal.

### Step 3 — Remove the lazy `visited` guard from `mergeRuleChain`

Replace the body of `mergeRuleChain` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L173-L204) with:

```ts
private mergeRuleChain(rule: NormalizedRule): NormalizedRule {
  const stack: NormalizedRule[] = [];
  let current: NormalizedRule | undefined = rule;

  while (current) {
    stack.unshift(current);
    const profile: string | undefined = current.profile;
    if (!profile) break;
    current = this.profiles[profile];
  }

  let merged = normalizeRule({});
  for (const item of stack) {
    merged = {
      profile: item.profile ?? merged.profile,
      model: item.model ?? merged.model,
      authProfile: item.authProfile ?? merged.authProfile,
      account: item.account ?? merged.account,
      preferredModels: item.preferredModels.length ? item.preferredModels : merged.preferredModels,
      allowedModels: item.allowedModels ?? merged.allowedModels,
      preferredAccounts: item.preferredAccounts.length ? item.preferredAccounts : merged.preferredAccounts,
      allowedAccounts: item.allowedAccounts ?? merged.allowedAccounts,
    };
  }

  return merged;
}
```

Diff vs current:
- Deleted: `const seen = new Set<string>();` (currently L174).
- Deleted: `if (seen.has(profile)) break;` and `seen.add(profile);` (currently L184-L185).
- The reduction block (today L190-L201) is unchanged.

### Step 4 — Tests

Append two cases to [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts):

1. Direct cycle (A → B → A):

   ```ts
   it("rejects a direct profile cycle at construction time", () => {
     expect(() => new ModelRoutingResolver(
       {
         routing: {
           profiles: {
             A: { profile: "B", preferred_models: ["x/y"] },
             B: { profile: "A" },
           },
           roles: { coder: "A" },
         },
       },
       {},
     )).toThrowError(RoutingProfileCycleError);
   });
   ```

2. Self-loop (A → A):

   ```ts
   it("rejects a profile self-loop at construction time", () => {
     try {
       new ModelRoutingResolver(
         {
           routing: {
             profiles: { A: { profile: "A" } },
             roles: { coder: "A" },
           },
         },
         {},
       );
       throw new Error("expected constructor to throw");
     } catch (err) {
       expect(err).toBeInstanceOf(RoutingProfileCycleError);
       expect((err as RoutingProfileCycleError).cycle).toEqual(["A", "A"]);
     }
   });
   ```

Import `RoutingProfileCycleError` alongside `ModelRoutingResolver` at the top of the test file.

### Step 5 — Confirm no other validation paths are affected

- `validateModelCoverage` ([src/config-validation.ts](../../../../src/config-validation.ts#L41-L72)) calls `routing.resolve(role)` inside `try { } catch { missing.push(role) }`. If the resolver throws `RoutingProfileCycleError` from its constructor, `validateModelCoverage` is never reached, so its `catch` cannot accidentally classify a cycle as a "missing model". Verified by reading [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L137) — the resolver is constructed before `validateModelCoverage`.
- No other call site builds a `ModelRoutingResolver` in production code; tests build many resolvers but none with cyclic profiles.

## Validation (project-rule order)

Run from `/home/salva/g/ml/saivage`:

```bash
npm run tsc -- --noEmit                    # type check
npm run lint                                # eslint
npx vitest run src/routing/resolver.test.ts # focused
npx vitest run                              # full
npm run build                               # tsup bundle
```

Expected:
- tsc: 0 errors.
- lint: 0 new warnings.
- focused vitest: the two new cases pass; existing five cases still pass.
- full vitest: all existing suites pass; in particular [src/config-validation.test.ts](../../../../src/config-validation.test.ts) is unaffected because its fixtures contain no profile cycles.
- build: `dist/cli.js` produced.

## Rollout

- No data-format change, no on-disk migration, no schema bump.
- No restart of any deployed Saivage instance is needed by the patch itself. If an operator wants the `saivage-v3` harness to start using the new build, they should:
  - rebuild on the host: `npm run build` inside `/home/salva/g/ml/saivage`,
  - ask the operator (operator-gated, per workspace rules) to restart `saivage.service` in the `saivage-v3` container at 10.0.3.112.
  - Do not perform that restart from this change set.
- The `saivage-v3-getrich-v2` container at 10.0.3.170 runs Saivage v3 (different binary tree), so this change does not affect it.

## Risks and rollback

- Risk: an existing project in the wild has an unintentional self-loop and will now fail boot. Mitigation: the error message names the cycle precisely so the fix is mechanical. No migration shim, per the workspace rule.
- Risk: graph validation cost on construction. Mitigation: profile counts are O(10) in practice; the algorithm is linear over the map with a `done` set. Negligible compared to the rest of bootstrap I/O.
- Rollback: revert the single PR. No persisted state changed.

## Out of scope (do not touch in this PR)

- G24 (redundant Zod parse in `resolveRoleRule` / constructor): not approved; leave `projectRoutingSchema.parse(this.project.routing)` calls at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L99) and [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L147) untouched.
- G25 (fail-open `allowed_models`): not approved; leave `resolvePreferredModels` ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L201-L217)) untouched.
- G26 (legacy source tier): not approved; leave `resolveSource` ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L252-L257)) untouched.
- Dangling-reference validation (a `profile: "missing"` that points at a non-existent entry): treated as a terminal node; a separate finding can cover this.
- `RoutingTrace` / chat-UI surface: belongs to F12 (round 1), not approved; do not introduce.
