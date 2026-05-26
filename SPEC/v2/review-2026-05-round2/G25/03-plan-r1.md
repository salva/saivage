# G25 — Plan (round 1, writer Claude Opus 4.7)

Implements Proposal A from [02-design-r1.md](./02-design-r1.md).

## Touched files

- [../../../../src/config-validation.ts](../../../../src/config-validation.ts) — add `NoAllowedRouteMatchError`.
- [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts) — fix `resolvePreferredModels` and `resolvePreferredAccounts`; thread `role` into the accounts method.
- [../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts) — new cases for the failure branches; keep F04 r3 case green.

No other files are modified. No new files beyond this plan/design/analysis. No UI, no docs, no schema files.

## Tasks (sequential)

### Task 1 — Add `NoAllowedRouteMatchError`

Edit [../../../../src/config-validation.ts](../../../../src/config-validation.ts#L11-L20). After the existing `MissingModelForRoleError` class, append:

```ts
export class NoAllowedRouteMatchError extends Error {
  constructor(
    public readonly kind: "model" | "account",
    public readonly role: string,
    public readonly candidates: string[],
    public readonly allowed: string[],
    public readonly configPath: string,
  ) {
    super(
      `No ${kind} in the configured allow-list for role "${role}" matches any candidate. ` +
      `Candidates: [${candidates.join(", ")}]. Allowed: [${allowed.join(", ")}]. ` +
      `Config: ${configPath}`,
    );
    this.name = "NoAllowedRouteMatchError";
  }
}
```

No other change to this file.

### Task 2 — Rewrite `resolvePreferredModels`

Edit [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L1-L4) imports: add `NoAllowedRouteMatchError` to the existing import from `../config-validation.js`.

Replace the body of `resolvePreferredModels` at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L205-L220) with the form shown in [02-design-r1.md](./02-design-r1.md) section "Recommended: Proposal A" item 2:

- Build `candidates` exactly as today.
- Resolve `allowed` to the array (not the `Set`) when configured, else `undefined`.
- Early-return when `allowed` is unset.
- Early-return `unique(allowed)` when `candidates.length === 0` (preserves F04 r3).
- Filter; return filtered when non-empty.
- Throw `NoAllowedRouteMatchError("model", role, candidates, allowed, configPath())` otherwise.

Delete the old line `if (allowed?.size) return [...allowed];` ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L218)).

### Task 3 — Rewrite `resolvePreferredAccounts` and thread `role`

3a. Change the signature at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L223) from
`private resolvePreferredAccounts(provider: string, rule: NormalizedRule): string[]`
to
`private resolvePreferredAccounts(role: string, provider: string, rule: NormalizedRule): string[]`.

3b. Update the single call site inside `resolve()` at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L117):
`const preferredAccounts = parsed ? this.resolvePreferredAccounts(role, provider, merged) : [];`

3c. Replace the body with the form shown in [02-design-r1.md](./02-design-r1.md) section "Recommended: Proposal A" item 3, using `role` (no `rule.profile ?? "<role>"` fallback needed now):

- Honor `rule.authProfile` early-return.
- Build `explicit` and `normalizedDefault` exactly as today.
- Early-return when `allowed` is unset (using `explicit` then `normalizedDefault`).
- Compute `filteredExplicit`; return when non-empty.
- Return `[normalizedDefault]` when it exists and is in the allow-list.
- Build `candidates = unique([...explicit, normalizedDefault])`; if empty, return `unique(allowed)` (the accounts-analogue of the F04 r3 semantic — operator wrote only `allowed_accounts`).
- Otherwise throw `NoAllowedRouteMatchError("account", role, candidates, allowed, configPath())`.

Delete the old final line `return allowed ? [...allowed] : [];` ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L245)) — its semantics are now split across the two new return paths above.

### Task 4 — Tests

Edit [../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts). Add the following cases inside the existing `describe` block (after the F04 r3 case at [../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137)):

1. Models — preferred filtered out by allow-list throws.

   ```ts
   it("throws NoAllowedRouteMatchError when preferred_models is filtered out by allowed_models (G25)", () => {
     const resolver = new ModelRoutingResolver(
       {
         routing: {
           roles: {
             coder: {
               preferred_models: ["github-copilot/claude-sonnet-4.6"],
               allowed_models: ["github-copilot/gpt-5.4"],
             },
           },
         },
       },
       {},
     );
     expect(() => resolver.resolve("coder")).toThrow(NoAllowedRouteMatchError);
   });
   ```

2. Models — `model` filtered out by allow-list throws.

   ```ts
   it("throws NoAllowedRouteMatchError when rule.model is filtered out by allowed_models (G25)", () => {
     const resolver = new ModelRoutingResolver(
       {
         routing: {
           roles: {
             coder: {
               model: "github-copilot/claude-sonnet-4.6",
               allowed_models: ["github-copilot/gpt-5.4"],
             },
           },
         },
       },
       {},
     );
     expect(() => resolver.resolve("coder")).toThrow(NoAllowedRouteMatchError);
   });
   ```

3. Models — intersection non-empty still resolves (regression).

   ```ts
   it("returns the filtered intersection when preferred_models and allowed_models overlap (G25)", () => {
     const resolver = new ModelRoutingResolver(
       {
         routing: {
           roles: {
             coder: {
               preferred_models: ["github-copilot/gpt-5.4", "github-copilot/claude-sonnet-4.6"],
               allowed_models: ["github-copilot/gpt-5.4"],
             },
           },
         },
       },
       {},
     );
     expect(resolver.resolve("coder").preferredModels).toEqual(["github-copilot/gpt-5.4"]);
   });
   ```

4. Accounts — explicit account filtered out by `allowed_accounts` throws.

   ```ts
   it("throws NoAllowedRouteMatchError when account is filtered out by allowed_accounts (G25)", () => {
     const resolver = new ModelRoutingResolver(
       {
         routing: {
           roles: {
             coder: {
               model: "github-copilot/gpt-5.4",
               account: "github-copilot.user-a",
               allowed_accounts: ["github-copilot.user-b"],
             },
           },
         },
       },
       { providers: { "github-copilot": { defaultAccount: "user-c" } } },
     );
     expect(() => resolver.resolve("coder")).toThrow(NoAllowedRouteMatchError);
   });
   ```

5. Accounts — default account in allow-list still resolves (regression).

   ```ts
   it("returns the provider default account when it is in allowed_accounts (G25)", () => {
     const resolver = new ModelRoutingResolver(
       {
         routing: {
           roles: {
             coder: {
               model: "github-copilot/gpt-5.4",
               allowed_accounts: ["github-copilot.user-b"],
             },
           },
         },
       },
       { providers: { "github-copilot": { defaultAccount: "user-b" } } },
     );
     expect(resolver.resolve("coder").preferredAccounts).toEqual(["github-copilot.user-b"]);
   });
   ```

Add `NoAllowedRouteMatchError` to the test file's imports from `../config-validation.js`.

The existing F04 r3 case at [../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137) must remain unmodified and green: it exercises the `candidates.length === 0` branch (only `allowed_models` set), which the new code path preserves verbatim.

### Task 5 — Build and validate

Run from `/home/salva/g/ml/saivage`:

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run src/routing/resolver.test.ts src/config-validation.test.ts
```

Both must pass with no skipped tests. No other suites are touched; full `npx vitest run` is optional and not part of the gating set for G25.

## Out of scope (explicit)

- Cycle detection (G23 owns).
- Removing redundant Zod parse (G24 owns).
- Removing `legacy` source tier (G26 owns).
- Adding `RoutingTrace`, chat-UI surface, or log.warn output.
- Adding an opt-in `fall_back_to_allow_list` policy switch.
- Changing operator-facing routing schema docs.

## Effort

Small, contained edit. Two source files plus tests. No cross-module ripple.

## Backout

`git checkout -- src/routing/resolver.ts src/config-validation.ts src/routing/resolver.test.ts`. No on-disk state or external contract is changed by this plan, so no cleanup steps are required after revert.
