# G22 — Plan (round 1)

**Writer**: Claude Opus 4.7. Implements Proposal A from [02-design-r1.md](02-design-r1.md).
**Scope**: single-file edit in [src/providers/router.ts](../../../../src/providers/router.ts). No test file, prompt, doc, or config is touched.

## 0. Preconditions

- Working tree on `saivage` clean, or only G22-scoped edits pending.
- G20 landed (APPROVED, [G20/APPROVED.md](../G20/APPROVED.md)) — already verified via the unchanged `knownProviders` literal at [src/providers/router.ts](../../../../src/providers/router.ts#L105-L114).
- No concurrent in-flight edit to [src/providers/router.ts](../../../../src/providers/router.ts) from G21 or G36 (both are still at r1 in [G21/](../G21/) and [G36/](../G36/) at the time of writing). If either lands first, redo the line-number anchors below against the new revision before applying.

## 1. Edits

All edits in [src/providers/router.ts](../../../../src/providers/router.ts).

### 1.1 Remove the `PROVIDER_TO_OAUTH` constant and its header comment

Delete [src/providers/router.ts](../../../../src/providers/router.ts#L60-L69), which today reads:

```
/**
 * Maps Saivage provider names -> OAuth provider IDs (for resolveApiKey).
 */
const PROVIDER_TO_OAUTH: Record<string, string> = {
  "openai-codex": "openai-codex",
  "anthropic": "anthropic",
  "github-copilot": "github-copilot",
  "copilot": "github-copilot",
};
```

Result: the file goes directly from the `recordLlmCall` helper at [src/providers/router.ts](../../../../src/providers/router.ts#L55-L58) to `export class ModelRouter` at [src/providers/router.ts](../../../../src/providers/router.ts#L71). Adjust the single blank line between them so there is exactly one blank line between the helper and the class declaration.

### 1.2 Inline the identity in `resolveApiKey`

In `resolveApiKey` ([src/providers/router.ts](../../../../src/providers/router.ts#L169-L201)):

- Delete [src/providers/router.ts](../../../../src/providers/router.ts#L174):

  ```
  const oauthId = PROVIDER_TO_OAUTH[providerName] ?? providerName;
  ```

- Replace every remaining use of `oauthId` inside the method body with the existing parameter name `providerName`:

  - [src/providers/router.ts](../../../../src/providers/router.ts#L188): `if (explicitProfile?.provider === oauthId)` becomes `if (explicitProfile?.provider === providerName)`.
  - [src/providers/router.ts](../../../../src/providers/router.ts#L189): `getOAuthApiKey(oauthId, …)` becomes `getOAuthApiKey(providerName, …)`.
  - [src/providers/router.ts](../../../../src/providers/router.ts#L194): `getOAuthApiKey(oauthId, …)` becomes `getOAuthApiKey(providerName, …)`.
  - [src/providers/router.ts](../../../../src/providers/router.ts#L199): `return getOAuthApiKey(oauthId, { headers });` becomes `return getOAuthApiKey(providerName, { headers });`.

After this edit, the method body is structurally identical except for the deleted local and the rename.

### 1.3 Nothing else moves

- Do **not** touch [src/providers/router.ts](../../../../src/providers/router.ts#L102-L121) (`initProviders` / `knownProviders`) — that is G21's seam.
- Do **not** touch [src/providers/router.ts](../../../../src/providers/router.ts#L731-L754) (`shouldRegisterProvider`) — G21.
- Do **not** touch [src/providers/router.ts](../../../../src/providers/router.ts#L766-L772) (`createProvider` switch for `github-copilot`) — G21.
- Do **not** touch [src/providers/copilot.ts](../../../../src/providers/copilot.ts) — `CopilotProvider.name = "copilot"` at [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L104) is followup F-G22-COPILOT-PROVIDER-NAME ([02-design-r1.md](02-design-r1.md) §6).
- Do **not** add a `ProviderName` union, descriptor field, or any other type tightening — that is G21's seam ([02-design-r1.md](02-design-r1.md) §6).

## 2. Implementation order

1. Apply edit §1.1 (constant deletion).
2. Apply edit §1.2 (method rename) as a single `multi_replace_string_in_file` transaction to avoid leaving a half-deleted symbol that breaks `tsc` between steps.

Both edits together produce a single coherent diff confined to the top of [src/providers/router.ts](../../../../src/providers/router.ts) and the body of `resolveApiKey`.

## 3. Validation

Run in this order, in the saivage repo root (`/home/salva/g/ml/saivage`):

1. **Type-check**: `npx tsc --noEmit`. Expectation: zero errors. If `oauthId` is referenced anywhere else (it should not be — analysis confirmed single-method scope), `tsc` will surface it as `Cannot find name 'oauthId'`.
2. **Lint**: `npm run lint`. Expectation: zero new findings.
3. **Focused unit tests**: `npx vitest run src/providers/router.test.ts`. Must pass; existing tests at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L441-L442) and [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L471-L472) already exercise the canonical paths (`github-copilot`, `anthropic`) that this change keeps behaviourally identical.
4. **Full unit-test suite**: `npx vitest run`. Must pass with no new failures vs the pre-edit baseline.
5. **Build**: `npm run build` (the tsup + Vite bundle). Must succeed.

Do **not** snapshot-commit any test output. Do **not** add a new test — this is dead-code removal with full existing coverage on the surviving paths.

## 4. Operator-gated daemon restart

Functional behaviour does not change for any caller. A restart is **not** required for correctness.

If the operator wants the cleaned binary live on the v2 harness running on Saivage v3 (`saivage-v3` at 10.0.3.112, bind-mounting host `saivage/`), and only with explicit operator approval:

```
ssh root@10.0.3.112 'systemctl restart saivage.service \
  && sleep 4 \
  && systemctl is-active saivage.service \
  && curl -fsS http://127.0.0.1:8080/health'
```

Apply the same restart to `saivage` (10.0.3.111) and `diedrico` (10.0.3.113) only if the operator explicitly asks; both bind-mount `saivage/`. `saivage-v3-getrich-v2` (10.0.3.170) is unaffected and must not be touched.

## 5. Rollback

`git checkout -- src/providers/router.ts` reverts the change atomically. No on-disk artefact, profile store, or config field is altered, so no off-tree rollback is needed.

## 6. Followups to file after merge

- **F-G22-COPILOT-PROVIDER-NAME** — rename `CopilotProvider.name` ([src/providers/copilot.ts](../../../../src/providers/copilot.ts#L104)) from `"copilot"` to `"github-copilot"`, with audit of `classifyProviderError` ([src/providers/router.ts](../../../../src/providers/router.ts#L457)) error-text fixtures and the CLI login banner ([src/server/cli.ts](../../../../src/server/cli.ts#L426)).
- **G36 reconciliation** — flag in this finding's APPROVED.md that G36's "move `PROVIDER_TO_OAUTH`" step ([G36/03-plan-r1.md](../G36/03-plan-r1.md)) becomes vacuous; G36 owner adapts at r2.
- **G21 type tightening** — once G21 lands, tighten `resolveApiKey`'s `providerName: string` parameter to G21's `ProviderName` union. Out of scope for G22.
