# F13 — Plan (r3)

## Changes from r2

- **Anthropic classifier rewritten to use `APIError.type`** (the typed direct field), not the non-existent `err.error?.error?.type` walk. Each Anthropic branch now reads `err.type` and `err.status` only; `err.message` is consulted exclusively as the input to `ORPHANED_TOOL_RESULT_RE` inside the 400 branch. See [node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L12-L14) for the field shape; `APIError.error` is a JSON body `Object` ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L9-L10)) and is not read.
- **`Headers.get(...)` everywhere `retry-after` is read.** Both Anthropic and OpenAI SDK errors type `.headers` as a Web `Headers` object ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L7-L8), [node_modules/openai/core/error.d.ts](node_modules/openai/core/error.d.ts#L7-L8)). The plan reads `err.headers?.get("retry-after")`, OpenAI's `err.headers?.get("retry-after-ms")`, and Anthropic's `err.headers?.get("anthropic-ratelimit-requests-reset")` / `err.headers?.get("anthropic-ratelimit-tokens-reset")`. The `parseRetryAfter` helper accepts `string | null` (the return type of `Headers.get`) and returns `number | undefined` ms.
- **`instanceof` runtime imports made explicit.** Under `verbatimModuleSyntax` ([tsconfig.json](tsconfig.json#L18)), `instanceof Anthropic.APIError` / `instanceof OpenAI.APIError` require runtime value imports. `src/providers/error.ts` uses `import Anthropic from "@anthropic-ai/sdk";` and `import OpenAI from "openai";` (default value imports, matching [src/providers/anthropic.ts](src/providers/anthropic.ts#L1) / [src/providers/openai.ts](src/providers/openai.ts#L1)) and narrows via `err instanceof Anthropic.APIError` / `err instanceof OpenAI.APIError`. No `import type { APIError }` — that would be erased and break `instanceof`.
- **Router `callProvider` scoping fix.** The previous snippet referenced `providerName` in the `catch` block at [src/providers/router.ts](src/providers/router.ts#L417), but `providerName` is currently declared **inside** the success branch at [src/providers/router.ts](src/providers/router.ts#L395) and is not visible in the `catch`. The plan now hoists `const { provider: providerName } = parseModelId(spec);` to the top of `callProvider` (before the `try`), and the catch passes that binding to `classifyProviderError`. The existing declaration inside the success branch is deleted; the success branch reuses the hoisted name.

---

Plan covers **Proposal B** (typed `ProviderError` classified at the provider boundary). Single PR, single commit.

## Ordered edit steps

1. **Create `src/providers/error.ts`.**
   - Imports (runtime values for `instanceof`, matching existing adapter style):

     ```ts
     import Anthropic from "@anthropic-ai/sdk";
     import OpenAI from "openai";
     ```

   - Export `type ProviderErrorKind = "context_overflow" | "orphaned_tool_result" | "throttling" | "non_retryable" | "transient";`.
   - Export `interface ProviderErrorInit { kind; message; status?; retryAfterMs?; providerName?; cause? }`.
   - Export `class ProviderError extends Error` with readonly `kind`, `status?`, `retryAfterMs?`, `providerName?`. Constructor sets `this.name = "ProviderError"` and `this.cause = init.cause` (preserving the chain so `Anthropic.APIError` / `OpenAI.APIError` stay reachable from tests).
   - Define a file-local `ORPHANED_TOOL_RESULT_RE`:

     ```ts
     const ORPHANED_TOOL_RESULT_RE =
       /tool_use_id["' ]?(?:not found|did not match|without)|tool_use ids? (?:were|was) found without (?:tool_result|`tool_result`)|tool_result.{0,40}(?:not found|without (?:a )?(?:matching )?tool_use)|unexpected (?:`tool_result`|tool_result) block|tool_call_id.{0,40}(?:not found|did not match|without)/i;
     ```

     It is the only message-regex classifier in the redesign, and it is consulted only from inside `classifyProviderError` before mapping 400 / `invalid_request_error` to `non_retryable`.
   - Helper:

     ```ts
     // Accepts the return type of Headers.get (string | null) and a few known formats.
     function parseRetryAfter(value: string | null): number | undefined {
       if (!value) return undefined;
       // Pure seconds.
       const asNum = Number(value);
       if (Number.isFinite(asNum) && asNum >= 0) return Math.floor(asNum * 1000);
       // HTTP-date or RFC 3339 timestamp.
       const t = Date.parse(value);
       if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
       return undefined;
     }
     // OpenAI's `retry-after-ms` is already in milliseconds.
     function parseRetryAfterMs(value: string | null): number | undefined {
       if (!value) return undefined;
       const ms = Number(value);
       return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : undefined;
     }
     ```

   - Export `classifyProviderError(err: unknown, providerName: string): ProviderError`:
     - If `err instanceof ProviderError`, return it unchanged (idempotent).
     - **`err instanceof Anthropic.APIError`** — read `err.status`, `err.type`, `err.message`, `err.headers` only:
       - `retryAfterMs = parseRetryAfter(err.headers?.get("retry-after") ?? null) ?? parseRetryAfter(err.headers?.get("anthropic-ratelimit-requests-reset") ?? null) ?? parseRetryAfter(err.headers?.get("anthropic-ratelimit-tokens-reset") ?? null);`
       - `err.type === "rate_limit_error"` or `err.status === 429` → `throttling`.
       - `err.type === "overloaded_error"` → `throttling`.
       - `err.type === "authentication_error"` or `err.type === "permission_error"` → `non_retryable`.
       - `err.type === "not_found_error"` → `non_retryable`.
       - `err.status === 413` → `context_overflow`.
       - `err.type === "invalid_request_error"` or `err.status === 400`:
         - If `ORPHANED_TOOL_RESULT_RE.test(err.message)` → `orphaned_tool_result`.
         - Else if `err.message` matches `/context.{0,20}(window|length)|prompt is too long|maximum context length|input is too long for the model/i` → `context_overflow` (Anthropic surfaces overflow as 400 / invalid_request_error with these phrasings).
         - Else → `non_retryable`.
       - `err.status` between 500 and 599 → `transient`.
       - Default → `transient`.
     - **`err instanceof OpenAI.APIError`** — read `err.status`, `err.code`, `err.type`, `err.message`, `err.headers` only:
       - `retryAfterMs = parseRetryAfterMs(err.headers?.get("retry-after-ms") ?? null) ?? parseRetryAfter(err.headers?.get("retry-after") ?? null);`
       - `err.code === "context_length_exceeded"` → `context_overflow`.
       - `err.status === 429` → `throttling`.
       - `err.code === "content_filter"` → `non_retryable`.
       - `err.status === 401` / `403` / `404` → `non_retryable`.
       - `err.code === "invalid_request_error"` or `err.status === 400`:
         - If `ORPHANED_TOOL_RESULT_RE.test(err.message)` → `orphaned_tool_result`.
         - Else if `err.message` matches the same context-overflow phrasings as the Anthropic 400 branch → `context_overflow`.
         - Else → `non_retryable`.
       - `err.status` between 500 and 599 → `transient`.
       - Default → `transient`.
     - **Raw `Error`** (e.g. from `openai-codex.ts` failure paths that have not yet been migrated to a direct `ProviderError` throw, plus `pi-ai.ts`): parse a leading `Codex API <N>: ` prefix with `/^Codex API (\d{3}):\s*/` for a status code and apply the same status-code map (429 → throttling, 400 → orphan-or-non-retryable, 401/403/404 → non_retryable, 5xx → transient). The 400 branch still runs `ORPHANED_TOOL_RESULT_RE` against the message body. Fall back to `transient`.
     - On no match: `kind: "transient"`.
   - Strict TypeScript-friendly: parameters are `unknown`; narrowing is via `instanceof` against the namespaced runtime classes. No `as any`. No index-access on `Headers`.

2. **Wrap throw sites in each provider adapter.**
   - [src/providers/anthropic.ts](src/providers/anthropic.ts): wrap the `this.client.messages.create(...)` body in `try { ... } catch (err) { throw classifyProviderError(err, "anthropic"); }`.
   - [src/providers/openai.ts](src/providers/openai.ts): same around `this.client.chat.completions.create(...)`. Add `protected classify(err: unknown): never { throw classifyProviderError(err, this.name); }` so OpenRouter / Ollama / llama.cpp inherit the wrap without overrides; `this.name` carries the correct subclass identity.
   - [src/providers/copilot.ts](src/providers/copilot.ts): wrap both `chatResponses` and `chatOpenAI`. The Anthropic-via-Copilot branch (`this.anthropicClient.messages.create`) uses the same wrap with `providerName: "copilot"`.
   - [src/providers/openai-codex.ts](src/providers/openai-codex.ts): replace the four bare `throw new Error(...)` sites ([src/providers/openai-codex.ts](src/providers/openai-codex.ts#L137), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L251), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L257), and the wrap at the top of `chat`) with `throw classifyProviderError(err, "openai-codex")`. For the `Codex API ${status}` site, construct a `ProviderError` directly with `kind` derived from `status` and the response-body slice as `message`, so the status is preserved without re-parsing the message.
   - [src/providers/pi-ai.ts](src/providers/pi-ai.ts): the two bare throws become `throw new ProviderError({ kind: "non_retryable", message, providerName: this.name })` for the unknown-model case and `classifyProviderError(err, this.name)` for the `result.stopReason === "error"` case (with the inner errorMessage carried in `cause`).

3. **Router cleanup.**
   - In [src/providers/router.ts](src/providers/router.ts), `callProvider`:
     - **Hoist** `const { provider: providerName } = parseModelId(spec);` to the top of `callProvider`, immediately before the `try` block (currently at [src/providers/router.ts](src/providers/router.ts#L387)). The existing declaration inside the success branch at [src/providers/router.ts](src/providers/router.ts#L395) is deleted; the `return { ok: true, ... }` body reuses the hoisted `providerName`. This makes `providerName` visible in the `catch` block, which is what the new classification needs.
     - Replace the `nonRetryable = errMsg.includes("exceeds the context window") || errMsg.includes("context_length_exceeded")` block ([src/providers/router.ts](src/providers/router.ts#L412-L414)) with:

       ```ts
       const classified = error instanceof ProviderError
         ? error
         : classifyProviderError(error, providerName);
       const shortCircuit =
         classified.kind === "non_retryable" ||
         classified.kind === "context_overflow" ||
         classified.kind === "orphaned_tool_result";
       return { ok: false, error: classified, nonRetryable: shortCircuit };
       ```

       The `providerName` referenced here is the hoisted binding from the top of `callProvider`, not the (now-deleted) success-branch one.
   - Aggregate wrap at [src/providers/router.ts](src/providers/router.ts#L357-L360):
     - Hoist `let lastProviderName: string | undefined` at the top of `chat()` alongside `let lastError`.
     - In the candidate loop, after `const { provider: providerName, model } = parseModelId(spec);` (the existing parse at [src/providers/router.ts](src/providers/router.ts#L290)), when the call result is a failure (the same point where `lastError = result.error;` is assigned at [src/providers/router.ts](src/providers/router.ts#L355)), also set `lastProviderName = providerName;`.
     - Replace the final wrap with:

       ```ts
       const lastKind = lastError instanceof ProviderError ? lastError.kind : "transient";
       throw new ProviderError({
         kind: lastKind,
         message: `${summary}: ${lastError.message}`,
         cause: lastError,
         providerName: lastProviderName,
       });
       ```

       This preserves the kind across the wrap so BaseAgent's switch still classifies correctly; `lastProviderName` is the loop-scoped variable from `chat()` (not a reference into `callProvider`'s body).

4. **BaseAgent cleanup.**
   - Delete `CONTEXT_OVERFLOW_RE`, `ORPHANED_TOOL_RE`, `NON_RETRYABLE_RE`, `THROTTLING_RE`, and the four `is*Error` helpers ([src/agents/base.ts](src/agents/base.ts#L872-L891)).
   - In the `catch (err)` block at [src/agents/base.ts](src/agents/base.ts#L513), replace the regex sequence with:

     ```ts
     const pe = err instanceof ProviderError
       ? err
       : new ProviderError({
           kind: "transient",
           message: err instanceof Error ? err.message : String(err),
           cause: err,
         });
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
     // existing nonThrottleAttempts cap, backoff with optional pe.retryAfterMs clamp
     ```

   - **Out of scope for F13**: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) (`consecutive invalid tool calls` throw) and the two `"Agent cancelled"` throws at [src/agents/base.ts](src/agents/base.ts#L489) and [src/agents/base.ts](src/agents/base.ts#L861). Per analysis r2, none of these reach `callLLM`'s `catch` in practice, so they stay raw `Error`s; converting them would expand scope without changing observable behaviour.
   - Backoff clamp: when `pe.retryAfterMs` is present, use `Math.max(pe.retryAfterMs, BASE_DELAY_S * 1000)` capped at `MAX_DELAY_S * 1000` for the next sleep; otherwise keep the existing exponential schedule.

5. **Barrel.**
   - Add `export { ProviderError, type ProviderErrorKind, classifyProviderError } from "./error.js";` to [src/providers/index.ts](src/providers/index.ts). (F19 will still need to do the full audit; this change keeps the new export discoverable.)

6. **`truncateDiagnostic` helper** — already used by [src/agents/base.ts](src/agents/base.ts#L866-L868). No change needed; it stays in `base.ts` and is reused for the diagnostic body.

## Test strategy

Existing tests that should continue to pass (regression):

- [src/providers/router.test.ts](src/providers/router.test.ts) — failover, sticky failover, health backoff. Fixtures that today `throw new Error("primary unavailable")` will be classified as `transient` (default) and behave identically.
- [src/providers/openai-codex.test.ts](src/providers/openai-codex.test.ts) — SSE parsing.
- [src/providers/copilot.test.ts](src/providers/copilot.test.ts) — chat completions / responses paths.
- [src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts) — compaction loop must still fire on `context_overflow` and on `orphaned_tool_result`.

New tests:

- **`src/providers/error.test.ts`**:
  - Construct `Anthropic.APIError` instances via `Anthropic.APIError.generate(status, body, message, headers)` (the public factory at [node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L17)) so that `err.type`, `err.status`, and `err.headers` are populated as the runtime SDK would populate them. For each of `overloaded_error`, `rate_limit_error`, `invalid_request_error` (generic body), `authentication_error`, `not_found_error`, assert `classifyProviderError` returns the right `kind`.
  - `classifyProviderError(Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "..." } }, "messages.3: 'tool_use_id' not found in 'tool_use' block", new Headers()))` → `kind: "orphaned_tool_result"`.
  - Same shape with message `"Unexpected 'tool_result' block at index 5"` → `kind: "orphaned_tool_result"`.
  - Same shape with message `"unsupported parameter: temperature"` → `kind: "non_retryable"` (orphan regex does not match).
  - Same shape with message `"prompt is too long: 250000 tokens > 200000 maximum"` → `kind: "context_overflow"`.
  - Same orphan-vs-non-retryable matrix for `OpenAI.APIError.generate(400, ...)` with `code === "invalid_request_error"`, including a `"tool_call_id 'call_abc' not found"` fixture → `orphaned_tool_result`.
  - `classifyProviderError` reads `retry-after` via `Headers.get`: build `new Headers({ "retry-after": "30" })`, attach to a 429 `Anthropic.APIError`, assert `retryAfterMs === 30000`. Build `new Headers({ "retry-after-ms": "4500" })`, attach to a 429 `OpenAI.APIError`, assert `retryAfterMs === 4500`. Build `new Headers({ "anthropic-ratelimit-requests-reset": "<ISO-8601 timestamp ~5s in future>" })`, attach to a 429 `Anthropic.APIError` with no plain `retry-after`, assert `retryAfterMs > 0`.
  - Raw `Error("Codex API 429: ...")` → `throttling`; `Error("Codex API 400: tool_use_id not found")` → `orphaned_tool_result`; `Error("Codex API 400: bad request")` → `non_retryable`; `Error("Codex API 500: ...")` → `transient`.
  - `classifyProviderError(new ProviderError({kind: "throttling", ...}))` is idempotent.
  - Unknown string → `transient`.
- **`src/providers/router.test.ts`** (extend):
  - A candidate that throws a `non_retryable` `ProviderError` short-circuits the chain (existing semantics).
  - A candidate that throws a `context_overflow` `ProviderError` short-circuits the chain (regression on today's `String.includes` check).
  - A candidate that throws an `orphaned_tool_result` `ProviderError` short-circuits the chain (new behaviour: does not exhaust failover).
  - The router-wrap preserves `kind` through the aggregate wrap, and the aggregate's `providerName` equals the last-failing candidate's parsed provider name.
- **`src/agents/base.error.test.ts`** (new, sibling to `base.compaction.test.ts`): drives a stub router that throws each `ProviderError` kind and asserts:
  - `context_overflow` triggers `compactWithReinjection` and immediate retry, no backoff delay.
  - `orphaned_tool_result` same.
  - `non_retryable` propagates without retry.
  - `throttling` does **not** increment `nonThrottleAttempts`; loop continues past `transientCap`.
  - `throttling` with `retryAfterMs = 5000` waits at least 5000 ms (clamped to `BASE_DELAY_S`).
  - `transient` increments the cap and aborts at `transientCap`.
  - A raw `new Error("anything")` is treated as `transient` (safe default).
  - Regression: an `Error` whose message contains `"capacity"` is **no longer** treated as throttling (it is `transient`, will be capped).

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
