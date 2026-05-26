# G25 — Plan (round 3, writer Claude Opus 4.7)

Implements Proposal A from [02-design-r3.md](02-design-r3.md). Supersedes [03-plan-r2.md](03-plan-r2.md). The only delta from round 2 is full payload assertions on every `NoAllowedRouteMatchError` failure test (Tasks 5b, 5d, 5e, 6 gain `role` and/or `configPath` checks; Task 5a is already complete; regression cases unchanged).

## Touched files

- [src/config-validation.ts](../../../../src/config-validation.ts) — add `NoAllowedRouteMatchError`; narrow `validateModelCoverage` catch.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts) — rewrite `resolvePreferredModels` and `resolvePreferredAccounts`; thread `role` into the latter.
- [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts) — failure and regression cases for both methods, every failure asserting the full typed payload.
- [src/config-validation.test.ts](../../../../src/config-validation.test.ts) — regression case proving `NoAllowedRouteMatchError` propagates through `validateModelCoverage` verbatim with full payload.

No other files. No UI, docs, schema, or on-disk format changes.

## Sequencing within the resolver batch

Per [01-analysis-r3.md](01-analysis-r3.md) §3 and [G23/APPROVED.md](../G23/APPROVED.md#L9) / [G24/APPROVED.md](../G24/APPROVED.md#L9), apply in the order G23 → G24 → G25 → G26. G26 coordination unchanged from [03-plan-r2.md](03-plan-r2.md): replace `this.resolveLegacyModels(role)` with `this.resolveRuntimeDefaultModels(role)` if G26 lands first.

## Tasks (sequential)

### Task 1 — Add `NoAllowedRouteMatchError`

Unchanged from [03-plan-r2.md](03-plan-r2.md) Task 1. Append the class from [02-design-r3.md](02-design-r3.md) §A.1 after `MissingModelForRoleError` at [src/config-validation.ts](../../../../src/config-validation.ts#L22).

### Task 2 — Narrow `validateModelCoverage`

Unchanged from [03-plan-r2.md](03-plan-r2.md) Task 2. Replace the three bare-catch blocks at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L69) with the typed-filter form from [02-design-r3.md](02-design-r3.md) §A.2.

### Task 3 — Rewrite `resolvePreferredModels`

Unchanged from [03-plan-r2.md](03-plan-r2.md) Task 3.

3a. Imports at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L3): change
`import { MissingModelForRoleError } from "../config-validation.js";`
to
`import { MissingModelForRoleError, NoAllowedRouteMatchError } from "../config-validation.js";`.

3b. Replace the body at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219) with the form in [02-design-r3.md](02-design-r3.md) §A.3. Delete `if (allowed?.size) return [...allowed];` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L218).

### Task 4 — Rewrite `resolvePreferredAccounts` and thread `role`

Unchanged from [03-plan-r2.md](03-plan-r2.md) Task 4.

4a. Signature at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222) becomes
`private resolvePreferredAccounts(role: string, provider: string, rule: NormalizedRule): string[]`.

4b. Call site at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L117) becomes
`const preferredAccounts = parsed ? this.resolvePreferredAccounts(role, provider, merged) : [];`.

4c. Replace the body at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222-L244) with the form in [02-design-r3.md](02-design-r3.md) §A.4. Delete `return allowed ? [...allowed] : [];` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L244).

### Task 5 — Resolver tests (payload-asserting, both methods)

Edit [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts). Update the import at [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L2):

```ts
import { ModelRoutingResolver } from "./resolver.js";
import { NoAllowedRouteMatchError } from "../config-validation.js";
```

Add the following cases after the F04 r3 case at [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137). Every failure case asserts the full typed payload per the table in [02-design-r3.md](02-design-r3.md) §A.5; regression cases assert the resolved array.

5a. Model — preferred filtered out (case A; asserts kind, role, candidates, allowed, configPath):

```ts
it("throws NoAllowedRouteMatchError with full payload when preferred_models is filtered out (G25)", () => {
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
  try {
    resolver.resolve("coder");
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
    const e = err as NoAllowedRouteMatchError;
    expect(e.kind).toBe("model");
    expect(e.role).toBe("coder");
    expect(e.candidates).toEqual(["github-copilot/claude-sonnet-4.6"]);
    expect(e.allowed).toEqual(["github-copilot/gpt-5.4"]);
    expect(typeof e.configPath).toBe("string");
    expect(e.configPath.length).toBeGreaterThan(0);
  }
});
```

5b. Model — `model` filtered out (case A variant; adds role + configPath assertions over r2):

```ts
it("throws NoAllowedRouteMatchError with full payload when rule.model is filtered out by allowed_models (G25)", () => {
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
  try {
    resolver.resolve("coder");
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
    const e = err as NoAllowedRouteMatchError;
    expect(e.kind).toBe("model");
    expect(e.role).toBe("coder");
    expect(e.candidates).toEqual(["github-copilot/claude-sonnet-4.6"]);
    expect(e.allowed).toEqual(["github-copilot/gpt-5.4"]);
    expect(typeof e.configPath).toBe("string");
    expect(e.configPath.length).toBeGreaterThan(0);
  }
});
```

5c. Model — intersection non-empty resolves (case B regression):

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

5d. Account — explicit account and default both outside allow-list (case D; adds configPath assertion over r2):

```ts
it("throws NoAllowedRouteMatchError with full payload when both explicit and default account are filtered (G25)", () => {
  const resolver = new ModelRoutingResolver(
    {
      routing: {
        roles: {
          coder: {
            model: "github-copilot/gpt-5.4",
            account: "user-a",
            allowed_accounts: ["github-copilot.user-b"],
          },
        },
      },
    },
    { providers: { "github-copilot": { defaultAccount: "user-c" } } },
  );
  try {
    resolver.resolve("coder");
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
    const e = err as NoAllowedRouteMatchError;
    expect(e.kind).toBe("account");
    expect(e.role).toBe("coder");
    expect(e.candidates).toEqual(["github-copilot.user-a", "github-copilot.user-c"]);
    expect(e.allowed).toEqual(["github-copilot.user-b"]);
    expect(typeof e.configPath).toBe("string");
    expect(e.configPath.length).toBeGreaterThan(0);
  }
});
```

5e. Account — no explicit, default outside allow-list (case E; adds role + configPath assertions over r2):

```ts
it("throws NoAllowedRouteMatchError with full payload when only the provider defaultAccount is a candidate and it is filtered out (G25)", () => {
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
    { providers: { "github-copilot": { defaultAccount: "user-a" } } },
  );
  try {
    resolver.resolve("coder");
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
    const e = err as NoAllowedRouteMatchError;
    expect(e.kind).toBe("account");
    expect(e.role).toBe("coder");
    expect(e.candidates).toEqual(["github-copilot.user-a"]);
    expect(e.allowed).toEqual(["github-copilot.user-b"]);
    expect(typeof e.configPath).toBe("string");
    expect(e.configPath.length).toBeGreaterThan(0);
  }
});
```

5f. Account — default account allowed (case F regression):

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

5g. Account — allow-list only, no explicit, no default (case G regression):

```ts
it("returns allowed_accounts when no explicit and no default account is configured (G25)", () => {
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
    { providers: { "github-copilot": {} } },
  );
  expect(resolver.resolve("coder").preferredAccounts).toEqual(["github-copilot.user-b"]);
});
```

Test inventory for §5 mirrors the table in [02-design-r3.md](02-design-r3.md) §A.5 ("Test inventory — resolver tests"). Every failure case (5a, 5b, 5d, 5e) asserts kind, role, candidates, allowed, and configPath; every regression case (5c, 5f, 5g) asserts the returned array.

### Task 6 — Validator boundary test

Edit [src/config-validation.test.ts](../../../../src/config-validation.test.ts). Update the import at [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L4):

```ts
import { validateModelCoverage, MissingModelForRoleError, NoAllowedRouteMatchError } from "./config-validation.js";
```

Inside the existing `describe("validateModelCoverage", ...)` block at [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L33), add (adds explicit `configPath` equality assertion over r2):

```ts
it("propagates NoAllowedRouteMatchError verbatim with full payload instead of collapsing into MissingModelForRoleError (G25)", () => {
  const cfg = makeConfig({
    models: { default: "github-copilot/gpt-5.4" } as SaivageConfig["models"],
    supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
    security: { ...makeConfig().security, injectionScanner: false } as SaivageConfig["security"],
  });
  const routing = new ModelRoutingResolver(
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
    { models: { default: "github-copilot/gpt-5.4" } },
  );
  try {
    validateModelCoverage(cfg, routing, "/proj/.saivage/saivage.json");
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
    expect(err).not.toBeInstanceOf(MissingModelForRoleError);
    const e = err as NoAllowedRouteMatchError;
    expect(e.kind).toBe("model");
    expect(e.role).toBe("coder");
    expect(e.candidates).toEqual(["github-copilot/claude-sonnet-4.6"]);
    expect(e.allowed).toEqual(["github-copilot/gpt-5.4"]);
    expect(e.configPath).toBe("/proj/.saivage/saivage.json");
  }
});
```

Test inventory for §6 mirrors the table in [02-design-r3.md](02-design-r3.md) §A.5 ("Test inventory — validator boundary test"). All five payload fields are asserted; `configPath` is checked by exact equality since the caller passes a fixed string.

The existing aggregation case at [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L94-L131) stays unmodified and must remain green (acceptance criterion I).

### Task 7 — Build and validate

Unchanged from [03-plan-r2.md](03-plan-r2.md) Task 7. From `/home/salva/g/ml/saivage`:

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run src/routing/resolver.test.ts src/config-validation.test.ts
```

Both must pass with zero skipped tests.

## Out of scope (explicit)

Unchanged from [03-plan-r2.md](03-plan-r2.md). Cycle detection (G23), Zod parse de-duplication (G24), and `legacy` source-tier removal (G26) are owned by their respective findings. No `RoutingTrace`, no chat-UI surface, no `log.warn`, no schema knob, no doc changes.

## Effort

Small, contained edit. Two source files plus two test files. No cross-module ripple beyond the validator narrowing, which is a net code reduction.

## Backout

`git checkout -- src/routing/resolver.ts src/config-validation.ts src/routing/resolver.test.ts src/config-validation.test.ts`. No on-disk state, no external contract, no schema change. Safe mid-batch.
