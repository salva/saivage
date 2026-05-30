# G25 — Analysis (round 2, writer Claude Opus 4.7)

Round 1 ([01-analysis-r1.md](01-analysis-r1.md)) was structurally correct: the live fail-open occurs in `resolvePreferredModels` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L219) and again symmetrically in `resolvePreferredAccounts` at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L222-L244). Round 2 carries that analysis forward and tightens the parts the reviewer ([04-review-r1.md](04-review-r1.md)) flagged as incomplete: the boot-time coverage validator interaction, the test contract on the new typed error, the account-side default-account candidate semantics, and the explicit decision on the accounts-only no-candidate fallback.

## 1. Carried conclusions (unchanged from r1)

- The two distinct empty-intersection scenarios remain the architectural pivot:
  - Scenario X (`candidates` empty, only `allowed_models` set) — preserved as the documented F04 r3 behavior, pinned by [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L137). Dropping it is a separate UX decision out of scope here.
  - Scenario Y (`candidates` non-empty, every entry filtered) — the bug. Must fail closed with a typed error naming role/candidates/allow-list.
- Architecture-first plus the no-shim rule force the symmetric fix on `resolvePreferredAccounts`; the fail-open at [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L244) cannot be left live while the model side is fixed.
- No `RoutingTrace`, no new caller-visible fields, no opt-in policy switch.

## 2. New issues uncovered by the reviewer

### 2.1 The new typed error is masked by `validateModelCoverage`

`bootstrap()` calls `validateModelCoverage(config, routing, configPath(project.projectRoot))` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130-L136). Today that validator wraps each `routing.resolve(role)` call in a bare `try { ... } catch { missing.push(role); }` at [src/config-validation.ts](../../../../src/config-validation.ts#L41-L69), and ultimately throws `MissingModelForRoleError` with the collected role list.

Net effect: an allow-list mismatch on a required role surfaces at boot as a generic "no model configured" message, with the `kind` / `role` / `candidates` / `allowed` / `configPath` payload of `NoAllowedRouteMatchError` silently discarded. That defeats the purpose of the new typed error precisely on the call path operators see first.

The architectural fix is to narrow the validator: `validateModelCoverage` aggregates only `MissingModelForRoleError` (its declared concern — "no model configured for role"); any other error from `routing.resolve(role)` — including `NoAllowedRouteMatchError` and the existing `RoutingProfileCycleError` introduced by G23 ([G23/APPROVED.md](../G23/APPROVED.md)) — is rethrown verbatim. The validator does not own the privilege of redescribing those failures.

### 2.2 Test contract must assert the payload, not the class

Round 1's plan ([03-plan-r1.md](03-plan-r1.md#L84-L162)) only used `toThrow(NoAllowedRouteMatchError)`. That accepts an implementation that throws the right class with the wrong contents (e.g. swapped `candidates` and `allowed`, missing `kind`, empty `role`). Round 2 must assert the typed fields — `kind`, `role`, `candidates`, `allowed`, `configPath` — on every failure case, both at the resolver level and at the new `validateModelCoverage` boundary.

### 2.3 Account-side `defaultAccount` candidate semantics need a dedicated test

The reviewer correctly observes that round 1's only account failure case ([03-plan-r1.md](03-plan-r1.md#L130-L150)) had both an explicit account and a provider `defaultAccount`, so it cannot distinguish an implementation that forgets to treat `defaultAccount` as a candidate. The architecturally meaningful case is: no explicit account, provider has `defaultAccount`, `allowed_accounts` excludes it. That must throw with `candidates = [normalized(defaultAccount)]`.

### 2.4 Explicit decision on the accounts-only no-candidate fallback

`allowed_accounts` mirrors `allowed_models`. F04 r3 keeps "allow-list as candidate when nothing else is configured" for models; round 2 keeps the same on accounts, because:

- Removing the asymmetry would mean operators who write `allowed_accounts: ["github-copilot.user-b"]` (with no explicit account, no provider default) get an error from a config that previously yielded `["github-copilot.user-b"]`. That breaking change is a UX decision separate from G25's fail-open bug.
- Models and accounts share one resolution shape; introducing an asymmetry here would itself be the architectural smell.

Round 2 keeps the branch and tests it explicitly. If a future finding wants to remove the symmetric branch on both sides, the diff is one branch on each side plus two tests.

## 3. Cross-finding sequencing

All four findings touch [src/routing/resolver.ts](../../../../src/routing/resolver.ts) and must land in one batch as the G23/G24 APPROVED docs both require ([G23/APPROVED.md](../G23/APPROVED.md#L9), [G24/APPROVED.md](../G24/APPROVED.md#L9)).

- G23 (cycle detection in constructor) is orthogonal to the empty-intersection logic; no line overlap.
- G24 (drop the redundant `projectRoutingSchema.parse` calls + introduce `ProjectRoutingInput`) does not touch `resolvePreferredModels` / `resolvePreferredAccounts` bodies, but it changes the resolver's input type alias. G25 keeps using the same alias name the post-G24 code expects (mechanical rename only).
- G26 (delete `legacy` source tier) renames `resolveLegacyModels` to `resolveRuntimeDefaultModels` and narrows the source union. G25's surviving call to that helper (the `!allowed && candidates.length === 0` branch) is mechanical to track: same line, renamed function.

Recommended local order in the batch: G23 → G24 → G25 → G26. G25 lands after the type/parse plumbing is stable but before G26 renames the helper, so the diff stays minimal. If G26 ships first the diff is the same with a renamed callee; either order is acceptable provided this batch ordering is honored.

## 4. Acceptance criteria (round 2, supersedes round 1)

A. Model side — `allowed_models` set, `candidates` non-empty, intersection empty → `resolve()` throws `NoAllowedRouteMatchError` with `kind: "model"`, the role name, the full `candidates` array, the full `allowed` array, and `configPath()`.

B. Model side — `allowed_models` set, intersection non-empty → returns filtered intersection (regression).

C. Model side — `allowed_models` set, `candidates` empty → returns `unique(allowed_models)` (F04 r3 preserved).

D. Account side — explicit account configured but filtered out by `allowed_accounts`, provider `defaultAccount` also outside the allow-list → throws `NoAllowedRouteMatchError` with `kind: "account"`, the role, `candidates = unique([normalized(account), normalized(defaultAccount)])`, the full `allowed` array.

E. Account side — no explicit account, provider `defaultAccount` outside `allowed_accounts` → throws `NoAllowedRouteMatchError` with `kind: "account"` and `candidates = [normalized(defaultAccount)]`. (Reviewer-required new case.)

F. Account side — no explicit account, provider `defaultAccount` inside `allowed_accounts` → returns `[normalized(defaultAccount)]` (regression).

G. Account side — no explicit account, no provider `defaultAccount`, only `allowed_accounts` set → returns `unique(allowed_accounts)` (deliberately preserved symmetry with F04 r3; explicit regression test added).

H. Boundary — `validateModelCoverage` rethrows `NoAllowedRouteMatchError` verbatim when raised for a required role, instead of collapsing it into `MissingModelForRoleError`. The `kind` / `role` / `candidates` / `allowed` / `configPath` payload reaches the caller. The `RoutingProfileCycleError` produced by G23 is also rethrown verbatim by the same change (incidental, correct).

I. Boundary — `validateModelCoverage` still aggregates multiple `MissingModelForRoleError` failures into a single `MissingModelForRoleError` with the combined role list (existing behavior, [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L94-L131) stays green).

J. No new field on `ResolvedModelRoute`, no `RoutingTrace`, no log.warn, no UI hook, no schema knob, no doc changes to operator-facing routing docs.

## 5. Constraints

Unchanged from round 1, with one addition: the validator narrowing in 2.1 is a precondition for the design's contract to hold in production, so it is part of G25's scope, not a future finding.
