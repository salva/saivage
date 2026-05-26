# G25 — Design (round 4, writer Claude Opus 4.7)

Reads from [01-analysis-r4.md](01-analysis-r4.md). The only round-3-to-round-4 delta is the `configPath` assertion in the validator-boundary test (Task 6); the source-code design (typed error, validator narrowing, both resolver bodies) is carried forward unchanged from [02-design-r3.md](02-design-r3.md). Addresses the single blocking item in [04-review-r3.md](04-review-r3.md).

## Recommended: Proposal A — Typed `NoAllowedRouteMatchError` + validator narrowing + symmetric account fix

### A.1 Typed error in `src/config-validation.ts`

Unchanged from [02-design-r3.md](02-design-r3.md) §A.1. Add after `MissingModelForRoleError` at [src/config-validation.ts](../../../../src/config-validation.ts#L11-L22):

```ts
export class NoAllowedRouteMatchError extends Error {
  readonly kind: "model" | "account";
  readonly role: string;
  readonly candidates: string[];
  readonly allowed: string[];
  readonly configPath: string;
  constructor(
    kind: "model" | "account",
    role: string,
    candidates: string[],
    allowed: string[],
    configPathStr: string,
  ) {
    super(
      `No ${kind} in the configured allow-list for role "${role}" matches any candidate. ` +
      `Candidates: [${candidates.join(", ")}]. Allowed: [${allowed.join(", ")}]. ` +
      `Config: ${configPathStr}`,
    );
    this.name = "NoAllowedRouteMatchError";
    this.kind = kind;
    this.role = role;
    this.candidates = candidates;
    this.allowed = allowed;
    this.configPath = configPathStr;
  }
}
```

### A.2 Narrow `validateModelCoverage` to its declared concern

Unchanged from [02-design-r3.md](02-design-r3.md) §A.2. Replace each bare `catch { missing.push(role); }` at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L69) with a typed filter:

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

`NoAllowedRouteMatchError` and `RoutingProfileCycleError` propagate verbatim to `bootstrap()` and through to the CLI try/catch at [src/server/cli.ts](../../../../src/server/cli.ts#L70-L97). "Verbatim" here means the same `Error` instance is rethrown without re-wrapping or field mutation, so every payload field — including `configPath` — retains the value the resolver stamped on it via `configPath()`. The `configPathStr` parameter of `validateModelCoverage` is consumed only when constructing the validator's own `MissingModelForRoleError` aggregate at [src/config-validation.ts](../../../../src/config-validation.ts#L67); it does not — and by design cannot — override the resolver's view inside `NoAllowedRouteMatchError`.

### A.3 Rewrite `resolvePreferredModels`

Unchanged from [02-design-r3.md](02-design-r3.md) §A.3. Replace the body at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219):

```ts
private resolvePreferredModels(role: string, rule: NormalizedRule): string[] {
  const candidates = unique([
    ...(rule.model ? [rule.model] : []),
    ...rule.preferredModels,
  ]);
  const allowed = rule.allowedModels?.length ? unique(rule.allowedModels) : undefined;

  if (!allowed) {
    return candidates.length ? candidates : this.resolveLegacyModels(role);
  }
  if (candidates.length === 0) {
    return allowed;
  }

  const allowedSet = new Set(allowed);
  const filtered = candidates.filter((c) => allowedSet.has(c));
  if (filtered.length > 0) return filtered;

  throw new NoAllowedRouteMatchError("model", role, candidates, allowed, configPath());
}
```

Deletes the fail-open line `if (allowed?.size) return [...allowed];` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L218). `configPath()` resolves via [src/config.ts](../../../../src/config.ts#L224-L226) from `SAIVAGE_ROOT` or `resolveProjectRoot()`; the resolver does not accept a path argument and is not changed to accept one (architectural rationale in [01-analysis-r4.md](01-analysis-r4.md) §2).

### A.4 Rewrite `resolvePreferredAccounts` and thread `role`

Unchanged from [02-design-r3.md](02-design-r3.md) §A.4. Signature at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222) becomes:

```ts
private resolvePreferredAccounts(role: string, provider: string, rule: NormalizedRule): string[]
```

Single call site at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L117):

```ts
const preferredAccounts = parsed ? this.resolvePreferredAccounts(role, provider, merged) : [];
```

Body:

```ts
private resolvePreferredAccounts(role: string, provider: string, rule: NormalizedRule): string[] {
  if (rule.authProfile) return [];

  const explicit = unique([
    ...(rule.account ? [normalizeAccountRef(provider, rule.account)] : []),
    ...rule.preferredAccounts.map((entry) => normalizeAccountRef(provider, entry)),
  ]);
  const defaultAccount = this.runtime.providers?.[provider]?.defaultAccount;
  const normalizedDefault = defaultAccount
    ? normalizeAccountRef(provider, defaultAccount)
    : undefined;
  const candidates = unique([
    ...explicit,
    ...(normalizedDefault ? [normalizedDefault] : []),
  ]);

  const allowed = rule.allowedAccounts?.length
    ? unique(rule.allowedAccounts.map((entry) => normalizeAccountRef(provider, entry)))
    : undefined;

  if (!allowed) {
    if (explicit.length) return explicit;
    return normalizedDefault ? [normalizedDefault] : [];
  }

  if (candidates.length === 0) {
    return allowed;
  }

  const allowedSet = new Set(allowed);
  const filteredExplicit = explicit.filter((c) => allowedSet.has(c));
  if (filteredExplicit.length > 0) return filteredExplicit;
  if (normalizedDefault && allowedSet.has(normalizedDefault)) return [normalizedDefault];

  throw new NoAllowedRouteMatchError("account", role, candidates, allowed, configPath());
}
```

### A.5 Test contract (round-4 correction)

The typed-error payload contract is unchanged:

| Field | Type | What every failure test must assert |
|---|---|---|
| `kind` | `"model" \| "account"` | exact value matching the call site |
| `role` | `string` | exact role name |
| `candidates` | `string[]` | exact array contents and order |
| `allowed` | `string[]` | exact array contents and order |
| `configPath` | `string` | non-empty (`typeof === "string"`, length > 0) |

The round-4 correction is in the inventory tables: every test — resolver-level and validator-boundary — asserts the non-empty-string contract on `configPath`, never exact equality. Justification: every `NoAllowedRouteMatchError` in the codebase is constructed at the resolver throw sites at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219) and [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222-L244) with `configPath()`, which is environment- and cwd-derived. No throw site uses the validator's `configPathStr` argument; verbatim propagation across `validateModelCoverage` preserves the resolver-stamped value. The exact-path contract for `configPathStr` is already covered for `MissingModelForRoleError` at [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L106-L117) and is out of scope for this finding.

#### Test inventory — resolver tests

| # | Case | Method | Asserts kind | role | candidates | allowed | configPath | Asserts return value |
|---|---|---|---|---|---|---|---|---|
| 5a | preferred_models filtered out | `resolvePreferredModels` | ✓ `"model"` | ✓ `"coder"` | ✓ `["github-copilot/claude-sonnet-4.6"]` | ✓ `["github-copilot/gpt-5.4"]` | ✓ non-empty string | — |
| 5b | rule.model filtered out | `resolvePreferredModels` | ✓ `"model"` | ✓ `"coder"` | ✓ `["github-copilot/claude-sonnet-4.6"]` | ✓ `["github-copilot/gpt-5.4"]` | ✓ non-empty string | — |
| 5c | intersection non-empty (regression) | `resolvePreferredModels` | — | — | — | — | — | ✓ `["github-copilot/gpt-5.4"]` |
| 5d | explicit + defaultAccount both filtered | `resolvePreferredAccounts` | ✓ `"account"` | ✓ `"coder"` | ✓ `["github-copilot.user-a","github-copilot.user-c"]` | ✓ `["github-copilot.user-b"]` | ✓ non-empty string | — |
| 5e | only defaultAccount, filtered | `resolvePreferredAccounts` | ✓ `"account"` | ✓ `"coder"` | ✓ `["github-copilot.user-a"]` | ✓ `["github-copilot.user-b"]` | ✓ non-empty string | — |
| 5f | defaultAccount allowed (regression) | `resolvePreferredAccounts` | — | — | — | — | — | ✓ `["github-copilot.user-b"]` |
| 5g | allow-list only, no explicit, no default | `resolvePreferredAccounts` | — | — | — | — | — | ✓ `["github-copilot.user-b"]` |

#### Test inventory — validator boundary test (round-4 correction)

| # | Case | Entry point | Asserts kind | role | candidates | allowed | configPath | Other |
|---|---|---|---|---|---|---|---|---|
| 6 | propagates `NoAllowedRouteMatchError` verbatim | `validateModelCoverage` | ✓ `"model"` | ✓ `"coder"` | ✓ `["github-copilot/claude-sonnet-4.6"]` | ✓ `["github-copilot/gpt-5.4"]` | ✓ non-empty string | also asserts `not.toBeInstanceOf(MissingModelForRoleError)` |

Test 6 asserts `configPath` by the non-empty-string contract — identical to the resolver tests — because the value originates at the resolver throw site via `configPath()`, not from `validateModelCoverage`'s `configPathStr` argument. The verbatim-propagation property under test is exactly this: the resolver's view is preserved unchanged across the validator boundary. The `configPathStr` argument to `validateModelCoverage` is still passed (`"/proj/.saivage/saivage.json"`) to keep the test call shape stable and consistent with the validator's other call sites in the same file; it just is not the value compared against `e.configPath`.

### A.6 Out of scope (anti-creep)

Unchanged from [02-design-r3.md](02-design-r3.md) §A.6.

- No `RoutingTrace`, no `log.warn`, no UI hook.
- No new field on `ResolvedModelRoute`.
- No new operator-facing config knob.
- No change to `MissingModelForRoleError`.
- No change to `resolveSource`.
- No threading of `configPathStr` into resolver method signatures.
- No touch on G23, G24, or G26 beyond the mechanical rename coordination.

## Proposal B (rejected) — Strict allow-list (also drop F04 r3 and its accounts analogue)

Unchanged from [02-design-r3.md](02-design-r3.md). Still rejected.

## Proposal C (rejected) — Opt-in `on_empty_intersection` policy field

Unchanged from [02-design-r3.md](02-design-r3.md). Still rejected.

## Proposal D (rejected, round 4) — Thread `configPathStr` from validator into resolver

Considered in [01-analysis-r4.md](01-analysis-r4.md) §2 as path B. Rejected: would force `resolve`, `resolvePreferredModels`, and `resolvePreferredAccounts` to take a config-path argument that none of their other call sites need, duplicating state already exposed by the `configPath()` module function. Verbatim propagation is the architectural property under test; preserving the resolver's view of `configPath` across the validator boundary is correct by construction.

## Risks

Unchanged from [02-design-r3.md](02-design-r3.md). Relaxing one assertion does not weaken the contract: the round 3 reviewer's exact-equality claim was unsound against the actual resolver code path. The non-empty-string contract is the strongest assertion the verbatim-propagation property supports without architectural changes that the project rules ("avoid over-engineering") explicitly forbid.

## Backout

`git checkout -- src/routing/resolver.ts src/config-validation.ts src/routing/resolver.test.ts src/config-validation.test.ts`. No on-disk state, no external contract, no schema change.
