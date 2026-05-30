# G25 — Analysis (round 1, writer Claude Opus 4.7)

## 1. What the finding says

Finding [G25-resolver-fail-open-allowed-models.md](../G25-resolver-fail-open-allowed-models.md) reports that after intersecting candidate models with the per-role `allowed_models` allow-list, the resolver returns the raw allow-list when the intersection is empty, rather than failing. Operators tightening the allow-list can therefore end up with a route that matches neither the upstream candidate set nor their restriction.

## 2. What the code actually does today

The relevant function is `ModelRoutingResolver.resolvePreferredModels` at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L205-L220):

- Line [206-209](../../../../src/routing/resolver.ts#L206-L209): build `candidates` from the rule's single `model` followed by `preferred_models` (deduplicated).
- Line [210-211](../../../../src/routing/resolver.ts#L210-L211): build `allowed` as a `Set` from `allowed_models` when non-empty, otherwise leave it undefined.
- Line [213-215](../../../../src/routing/resolver.ts#L213-L215): when `allowed` is set, `filtered = candidates.filter(c => allowed.has(c))`; otherwise `filtered = candidates`.
- Line [217](../../../../src/routing/resolver.ts#L217): if `filtered.length > 0`, return it (correct behavior).
- Line [218](../../../../src/routing/resolver.ts#L218): if `allowed?.size`, return `[...allowed]` — this is the fail-open the finding targets.
- Line [219](../../../../src/routing/resolver.ts#L219): otherwise fall back to `resolveLegacyModels(role)` (runtime defaults or `model_overrides`).

Line 218 conflates two distinct scenarios into a single fallback:

- Scenario X: `candidates` was empty (no `model`, no `preferred_models`) and only `allowed_models` is configured. Returning `[...allowed]` here is the documented behavior pinned by the regression test at [../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137) ("classifies allowed_models-only routing rules as routing-derived (F04 r3)"). Operators rely on this to express "route this role exclusively to this set" without also writing `preferred_models`.
- Scenario Y: `candidates` was non-empty but every entry was filtered out by `allowed`. Returning `[...allowed]` here is the bug — it hands the caller models the operator's own `preferred_models`/`model` never asked for, and contradicts the allow-list semantics.

The same fail-open pattern repeats six lines below in `resolvePreferredAccounts` at [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L226-L246), specifically the final `return allowed ? [...allowed] : [];` on line [245](../../../../src/routing/resolver.ts#L245). When `allowed_accounts` filters every explicit account out and the provider default account is also outside the allow-list (or absent), the resolver returns the bare allow-list as if it were the resolved candidate. The finding scopes itself to `allowed_models`, but the architecture-first project rule makes it indefensible to fix one half of an identical pattern and leave the other live.

## 3. Caller surface

- `MissingModelForRoleError` ([../../../../src/config-validation.ts](../../../../src/config-validation.ts#L11-L20)) is the only typed routing error the resolver throws today. It is caught structurally (instance checks) only inside resolver tests; production callers (`bootstrap`, `supervisor`, `prompt-injection-cop`, `providers/router`) let it propagate. That matches the architecture-first rule: a misconfigured route crashes loudly.
- There is no `RoutingTrace` in the codebase (G23 r2 design at [../G23/02-design-r2.md](../G23/02-design-r2.md#L87) confirmed this and explicitly declined to introduce one). The finding's mention of `RoutingTrace` is aspirational and tied to round-1 F12, which is not approved. We must not introduce it under G25.
- `resolve()` returns a `ResolvedModelRoute` synchronously; the `preferredModels` field is consumed by `RoleRouter` downstream. We can throw from the resolution path without contract changes.

## 4. Related round-2 findings (avoid scope creep)

- G23 (silent profile cycle) — chooses to fail closed at config load with a typed error; reviewed and approved. Sets the precedent we follow.
- G24 (redundant Zod parse) — moves validation into the loader; orthogonal to G25.
- G26 (`legacy` source tier) — deletes the `legacy` enum variant; orthogonal but adjacent code lines. We must not collide with it (do not touch `resolveSource` or the source union).

## 5. Constraints carried into design

- Architecture-first: fix the architectural defect, not just the symptom; treat `allowed_models` and `allowed_accounts` as a single pattern with one fix.
- No backward compatibility, no migration shims: do not add an opt-in policy switch to preserve fail-open; remove the fail-open outright when it is wrong.
- No over-engineering: do not introduce `RoutingTrace`, do not add new caller-visible fields, do not touch UI.
- Preserve F04 r3 semantics ([../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137)) unless we deliberately and explicitly decide to drop it. Dropping it is a separate UX decision and out of scope for G25's reading; we keep it but make the distinction explicit in code.
- Mirror G23's resolution style: typed error from the resolver, no new structural return, callers crash loudly.

## 6. Acceptance criteria

A. With `allowed_models` set and at least one entry of `candidates` (from `model`/`preferred_models`) surviving the filter, behavior is unchanged.

B. With `allowed_models` set, `candidates` non-empty, and every candidate filtered out, `resolve()` throws a typed error naming the role, the configured candidates, and the allow-list. The resolver does not return `[...allowed]`.

C. With `allowed_models` set and `candidates` empty (no `model`/`preferred_models`), `resolve()` keeps today's behavior of using the allow-list as the candidate set. The F04 r3 test stays green.

D. Same A/B/C semantics applied to `allowed_accounts` in `resolvePreferredAccounts`, with the provider's default account treated as part of the candidate set (it is the "non-empty candidate" signal for accounts).

E. Existing `resolver.test.ts` cases stay green; new cases cover the failure branch for both models and accounts.

F. No new fields on `ResolvedModelRoute`, no `RoutingTrace`, no UI changes, no changes to `bootstrap.ts` or `cli.ts` beyond letting the new error propagate.
