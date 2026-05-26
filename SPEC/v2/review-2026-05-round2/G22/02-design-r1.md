# G22 — Design (round 1)

**Writer**: Claude Opus 4.7.
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md).
**Scope**: one file — [src/providers/router.ts](../../../../src/providers/router.ts).

## 1. Decision driver

After removing the dead `"copilot"` row, every remaining row of `PROVIDER_TO_OAUTH` is an identity mapping ([01-analysis-r1.md](01-analysis-r1.md) §2.1). The `?? providerName` fallback at [src/providers/router.ts](../../../../src/providers/router.ts#L174) already covers the identity case for unmapped names. So the design question is not "which row do we delete" but "do we keep the indirection at all".

Project rules: architecture-first, no backward-compat shims, remove dead code aggressively, no over-engineering, no speculative seams.

## 2. Proposal A (recommended) — Delete the map entirely

### 2.1 Change shape

Delete [src/providers/router.ts](../../../../src/providers/router.ts#L60-L69) (the JSDoc-style header comment plus the entire `PROVIDER_TO_OAUTH` constant) and replace [src/providers/router.ts](../../../../src/providers/router.ts#L174) with a direct use of `providerName`:

```
async resolveApiKey(
  providerName: string,
  options: { authProfileKey?: string; accountRef?: string } = {},
): Promise<string | null> {
  // …
  // const oauthId = PROVIDER_TO_OAUTH[providerName] ?? providerName;
  // becomes:
  // (just use providerName)
```

Every downstream use of `oauthId` in `resolveApiKey` ([src/providers/router.ts](../../../../src/providers/router.ts#L184-L199)) is renamed back to `providerName` (the input parameter). Bodies stay structurally identical.

### 2.2 Why this is right

- The indirection was only ever there for the one dead rename. With it gone, the indirection is dead.
- Keeping an identity-only map after the cleanup is "a comment in code" — it whispers that the OAuth id space might diverge from the provider name space when, in fact, it does not. Future drift is best caught by the OAuth profile loader rejecting unknown ids, not by a vestigial rename table.
- Aligns with G20's pattern (delete, don't preserve) and G21's direction of travel (consolidate provider names into a single descriptor table).
- Strictly local: one constant gone, one identifier renamed inside one method.

### 2.3 Tradeoffs

| Concern | Outcome |
|---|---|
| Future provider whose name differs from its OAuth id | If/when it appears, G21's `ProviderDescriptor` is the right home for an optional `oauthId` field — already filed as `F-G21-OAUTH-IN-DESCRIPTOR` in [G21/03-plan-r1.md](../G21/03-plan-r1.md) §"Followups". G22 should not pre-build that seam. |
| Reader who searches for the rename | The git log carries it; the `01-analysis-r1.md` of this finding documents why it was removed. |
| Concurrent G36 (moves the map) | G36 becomes moot for the constant and only needs its `oauthId`-resolution helper relocated; G22's APPROVED.md will flag this so G36 r2 can adapt. |
| Concurrent G21 (descriptor table) | Disjoint lines. G21 r1 already documents that `PROVIDER_TO_OAUTH` is G22's seam ([G21/03-plan-r1.md](../G21/03-plan-r1.md) §1.1 sidebar). |

### 2.4 Behavioural delta

None for canonical names. The only previously-possible behavioural change was for a caller passing `"copilot"`, which produced an OAuth resolution against the `github-copilot` profile family while `createProvider`'s switch ([src/providers/router.ts](../../../../src/providers/router.ts#L766-L772)) would have failed to register the provider — i.e. the OAuth half-resolved while the provider half did not, which is exactly the latent footgun the finding flags. After Proposal A, that footgun is removed.

## 3. Proposal B — Delete only the `"copilot"` row

### 3.1 Change shape

Delete [src/providers/router.ts](../../../../src/providers/router.ts#L68) (`"copilot": "github-copilot",`). Leave the surrounding constant and its read site at [src/providers/router.ts](../../../../src/providers/router.ts#L174) untouched.

### 3.2 Why one might prefer this

- Minimal diff; reviewer effort lowest.
- Preserves the "shape" of the map in case G21/G36 want to extend it with a non-identity entry.

### 3.3 Why we still reject it

- The map after this edit is three identity rows — definitionally dead code by the project's own rule ("remove dead code aggressively"). The finding's own evidence already calls the map "the source of truth for which OAuth flow to fire", a description that becomes false the instant every row is identity.
- It leaves a comment-in-code seam ("we might rename providers again") that the project rules explicitly forbid ("no migration shims", "no speculative seams").
- It guarantees future churn: G21 or G36 will revisit and almost certainly delete the map then; doing it twice is more conversational and operator overhead than doing it once now.

## 4. Recommendation

**Proposal A**. The map's only non-identity row is the dead one; removing the row and not the map preserves a misleading abstraction whose only purpose has just been deleted.

## 5. Acceptance criteria

- [src/providers/router.ts](../../../../src/providers/router.ts) no longer mentions `PROVIDER_TO_OAUTH` or the `"copilot"` literal.
- `resolveApiKey` passes the original `providerName` argument to `getOAuthApiKey` and `getProfileByKey` checks.
- No other file changes (tests already use canonical names — [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L441-L442)).
- `npx tsc --noEmit`, `npm run lint`, `npx vitest run src/providers/router.test.ts`, and `npx vitest run` all pass.
- Build (`npm run build`) succeeds.

## 6. Followups (not in this batch)

- **F-G22-COPILOT-PROVIDER-NAME** — align `CopilotProvider.name = "copilot"` ([src/providers/copilot.ts](../../../../src/providers/copilot.ts#L104)) with the canonical routing key `"github-copilot"`. Out of scope; touches error-message text and CLI banners. File as a new finding.
- **G36 reconciliation** — once G22 lands, G36's plan ([G36/03-plan-r1.md](../G36/03-plan-r1.md)) needs to drop the "move the map" step and reformulate as "expose the OAuth-id lookup helper from `src/auth/` if any future provider diverges from its OAuth id". Owner of G36 to revise at r2.
- **G21 ProviderName union** — if/when G21 lands, the type of `resolveApiKey`'s `providerName` parameter can be tightened from `string` to G21's `ProviderName` union. Out of scope for G22.
