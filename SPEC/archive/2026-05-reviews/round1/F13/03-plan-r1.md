# F13 — Plan (r1)

Plan covers **Proposal B** (typed `ProviderError` classified at the provider boundary). Single PR, single commit.

## Ordered edit steps

1. **Create `src/providers/error.ts`.**
   - Export `type ProviderErrorKind = "context_overflow" | "orphaned_tool_result" | "throttling" | "non_retryable" | "transient";`.
   - Export `interface ProviderErrorInit { kind; message; status?; retryAfterMs?; providerName?; cause? }`.
   - Export `class ProviderError extends Error` with readonly `kind`, `status?`, `retryAfterMs?`, `providerName?`. Constructor sets `this.name = "ProviderError"` and `this.cause = init.cause` (preserving the chain so `Anthropic.APIError` / `OpenAI.APIError` stay reachable from tests).
   - Export `classifyProviderError(err: unknown, providerName: string): ProviderError`:
     - If `err instanceof ProviderError`, return it (no re-wrapping).
     - If `Anthropic.APIError` (import the type from `@anthropic-ai/sdk`): switch on `err.error?.error?.type`: `invalid_request_error` → `non_retryable`; `authentication_error` / `permission_error` → `non_retryable`; `rate_limit_error` → `throttling`; `overloaded_error` → `throttling`; `not_found_error` → `non_retryable`. If `err.status === 413` or message contains `context_length_exceeded` / `prompt is too long` / `maximum context length` / `input.{0,20}too long` → `context_overflow`. `5xx` → `transient`. `429` → `throttling`. Read `err.headers?.["retry-after"]` and `anthropic-ratelimit-requests-reset` for `retryAfterMs`.
     - If `OpenAI.APIError` (from `openai`): same shape: `err.code === "context_length_exceeded"` or `err.type === "tokens"` → `context_overflow`; `err.code === "invalid_request_error"` or `err.status === 400` / `401` / `403` / `404` → `non_retryable`; `err.code === "content_filter"` → `non_retryable`; `err.status === 429` → `throttling`; `5xx` → `transient`. Read `err.headers?.["retry-after"]` / `retry-after-ms`.
     - Otherwise (raw `Error`, e.g. from `openai-codex.ts`, `pi-ai.ts`): parse the message for the leading status-code pattern `Codex API <N>: ` and apply the same status-code mapping; fall back to `transient`.
     - On no match: `kind: "transient"`.
   - Include a small `parseRetryAfter(header: string | undefined): number | undefined` helper (supports seconds and HTTP-date).
   - Strict TypeScript-friendly (no `any`); use `unknown` and structural narrowing.

2. **Wrap throw sites in each provider adapter.**
   - [src/providers/anthropic.ts](src/providers/anthropic.ts): wrap the `this.client.messages.create(...)` body in `try/catch` that rethrows `classifyProviderError(err, "anthropic")`.
   - [src/providers/openai.ts](src/providers/openai.ts): same around `this.client.chat.completions.create(...)`. Add `private classify(err): never { throw classifyProviderError(err, this.name); }` so OpenRouter / Ollama / llama.cpp inherit the wrap without overrides; `this.name` carries the correct subclass identity.
   - [src/providers/copilot.ts](src/providers/copilot.ts): wrap both `chatResponses` and `chatOpenAI`. The Anthropic-via-Copilot branch (`this.anthropicClient.messages.create`) uses the same wrap.
   - [src/providers/openai-codex.ts](src/providers/openai-codex.ts): replace the four bare `throw new Error(...)` sites ([src/providers/openai-codex.ts](src/providers/openai-codex.ts#L137), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L251), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L257), and the top of `chat`) with `throw classifyProviderError(err, "openai-codex")` — for the `Codex API ${status}` site, throw a `ProviderError` directly so `status` is preserved without re-parsing the message.
   - [src/providers/pi-ai.ts](src/providers/pi-ai.ts): the two bare throws become `throw new ProviderError({ kind: "non_retryable", message, providerName: this.name })` for the unknown-model case and `classifyProviderError(err, this.name)` for the `result.stopReason === "error"` case (with the inner errorMessage carried in `cause`).

3. **Router cleanup.**
   - In [src/providers/router.ts](src/providers/router.ts), `callProvider`: replace the `nonRetryable = errMsg.includes("exceeds the context window") || errMsg.includes("context_length_exceeded")` block ([src/providers/router.ts](src/providers/router.ts#L412-L414)) with:
     - `const classified = error instanceof ProviderError ? error : classifyProviderError(error, providerName);`
     - `return { ok: false, error: classified, nonRetryable: classified.kind === "non_retryable" || classified.kind === "context_overflow" };`
   - Replace the final wrap at [src/providers/router.ts](src/providers/router.ts#L357-L360) with `throw new ProviderError({ kind: lastError instanceof ProviderError ? lastError.kind : "transient", message: \`${summary}: ${lastError.message}\`, cause: lastError, providerName });`. This preserves the `kind` through the wrap so BaseAgent can still classify correctly even when sticky failover wrapped the error.

4. **BaseAgent cleanup.**
   - Delete `CONTEXT_OVERFLOW_RE`, `ORPHANED_TOOL_RE`, `NON_RETRYABLE_RE`, `THROTTLING_RE`, and the four `is*Error` helpers ([src/agents/base.ts](src/agents/base.ts#L872-L891)).
   - In the `catch (err)` block at [src/agents/base.ts](src/agents/base.ts#L513), replace the regex sequence with:

```ts
const pe = err instanceof ProviderError ? err : new ProviderError({ kind: "transient", message: err instanceof Error ? err.message : String(err), cause: err });
const msg = pe.message;

if (pe.kind === "context_overflow" || pe.kind === "orphaned_tool_result") {
  /* existing compact-and-retry block, with `reason` derived from pe.kind */
}

if (pe.kind === "non_retryable") {
  this.pendingCall = null;
  this.pendingRoundId = null;
  throw pe;
}

const throttled = pe.kind === "throttling";
// ... existing nonThrottleAttempts cap, backoff with optional pe.retryAfterMs clamp
```

   - Where BaseAgent itself throws internal sentinels (`"Agent cancelled"`, `"Consecutive invalid tool calls reached"`), wrap them as `new ProviderError({ kind: "non_retryable", ... })` so the classification surface is uniform. For the cancellation, this is at [src/agents/base.ts](src/agents/base.ts#L489-L492); for invalid tool calls, in the dispatch path inside `runLoop` (search for `consecutive invalid`).
   - Backoff clamp: when `pe.retryAfterMs` is present, use `Math.max(pe.retryAfterMs, BASE_DELAY_S * 1000)` capped at `MAX_DELAY_S * 1000` for the next sleep; otherwise keep the existing exponential schedule.

5. **Barrel.**
   - Add `export { ProviderError, type ProviderErrorKind, classifyProviderError } from "./error.js";` to [src/providers/index.ts](src/providers/index.ts). (F19 will still need to do the full audit; this change keeps the new export discoverable.)

6. **Move the `truncateDiagnostic` helper** — already used by [src/agents/base.ts](src/agents/base.ts#L866-L868). No change needed; it stays in `base.ts` and is reused for the diagnostic body.

## Test strategy

Existing tests that should continue to pass (regression):

- [src/providers/router.test.ts](src/providers/router.test.ts) — failover, sticky failover, health backoff. The fixtures that today `throw new Error("primary unavailable")` will be classified as `transient` (default) and behave identically.
- [src/providers/openai-codex.test.ts](src/providers/openai-codex.test.ts) — SSE parsing.
- [src/providers/copilot.test.ts](src/providers/copilot.test.ts) — chat completions / responses paths.
- [src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts) — compaction loop must still fire on `context_overflow`.

New tests:

- **`src/providers/error.test.ts`**:
  - `classifyProviderError(new Anthropic.APIError(...))` for each of `overloaded_error`, `rate_limit_error`, `invalid_request_error`, `authentication_error` returns the right `kind`.
  - `classifyProviderError` parses `retry-after: 30` to `retryAfterMs: 30_000` and HTTP-date `retry-after: <date>` correctly.
  - Same matrix for `OpenAI.APIError`.
  - Raw `Error("Codex API 429: ...")` → `throttling`; `Error("Codex API 400: ...")` → `non_retryable`; `Error("Codex API 500: ...")` → `transient`.
  - `classifyProviderError(new ProviderError({kind: "throttling", ...}))` is idempotent.
  - Unknown string → `transient`.
- **`src/providers/router.test.ts`** (extend): a candidate that throws a `non_retryable` `ProviderError` short-circuits the chain (existing `nonRetryable` semantics); a candidate that throws `context_overflow` short-circuits the chain (regression on today's `String.includes` check). The router-wrap preserves `kind` through the `Error.cause`.
- **`src/agents/base.error.test.ts`** (new, sibling to `base.compaction.test.ts`): drives a stub router that throws each `ProviderError` kind and asserts:
  - `context_overflow` triggers `compactWithReinjection` and immediate retry, no backoff delay.
  - `orphaned_tool_result` same.
  - `non_retryable` propagates without retry.
  - `throttling` does **not** increment `nonThrottleAttempts`; loop continues past `transientCap`.
  - `throttling` with `retryAfterMs = 5000` waits at least 5000 ms (clamped to `BASE_DELAY_S`).
  - `transient` increments the cap and aborts at `transientCap`.
  - A raw `new Error("anything")` is treated as `transient` (safe default).
  - The regression cases from the F13 finding: an `Error` whose message contains `"capacity"` is **no longer** treated as throttling (it is `transient`, will be capped).

Validation commands:

```bash
npm run typecheck
npm run build
npx vitest run src/providers/error.test.ts
npx vitest run src/providers/router.test.ts
npx vitest run src/agents/base.error.test.ts src/agents/base.compaction.test.ts
npx vitest run                # full suite before commit
```

## Rollback strategy

Single commit. `git revert` restores the four regex helpers, the duplicated router check, and the raw throws in adapters in one shot. No on-disk state, no schema changes, no migration of `.saivage/` content — purely in-process error handling.

## Cross-issue ordering

- **Must land before F19** (provider barrel cleanup) so the new `ProviderError` export is included in the audit.
- **Independent of F09**: F09's `WorkerAgentBase` extraction does not touch `callLLM`'s error path; ordering between them is free.
- **Independent of F03**: same parser/error-classification distinction.
- **Loosely coupled to F07**: F07 (token estimation) tightens the *pre-call* estimator; F13 fixes the *post-call* classifier. They can land in either order; together they close the overflow detection loop.
- **Independent of F25** (prompt-injection-cop regex FP): that issue's regex is on retrieved-content sanitation, not provider-error classification.
