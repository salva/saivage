# F05 — Implementation plan (R2)

Plan for **Proposal B** from [02-design-r2.md](02-design-r2.md): delete the supervisor's regex post-processor (`normalizeNonStuckOperationalVerdict` and its three `looksLike*` predicates), let the LLM verdict pass through unmodified after JSON+schema validation, and rewrite the two regex-validation tests to assert the new contract.

## Changes from r1

- **Accepted (reviewer required change 1).** Every `src/runtime/supervisor.ts` and `src/runtime/runtime.test.ts` anchor in the plan was re-verified against the live files (`wc -l src/runtime/supervisor.ts` → 272). Corrected throughout: normalizer call site L146 (was L154); normalizer body L222-L257 (was L220-L257); `looksLikeLongRunningExternalWork` L259-L264 (separated from the imprecise `L246-L257` lump); `looksLikeProviderThrottling` L266-L268; `looksLikeMalformedOrCrashed` L270-L272; `askModel` L125-L147 (was L122-L156); `maxTokens: 600` at L143 (was L153); system prompt L161-L168 (was L158-L168); `parseVerdict` L176-L202 (was L171-L201); `parseJsonObject` L204-L220 (was L204-L218); `getRecentLogs` block L126-L128 (was L123-L125). Test refs updated: throttling test L198-L224 (was L198-L225), long-running test L226-L252 (was L226-L253), happy-path test L117-L148 (was L116-L148), three-stuck test L149-L172 (was L150-L172), counter-resets test L174-L196 (was L173-L197).
- **Accepted (reviewer required change 2).** The sanity-grep command in Step 3 and in the "Concrete validation commands" section is fixed. The bad form `grep -nE '...' src/` (which errors with "Is a directory" on this host because `grep` without `-r` cannot descend into a directory) is replaced with the recursive form `rg -n '...' src` (preferred) and an equivalent `grep -RnE` fallback for environments without ripgrep.
- **Rejected:** none.

## Cross-issue ordering

- **Run after F03 if possible**. F03 ([SPEC/v2/review-2026-05/F03/03-plan-r1.md](../F03/03-plan-r1.md) Step 7) replaces `parseVerdict`'s body with a Zod-validated `parseLlmJsonAs(content, schema)` call and deletes the supervisor's private `parseJsonObject`. F05 deletes `normalizeNonStuckOperationalVerdict` and the three `looksLike*` predicates, plus removes the wrap call in `askModel`. The two edits touch the same file but disjoint functions; landing F03 first means F05's diff is minimal. If F05 lands first, it leaves `parseVerdict` calling the legacy `parseJsonObject` — still correct, just makes F03's subsequent diff one line bigger.
- **Run independent of F23**. F23 expands `ROLE_ABORT_PRIORITY`. Both fixes compose strictly positively: F05 makes verdicts reach the threshold; F23 makes the threshold reach the right targets. Either order works.
- **Run independent of F11**. F11 moves the supervisor's `DEFAULT_*` and `FORCE_CANCEL_DELAY_MS` constants into `SaivageConfig`. F05 deletes regex constants that are not in F11's table. Disjoint.
- **Run independent of F20**. F20 fixes provider `maxContextTokens`. The supervisor's `maxTokens: 600` ([supervisor.ts L143](../../../../src/runtime/supervisor.ts#L143)) is sufficient for the small JSON verdict and is not touched.
- **Run independent of F04**. F04 changes the default supervisor model. F05's behaviour assumes the chosen model follows its own system prompt; F04 picks which model that is. Disjoint.

## Step-by-step edits

### Step 1 — Delete `normalizeNonStuckOperationalVerdict` and the three `looksLike*` predicates

In [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts):

1. Delete the `normalizeNonStuckOperationalVerdict` function in its entirety ([L222-L257](../../../../src/runtime/supervisor.ts#L222-L257)). This is the function that runs Pass 1 + Pass 2 of the regex predicates.
2. Delete `looksLikeLongRunningExternalWork` ([L259-L264](../../../../src/runtime/supervisor.ts#L259-L264)).
3. Delete `looksLikeProviderThrottling` ([L266-L268](../../../../src/runtime/supervisor.ts#L266-L268)).
4. Delete `looksLikeMalformedOrCrashed` ([L270-L272](../../../../src/runtime/supervisor.ts#L270-L272)).

### Step 2 — Drop the wrap in `askModel`

In [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L146), change the final line of `askModel` from:

```ts
return normalizeNonStuckOperationalVerdict(parseVerdict(response.content, provider), logs);
```

to:

```ts
return parseVerdict(response.content, provider);
```

The local `const logs = ...` ([L126-L128](../../../../src/runtime/supervisor.ts#L126-L128)) is still needed for the user-message body just above ([L135](../../../../src/runtime/supervisor.ts#L135)). No other change to `askModel`.

### Step 3 — Sanity-grep for stragglers

After Steps 1-2, the only remaining references to the deleted symbols should be zero. From the repo root:

```bash
cd /home/salva/g/ml/saivage
rg -n 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src
```

If `rg` is unavailable, the equivalent recursive `grep` is:

```bash
grep -RnE 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src --include='*.ts'
```

Expected: empty output. The three helpers were module-private; pre-deletion verification was `rg -n 'looksLike(LongRunningExternalWork|ProviderThrottling|MalformedOrCrashed)' src` → only the definitions and their single in-module call site inside `normalizeNonStuckOperationalVerdict`.

### Step 4 — Rewrite the two regex-validation tests

In [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts):

#### Step 4a — Throttling test

The current test at [L198-L224](../../../../src/runtime/runtime.test.ts#L198-L224) feeds `{stuck: true, reason: "GitHub Copilot is returning 429 rate limit responses", evidence: ["provider throttling"]}` and expects no cancel because the post-processor flips it. Under Proposal B this test would now expect `cancel` to be called (the verdict is `stuck=true`, threshold reached, lowest-priority worker cancelled).

That is not the right test. The right test under Proposal B is: when the LLM returns `stuck=false` for the throttling scenario (which is what the system prompt instructs it to do), the supervisor does not cancel.

Rewrite the test body so the mocked router returns `{stuck: false, confidence: 0.9, reason: "Only clear issue is provider throttling; Saivage should wait and retry", evidence: ["429 rate limit"]}` and the assertion stays `expect(cancel).not.toHaveBeenCalled()`. Rename the test description to "does not cancel agents when the LLM verdict is stuck=false for provider throttling".

The test still validates the supervisor's policy on throttling — but now via the LLM verdict, not via post-processor regex.

#### Step 4b — Long-running work test

The same shape at [L226-L252](../../../../src/runtime/runtime.test.ts#L226-L252). Rewrite to feed `{stuck: false, confidence: 0.9, reason: "Only clear issue is a long-running training job; long-running work is not itself stuck", evidence: ["external process in progress"]}` and assert no cancel. Rename description to "does not cancel agents when the LLM verdict is stuck=false for long-running external work".

#### Step 4c — No test-fixture changes for the other three supervisor tests

[L117-L148](../../../../src/runtime/runtime.test.ts#L117-L148) (counter does not fire below threshold), [L149-L172](../../../../src/runtime/runtime.test.ts#L149-L172) (three consecutive stuck → cancel), and [L174-L196](../../../../src/runtime/runtime.test.ts#L174-L196) (counter resets on not-stuck) all feed verdicts whose `reason` does not match the deleted regex predicates. Their behaviour is unchanged.

### Step 5 — Verify the system prompt still correctly states the policy

[supervisor.ts L161-L168](../../../../src/runtime/supervisor.ts#L161-L168) already instructs the LLM to mark `stuck=false` for throttling / long-running / single-transient cases. No edit needed; just re-read the string to confirm the policy the post-processor was duplicating is fully present in the prompt. (Verified during the analysis pass.)

## Test strategy

### Existing tests touched

- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — the two regex-validation tests at [L198-L252](../../../../src/runtime/runtime.test.ts#L198-L252) change as described in Step 4. The other three supervisor tests are untouched and must keep passing.

### New tests

None. The two rewritten tests fully cover the new contract: "supervisor obeys the LLM verdict". A separate test asserting "the post-processor no longer flips verdicts" would be testing absence of behaviour and is redundant with the rewritten tests (those would fail today against the present supervisor.ts unless the post-processor were already gone).

### Targeted commands while iterating

```bash
cd /home/salva/g/ml/saivage
npx vitest run src/runtime/runtime.test.ts
```

### Validation pipeline

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run
```

`tsup` produces `dist/`; `npm run build` invokes it per `package.json`. No deploy-time impact beyond a standard rebuild.

## Rollback strategy

Single commit, easy revert. The deleted post-processor and predicates restore verbatim. The two rewritten tests revert alongside. No on-disk format changes, no config-schema changes, no provider-layer changes.

## Concrete validation commands

```bash
cd /home/salva/g/ml/saivage

# Step 3 sanity: deleted symbols are gone (use rg; falls back to grep -RnE if rg is unavailable)
rg -n 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src
# fallback without ripgrep:
# grep -RnE 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src --include='*.ts'

# Type, build, test
npm run typecheck
npm run build
npx vitest run src/runtime/runtime.test.ts
npx vitest run
```

Expected:

- `rg` (or the `grep -RnE` fallback) prints nothing.
- `npm run typecheck` exits clean (`tsconfig.json` strict).
- `npm run build` produces `dist/` without errors.
- All vitest runs green, including the two rewritten supervisor tests.
