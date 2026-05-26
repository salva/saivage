# G25 — Plan (round 2, writer Claude Opus 4.7)

Implements Proposal A from [02-design-r2.md](02-design-r2.md). Supersedes [03-plan-r1.md](03-plan-r1.md).

## Touched files

- [src/config-validation.ts](../../../../src/config-validation.ts) — add `NoAllowedRouteMatchError`; narrow `validateModelCoverage` catch.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts) — rewrite `resolvePreferredModels` and `resolvePreferredAccounts`; thread `role` into the latter.
- [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts) — failure + regression cases for both methods, asserting the typed payload.
- [src/config-validation.test.ts](../../../../src/config-validation.test.ts) — regression case proving `NoAllowedRouteMatchError` propagates through `validateModelCoverage` verbatim.

No other files. No UI, docs, schema, or on-disk format changes.

## Sequencing within the resolver batch

Per [01-analysis-r2.md](01-analysis-r2.md) §3 and [G23/APPROVED.md](../G23/APPROVED.md#L9) / [G24/APPROVED.md](../G24/APPROVED.md#L9), apply in the order G23 → G24 → G25 → G26. G25 lands after G23 and G24 have stabilized the constructor and the resolver input type, before G26 renames `resolveLegacyModels` → `resolveRuntimeDefaultModels`. If G26 lands first, replace the single `this.resolveLegacyModels(role)` call inside the new `resolvePreferredModels` body with `this.resolveRuntimeDefaultModels(role)` (mechanical, no semantic change).

## Tasks (sequential)

### Task 1 — Add `NoAllowedRouteMatchError`

Edit [src/config-validation.ts](../../../../src/config-validation.ts). After `MissingModelForRoleError` (ends at [src/config-validation.ts](../../../../src/config-validation.ts#L22)), append the class declared in [02-design-r2.md](02-design-r2.md) §A.1.

No other change in this task.

### Task 2 — Narrow `validateModelCoverage`

Edit `validateModelCoverage` at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L69). Replace each of the three `try { ... } catch { ... push(...); }` blocks with the typed-filter form from [02-design-r2.md](02-design-r2.md) §A.2:

```ts
try {
  routing.resolve(role);
} catch (err) {
  if (err instanceof MissingModelForRoleError) {
    missing.push(role);
    continue;
  }
  throw err;
}
```

Apply to the worker-role loop ([src/config-validation.ts](../../../../src/config-validation.ts#L46-L52)) and to the supervisor / security branches ([src/config-validation.ts](../../../../src/config-validation.ts#L53-L66)). For the supervisor and security branches, the `continue` becomes a no-op (they are not in a loop); use `missing.push("supervisor")` / `missing.push("security")` directly inside the `if` and omit the `continue` keyword. Equivalent semantics, one `try` per branch.

### Task 3 — Rewrite `resolvePreferredModels`

Edit [src/routing/resolver.ts](../../../../src/routing/resolver.ts):

3a. Imports at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L3): change
`import { MissingModelForRoleError } from "../config-validation.js";`
to
`import { MissingModelForRoleError, NoAllowedRouteMatchError } from "../config-validation.js";`.

3b. Replace the body at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219) with the form in [02-design-r2.md](02-design-r2.md) §A.3. Delete `if (allowed?.size) return [...allowed];` ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L218)).

### Task 4 — Rewrite `resolvePreferredAccounts` and thread `role`

4a. Signature at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222) becomes
`private resolvePreferredAccounts(role: string, provider: string, rule: NormalizedRule): string[]`.

4b. Single call site at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L117) becomes
`const preferredAccounts = parsed ? this.resolvePreferredAccounts(role, provider, merged) : [];`.

4c. Replace the body at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222-L244) with the form in [02-design-r2.md](02-design-r2.md) §A.4. Delete the trailing `return allowed ? [...allowed] : [];` ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L244)).

### Task 5 — Resolver tests (payload-asserting, both methods)

Edit [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts). Update the import line at [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L2):

```ts
import { ModelRoutingResolver } from "./resolver.js";
import { NoAllowedRouteMatchError } from "../config-validation.js";
```

Add the following cases after the existing F04 r3 case at [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137). Every failure case asserts the typed payload (Required Change 3); regression cases assert the resolved arrays.

5a. Model — preferred filtered out (case A in [01-analysis-r2.md](01-analysis-r2.md) §4):

```ts
it("throws NoAllowedRouteMatchError with typed payload when preferred_models is filtered out (G25)", () => {
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
  }
});
```

5b. Model — `model` filtered out (also case A):

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
  try {
    resolver.resolve("coder");
    expect.fail("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
    const e = err as NoAllowedRouteMatchError;
    expect(e.kind).toBe("model");
    expect(e.candidates).toEqual(["github-copilot/claude-sonnet-4.6"]);
    expect(e.allowed).toEqual(["github-copilot/gpt-5.4"]);
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

5d. Account — explicit account and default both outside allow-list (case D, Required Change 3 payload):

```ts
it("throws NoAllowedRouteMatchError with both explicit and default in candidates (G25)", () => {
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
  }
});
```

5e. Account — no explicit, default outside allow-list (case E, Required Change 4):

```ts
it("throws NoAllowedRouteMatchError when only the provider defaultAccount is a candidate and it is filtered out (G25)", () => {
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
    expect(e.candidates).toEqual(["github-copilot.user-a"]);
    expect(e.allowed).toEqual(["github-copilot.user-b"]);
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

5g. Account — allow-list only, no explicit, no default (case G, Required Change 5):

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

### Task 6 — Validator boundary test (Required Change 2)

Edit [src/config-validation.test.ts](../../../../src/config-validation.test.ts). Update the import at [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L4):

```ts
import { validateModelCoverage, MissingModelForRoleError, NoAllowedRouteMatchError } from "./config-validation.js";
```

Inside the existing `describe("validateModelCoverage", ...)` block ([src/config-validation.test.ts](../../../../src/config-validation.test.ts#L33)), add:

```ts
it("propagates NoAllowedRouteMatchError verbatim instead of collapsing into MissingModelForRoleError (G25)", () => {
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
  }
});
```

The existing aggregation case at [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L94-L131) stays unmodified and must remain green (acceptance criterion I).

### Task 7 — Build and validate

Run from `/home/salva/g/ml/saivage`:

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run src/routing/resolver.test.ts src/config-validation.test.ts
```

Both must pass with zero skipped tests. Full `npx vitest run` is recommended as a sanity sweep in the resolver batch (G23+G24+G25+G26) but is not the per-finding gate for G25.

## Out of scope (explicit)

- Cycle detection — owned by G23 ([G23/APPROVED.md](../G23/APPROVED.md)).
- Redundant Zod parse removal — owned by G24 ([G24/APPROVED.md](../G24/APPROVED.md)).
- `legacy` source-tier removal — owned by G26 ([../G26/02-design-r1.md](../G26/02-design-r1.md)).
- No `RoutingTrace`, chat-UI surface, log.warn, or new schema knob.
- No change to operator-facing routing schema docs.

## Effort

Small, contained edit. Two source files plus two test files. No cross-module ripple beyond the validator narrowing, which is a net code reduction.

## Backout

`git checkout -- src/routing/resolver.ts src/config-validation.ts src/routing/resolver.test.ts src/config-validation.test.ts`. No on-disk state, no external contract, no schema change. Backout is safe even mid-batch because the four files are self-contained.
