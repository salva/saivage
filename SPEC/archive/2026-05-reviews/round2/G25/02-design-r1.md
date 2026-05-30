# G25 — Design (round 1, writer Claude Opus 4.7)

## Recommended: Proposal A — Distinguish "candidates filtered out" from "no candidates", fail closed in the former; apply symmetrically to accounts

### Shape

1. New typed error in [../../../../src/config-validation.ts](../../../../src/config-validation.ts#L11-L20), placed next to `MissingModelForRoleError`:

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

   Same shape and ergonomics as `MissingModelForRoleError`. No subclass relationship; tests use `instanceof` independently.

2. Rewrite `resolvePreferredModels` at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L205-L220) so that the empty-intersection branch splits explicitly:

   ```ts
   private resolvePreferredModels(role: string, rule: NormalizedRule): string[] {
     const candidates = unique([
       ...(rule.model ? [rule.model] : []),
       ...rule.preferredModels,
     ]);
     const allowed = rule.allowedModels?.length ? rule.allowedModels : undefined;

     if (!allowed) return candidates.length ? candidates : this.resolveLegacyModels(role);

     if (candidates.length === 0) return unique(allowed);

     const allowedSet = new Set(allowed);
     const filtered = candidates.filter((c) => allowedSet.has(c));
     if (filtered.length > 0) return filtered;

     throw new NoAllowedRouteMatchError("model", role, candidates, allowed, configPath());
   }
   ```

   - `candidates.length === 0` preserves the F04 r3 semantic (allow-list as candidate source when nothing else is configured).
   - Non-empty `candidates` with empty intersection throws — the bug the finding targets.
   - The previous `if (allowed?.size) return [...allowed];` line at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L218) is deleted.

3. Rewrite `resolvePreferredAccounts` at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L223-L246) with the same shape. Accounts have one extra wrinkle: the provider `defaultAccount` participates in the candidate set. We treat the union of `explicit` and (normalized) `defaultAccount` as `candidates`:

   ```ts
   private resolvePreferredAccounts(provider: string, rule: NormalizedRule): string[] {
     if (rule.authProfile) return [];

     const explicit = unique([
       ...(rule.account ? [normalizeAccountRef(provider, rule.account)] : []),
       ...rule.preferredAccounts.map((entry) => normalizeAccountRef(provider, entry)),
     ]);
     const defaultAccount = this.runtime.providers?.[provider]?.defaultAccount;
     const normalizedDefault = defaultAccount
       ? normalizeAccountRef(provider, defaultAccount)
       : undefined;

     const allowed = rule.allowedAccounts?.length
       ? rule.allowedAccounts.map((entry) => normalizeAccountRef(provider, entry))
       : undefined;

     if (!allowed) {
       if (explicit.length) return explicit;
       return normalizedDefault ? [normalizedDefault] : [];
     }

     const allowedSet = new Set(allowed);
     const filteredExplicit = explicit.filter((c) => allowedSet.has(c));
     if (filteredExplicit.length > 0) return filteredExplicit;

     if (normalizedDefault && allowedSet.has(normalizedDefault)) return [normalizedDefault];

     const candidates = unique([...explicit, ...(normalizedDefault ? [normalizedDefault] : [])]);
     if (candidates.length === 0) return unique(allowed);

     throw new NoAllowedRouteMatchError(
       "account",
       rule.profile ?? "<role>",
       candidates,
       allowed,
       configPath(),
     );
   }
   ```

   Note `rule.profile ?? "<role>"`: this method does not receive `role`. We thread it in (small signature change on a private method) so the error message is meaningful — see plan task 3.

4. No change to `resolveSource` ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L263-L272)) — its branches still match because `rule.allowedModels?.length` remains truthy when the allow-list is configured.

### What it does not do (anti-scope)

- No new field on `ResolvedModelRoute`.
- No `RoutingTrace`, no `log.warn`, no chat-UI hook.
- No opt-in `fall_back_to_allow_list` policy switch.
- No change to `MissingModelForRoleError` (kept distinct from `NoAllowedRouteMatchError` so callers can differentiate "config is missing" from "config excludes everything").
- No touch on `legacy` source tier (owned by G26) or the Zod re-parse (owned by G24) or cycle detection (owned by G23).

### Why this is the right level

- Finding asked for "fail closed with a clear error". Proposal A delivers exactly that, plus the symmetric fix on accounts because the project rule forbids leaving an identical fail-open in the same function next to the one we fix.
- Matches G23 r2 precedent: typed error, no new caller-visible structure, callers propagate.
- Keeps the F04 r3 semantic (allow-list-as-candidate-source when nothing else is set) intact, because deciding to drop it is a separate UX call.

---

## Proposal B (rejected) — Strict allow-list semantics, also drop F04 r3 fallback

Same as Proposal A, but additionally remove the `candidates.length === 0 ⇒ return unique(allowed)` branch so `allowed_models` is purely a filter. Operators wanting "use exactly these models" must write `preferred_models: [...]` (with or without a matching `allowed_models`).

Rejected because:

- It conflates G25 (fail-open bug) with a deliberate UX choice locked in by F04 r3 ([../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137)). That choice was made in round 1 specifically to let `allowed_models`-only stanzas configure a role; reversing it should be its own finding/decision, not a side effect of G25.
- Bigger blast radius on operator configs and the round-1 reviewer-approved test.
- Architecture-first does not require us to undo prior approved UX; it requires us not to add new backward-compat shims. We are not adding a shim — we are preserving an intentional behavior.

If a future finding revisits F04 r3, the diff is small (delete one branch + update the test); Proposal A leaves that door open without making the call now.

---

## Proposal C (rejected) — Opt-in `on_empty_intersection` policy field

Add `routingRuleSchema.on_empty_intersection: "fail" | "fall_back_to_allow_list"` (default `"fail"`).

Rejected because:

- Introduces a new configuration knob nobody asked for.
- The "fall back to allow-list" semantic is the very behavior the finding says is wrong; offering it as an opt-in preserves the bug shape and adds config surface.
- Violates "no over-engineering" — no live user need exists for the toggle.

---

## Risks for Proposal A

- The `resolvePreferredAccounts` signature change (adds `role: string`) is internal — only one call site at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L117). Low risk.
- Any project routing config that depended on the accounts fail-open ("operator allow-lists an account that doesn't actually exist") will now crash at first resolution. This is the intended behavior; it surfaces a misconfiguration the resolver was hiding.
- `NoAllowedRouteMatchError` is a new error type. Callers that do `try { resolve() } catch (MissingModelForRoleError)` would let it through — but we verified there are no such structural catches in production code; the only `instanceof` checks are in resolver/config-validation tests.

## Backout

Revert the resolver edit and the new error class. The change is contained to two files (`src/routing/resolver.ts`, `src/config-validation.ts`) plus tests; no cross-module state, no on-disk format change.
