# G25 — Design (round 2, writer Claude Opus 4.7)

Reads from [01-analysis-r2.md](01-analysis-r2.md). Addresses every numbered item in [04-review-r1.md](04-review-r1.md) "Required Changes".

## Recommended: Proposal A — Typed `NoAllowedRouteMatchError` + validator narrowing + symmetric account fix

Round 1's Proposal A direction is retained; round 2 extends it with the validator narrowing the reviewer identified as a blocker and tightens the test contract.

### A.1 Typed error in `src/config-validation.ts`

Add next to `MissingModelForRoleError` at [src/config-validation.ts](../../../../src/config-validation.ts#L11-L22):

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

Same ergonomics as `MissingModelForRoleError` (no subclassing). Fields are declared as `readonly` properties (matching the existing `MissingModelForRoleError` style at [src/config-validation.ts](../../../../src/config-validation.ts#L12-L14)) rather than parameter-property shorthand, because `MissingModelForRoleError` follows the same style and consistency matters more than syntactic brevity.

### A.2 Narrow `validateModelCoverage` to its declared concern

Edit `validateModelCoverage` at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L69). Replace each bare `catch { missing.push(role); }` with a typed filter:

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

After the loop, when `missing.length > 0`, the existing terminal `throw new MissingModelForRoleError(missing, configPathStr)` still applies for the aggregated case.

Concretely this means `NoAllowedRouteMatchError` (from G25) and `RoutingProfileCycleError` (from G23) propagate to `bootstrap()` verbatim and surface to the CLI `serve` try/catch at [src/server/cli.ts](../../../../src/server/cli.ts#L70-L97) with their full payload. The validator stops claiming jurisdiction over errors it does not produce.

This decision — `validateModelCoverage` propagates the new error verbatim with payload intact — is the contract the reviewer required in Required Change 1.

### A.3 Rewrite `resolvePreferredModels`

Replace the body at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219):

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

Behavior map vs. acceptance criteria in [01-analysis-r2.md](01-analysis-r2.md):

- (A) non-empty `candidates`, empty intersection → throws with full payload.
- (B) non-empty intersection → returns `filtered`.
- (C) empty `candidates`, allow-list set → returns `allowed` (F04 r3 preserved).
- `!allowed` path identical to today.

The deleted line is `if (allowed?.size) return [...allowed];` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L218).

G26 coordination: if G26 lands first, `this.resolveLegacyModels(role)` is renamed to `this.resolveRuntimeDefaultModels(role)` — mechanical, single call site here.

### A.4 Rewrite `resolvePreferredAccounts` and thread `role`

Signature change at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222):

```ts
private resolvePreferredAccounts(role: string, provider: string, rule: NormalizedRule): string[]
```

Single call site at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L117) becomes:

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

Behavior map vs. acceptance criteria in [01-analysis-r2.md](01-analysis-r2.md):

- (D) explicit account filtered, `normalizedDefault` also filtered, both present → `candidates = [explicit, default]`, throws.
- (E) no explicit, `normalizedDefault` filtered → `candidates = [normalizedDefault]`, throws. This is the case round 1 left untested.
- (F) no explicit, `normalizedDefault` allowed → returns `[normalizedDefault]`.
- (G) no explicit, no `normalizedDefault`, allow-list set → `candidates.length === 0` branch returns `allowed`. Symmetric with F04 r3 on the model side. Decision is deliberate per [01-analysis-r2.md](01-analysis-r2.md) §2.4.
- `!allowed` path identical to today.

The `unique(allowed)` paths use the array form (already deduped at construction) so the returned values are stable and match the rest of the resolver's normalization style.

### A.5 Out of scope (anti-creep)

- No `RoutingTrace`, no log.warn, no UI hook.
- No new field on `ResolvedModelRoute`.
- No new operator-facing config knob.
- No change to `MissingModelForRoleError`.
- No change to `resolveSource` (its branches still match: `allowedModels?.length` truthy ⇒ `routing`).
- No touch on G23's cycle detection, G24's parse de-duplication, or G26's `legacy` removal beyond the mechanical rename coordination noted above.

## Proposal B (rejected) — Strict allow-list (also drop F04 r3 and its accounts analogue)

Same as Proposal A but additionally delete the `candidates.length === 0` branches on both the model and account sides, so allow-lists are purely filters. Rejected for the same reasons as round 1 (round 1 design [02-design-r1.md](02-design-r1.md#L102-L113)), now sharpened: dropping the accounts-only fallback breaks operators who today configure `allowed_accounts` alone, and dropping the models-only fallback contradicts F04 r3 ([src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137)). The reviewer asked us to either keep this branch with a test or drop it deliberately; round 2 deliberately keeps it on both sides and tests both.

## Proposal C (rejected) — Opt-in `on_empty_intersection` policy field

Unchanged from round 1 ([02-design-r1.md](02-design-r1.md#L117-L127)). Adds a config knob nobody asked for; the rejected behavior would be the live bug we are removing. Still rejected.

## Risks for Proposal A

- The validator narrowing in A.2 changes which errors `bootstrap()` propagates. The only consumers are the CLI `serve` try/catch ([src/server/cli.ts](../../../../src/server/cli.ts#L70-L97)) and the existing `MissingModelForRoleError`/`RoutingProfileCycleError` tests; nothing else does structural catches. Net behavior change: operators see the real error instead of a generic missing-model summary. This is the intended outcome of Required Change 1.
- Signature change on `resolvePreferredAccounts` is internal (single call site).
- Configs that depended on the accounts fail-open (allow-listing accounts that do not exist) now crash at first resolution. Intentional.

## Backout

`git checkout -- src/routing/resolver.ts src/config-validation.ts src/routing/resolver.test.ts src/config-validation.test.ts`. No on-disk state, no external contract, no schema change.
