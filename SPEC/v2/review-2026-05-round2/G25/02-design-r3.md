# G25 — Design (round 3, writer Claude Opus 4.7)

Reads from [01-analysis-r3.md](01-analysis-r3.md). The only round-2-to-round-3 delta is in the test contract; the source-code design (typed error, validator narrowing, both resolver bodies) is carried forward unchanged from [02-design-r2.md](02-design-r2.md). Addresses the single blocking item in [04-review-r2.md](04-review-r2.md).

## Recommended: Proposal A — Typed `NoAllowedRouteMatchError` + validator narrowing + symmetric account fix

### A.1 Typed error in `src/config-validation.ts`

Unchanged from [02-design-r2.md](02-design-r2.md) §A.1. Add after `MissingModelForRoleError` at [src/config-validation.ts](../../../../src/config-validation.ts#L11-L22):

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

Field declarations use the `readonly` property form to match the `MissingModelForRoleError` style at [src/config-validation.ts](../../../../src/config-validation.ts#L12-L14).

### A.2 Narrow `validateModelCoverage` to its declared concern

Unchanged from [02-design-r2.md](02-design-r2.md) §A.2. Replace each bare `catch { missing.push(role); }` at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L69) with a typed filter:

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

`NoAllowedRouteMatchError` and `RoutingProfileCycleError` propagate verbatim to `bootstrap()` and through to the CLI try/catch at [src/server/cli.ts](../../../../src/server/cli.ts#L70-L97).

### A.3 Rewrite `resolvePreferredModels`

Unchanged from [02-design-r2.md](02-design-r2.md) §A.3. Replace the body at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219):

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

Deletes the fail-open line `if (allowed?.size) return [...allowed];` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L218).

### A.4 Rewrite `resolvePreferredAccounts` and thread `role`

Unchanged from [02-design-r2.md](02-design-r2.md) §A.4. Signature at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222) becomes:

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

### A.5 Test contract (round-3 tightening)

The typed-error payload contract is:

| Field | Type | What every failure test must assert |
|---|---|---|
| `kind` | `"model" \| "account"` | exact value matching the call site |
| `role` | `string` | exact role name |
| `candidates` | `string[]` | exact array contents and order |
| `allowed` | `string[]` | exact array contents and order |
| `configPath` | `string` | non-empty (`typeof === "string"`, length > 0) |

Round 3 raises this from "design-level requirement" to "asserted in every failure test". The error class carries no other fields, so the table is exhaustive: there is no `provider` / `account` / `profile` field on `NoAllowedRouteMatchError`. The account-vs-model distinction is captured by `kind`; provider context is encoded inside the normalized strings in `candidates` and `allowed` (e.g. `github-copilot.user-a`).

The instanceof check is retained on top of the field checks because TypeScript narrowing relies on it.

#### Test inventory — resolver tests

The seven cases in [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts) that this design adds, with the fields each one asserts. "✓" marks a field that must be asserted; "—" marks not applicable (regression case, no thrown error).

| # | Case | Method | Asserts kind | role | candidates | allowed | configPath | Asserts return value |
|---|---|---|---|---|---|---|---|---|
| 5a | preferred_models filtered out | `resolvePreferredModels` | ✓ `"model"` | ✓ `"coder"` | ✓ `["github-copilot/claude-sonnet-4.6"]` | ✓ `["github-copilot/gpt-5.4"]` | ✓ non-empty string | — |
| 5b | rule.model filtered out | `resolvePreferredModels` | ✓ `"model"` | ✓ `"coder"` | ✓ `["github-copilot/claude-sonnet-4.6"]` | ✓ `["github-copilot/gpt-5.4"]` | ✓ non-empty string | — |
| 5c | intersection non-empty (regression) | `resolvePreferredModels` | — | — | — | — | — | ✓ `["github-copilot/gpt-5.4"]` |
| 5d | explicit + defaultAccount both filtered | `resolvePreferredAccounts` | ✓ `"account"` | ✓ `"coder"` | ✓ `["github-copilot.user-a","github-copilot.user-c"]` | ✓ `["github-copilot.user-b"]` | ✓ non-empty string | — |
| 5e | only defaultAccount, filtered | `resolvePreferredAccounts` | ✓ `"account"` | ✓ `"coder"` | ✓ `["github-copilot.user-a"]` | ✓ `["github-copilot.user-b"]` | ✓ non-empty string | — |
| 5f | defaultAccount allowed (regression) | `resolvePreferredAccounts` | — | — | — | — | — | ✓ `["github-copilot.user-b"]` |
| 5g | allow-list only, no explicit, no default | `resolvePreferredAccounts` | — | — | — | — | — | ✓ `["github-copilot.user-b"]` |

#### Test inventory — validator boundary test

| # | Case | Entry point | Asserts kind | role | candidates | allowed | configPath | Other |
|---|---|---|---|---|---|---|---|---|
| 6 | propagates `NoAllowedRouteMatchError` verbatim | `validateModelCoverage` | ✓ `"model"` | ✓ `"coder"` | ✓ `["github-copilot/claude-sonnet-4.6"]` | ✓ `["github-copilot/gpt-5.4"]` | ✓ equals `"/proj/.saivage/saivage.json"` | also asserts `not.toBeInstanceOf(MissingModelForRoleError)` |

Test 6 can assert `configPath` by exact equality because the call passes a fixed string (`"/proj/.saivage/saivage.json"`) directly, unlike the resolver tests where `configPath()` resolves to a runtime-derived path.

### A.6 Out of scope (anti-creep)

Unchanged from [02-design-r2.md](02-design-r2.md) §A.5.

- No `RoutingTrace`, no `log.warn`, no UI hook.
- No new field on `ResolvedModelRoute`.
- No new operator-facing config knob.
- No change to `MissingModelForRoleError`.
- No change to `resolveSource`.
- No touch on G23, G24, or G26 beyond the mechanical rename coordination.

## Proposal B (rejected) — Strict allow-list (also drop F04 r3 and its accounts analogue)

Unchanged from [02-design-r2.md](02-design-r2.md). Still rejected for the same reasons: breaking F04 r3 and the symmetric accounts-only fallback is a separate UX decision.

## Proposal C (rejected) — Opt-in `on_empty_intersection` policy field

Unchanged from [02-design-r2.md](02-design-r2.md). Still rejected; adds a knob nobody asked for.

## Risks

Unchanged from [02-design-r2.md](02-design-r2.md). Tightening the test contract carries no additional risk; it merely fails a broken implementation earlier.

## Backout

`git checkout -- src/routing/resolver.ts src/config-validation.ts src/routing/resolver.test.ts src/config-validation.test.ts`. No on-disk state, no external contract, no schema change.
