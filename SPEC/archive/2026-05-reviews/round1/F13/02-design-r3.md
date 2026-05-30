# F13 — Design (r3)

## Changes from r2

- **Anthropic `APIError` field shape corrected.** The installed Anthropic SDK exposes the response body's `error.type` directly on the error class as `APIError.type` ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L12-L14)); `APIError.error` is typed only as the JSON body `Object` and is **not** the right field to read. The design now states that the classifier reads `err.type` (and `err.status`) for Anthropic, matching the SDK type definition. `err.error?.error?.type` is removed from the design entirely.
- **`Headers.get(...)` for retry-after extraction.** Both Anthropic and OpenAI SDK errors type `headers` as a Web `Headers` object ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L7-L8), [node_modules/openai/core/error.d.ts](node_modules/openai/core/error.d.ts#L7-L8)). Under `verbatimModuleSyntax` + `strict` ([tsconfig.json](tsconfig.json#L9-L18)) the index-access pattern `err.headers?.["retry-after"]` does not compile against `Headers`. The classifier therefore reads `err.headers?.get("retry-after")`, OpenAI's `err.headers?.get("retry-after-ms")`, and Anthropic's `anthropic-ratelimit-requests-reset` (RFC 3339 timestamp) / `anthropic-ratelimit-tokens-reset` via the same `Headers.get` API. A small `parseRetryAfter(value: string | null): number | undefined` helper converts seconds, HTTP-date, and RFC 3339 timestamps to a millisecond delay.
- **Runtime import / `instanceof` strategy made explicit.** With `verbatimModuleSyntax: true` ([tsconfig.json](tsconfig.json#L18)), `instanceof` requires a runtime value import. The design uses the existing default-import shape already in use in the adapters: `import Anthropic from "@anthropic-ai/sdk";` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L1)) and `import OpenAI from "openai";` ([src/providers/openai.ts](src/providers/openai.ts#L1)). The runtime constructors `Anthropic.APIError` / `OpenAI.APIError` are reachable through those namespaces. The classifier file imports them this way (default value import) and uses `err instanceof Anthropic.APIError` / `err instanceof OpenAI.APIError` for narrowing; no type-only import is used for the error classes.
- **Router aggregate-wrap `providerName` scoping clarified at the design level.** The plan in r2 already chose option (a) (track `lastProviderName`). The design now also marks that the per-candidate `providerName` used inside `callProvider`'s `catch` for the call `classifyProviderError(error, providerName)` is **scoped at the top of `callProvider`**, not inside its success branch. That removes the out-of-scope reference the r2 reviewer flagged. See plan r3 for the exact placement.
- No other architectural changes. Proposal A and the rejection of Proposal C stand unchanged from r2.

## Proposal A — Focused regex tighten + collapse the duplicated check

### Scope (files touched)

- [src/agents/base.ts](src/agents/base.ts) — rewrite the four `*_RE` literals and helpers; teach the classifier to also walk `err.cause`.
- [src/providers/router.ts](src/providers/router.ts) — delete the local `context_length_exceeded` `String.includes` check; route non-retryable detection through a single shared helper.
- New file: `src/providers/error-classify.ts` — three exported predicates `classifyContextOverflow`, `classifyNonRetryable`, `classifyThrottling` and one `unwrapErrorChain(err): string[]`. Both BaseAgent and the router import from here.

### What gets added

- `unwrapErrorChain(err)`: returns the concatenation of all messages along the `err.cause` chain (depth-limited to 5). Both the router wrap and any future wrap stay transparent.
- Tightened regexes:
  - `CONTEXT_OVERFLOW_RE`: drop the loose `too many tokens`; add `context_length_exceeded`, `prompt is too long`, `maximum context length`, `input is too long for the model`, `request too large for `, anchored with `\b` where possible.
  - `ORPHANED_TOOL_RE`: unchanged.
  - `NON_RETRYABLE_RE`: extended to cover real provider phrasings: `invalid_request_error`, `\b(?:400|401|403|404)\b`, `unsupported(?:_parameter)?`, `model_not_found`, `content[_ ]filter`, `permission_denied`, `unauthorized`, plus the existing Saivage sentinels.
  - `THROTTLING_RE`: **remove** `capacity` and `overloaded` (these are ambiguous in OpenRouter); keep `rate[- ]?limit`, `throttl`, `too many requests`, `\b429\b`, `quota.{0,20}(exhaust|exceed)`, `temporarily unavailable`, `resource.{0,10}exhaust`, `server.{0,10}busy`.
  - For Anthropic's literal `overloaded_error`: keep that as throttling because it is a documented retryable signal; match the **type token** `overloaded_error` exactly, not the substring `overloaded` anywhere.

### What gets removed

- The `nonRetryable` literal substring check in [src/providers/router.ts](src/providers/router.ts#L412-L414) — replaced by a call into `classifyNonRetryable` / `classifyContextOverflow`.
- The `THROTTLING_RE` over-broad `capacity` and bare `overloaded` alternations.

### Risk

- Medium. Regex extension is conservative, but the move of the "context overflow ⇒ non-retryable at router" decision into a shared helper means the router's failover behaviour can shift if the predicate ever drifts. Mitigated by unit tests that pin both sides to the same fixture strings.
- Does not fix the fact that `retry-after` headers on `Anthropic.APIError` / `OpenAI.APIError` are still discarded.
- Does not fix the structural problem: any new provider phrasing still ships as a regex-tightening PR.

### What it enables

- Removes the inconsistency between [src/providers/router.ts](src/providers/router.ts#L412-L414) and [src/agents/base.ts](src/agents/base.ts#L872), unblocking incremental work elsewhere.
- Compatible in spirit with F03's "stop relying on string matching" direction without coupling to it.

### What it forbids

- It does **not** require any provider adapter to change its throw site, so issues like F19 (barrel) and F29 (pi-ai `as any`) stay independent.

### Recommendation note

Cheap, low-blast-radius, lands in one PR. But it does not address the architectural critique in the F13 finding — that classification of a provider error should happen at the provider boundary, not via a brittle regex two layers up the stack. Recommend only if the orchestrator wants to defer the architectural fix.

---

## Proposal B — Typed `ProviderError` classified at the provider boundary (recommended)

### Scope (files touched)

- New file: `src/providers/error.ts` — defines `ProviderError` and the `ProviderErrorKind` union; defines a single `classifyProviderError(err, providerName): ProviderError` that inspects native SDK shapes and, for HTTP 400 / `invalid_request_error` only, inspects `err.message` against an `ORPHANED_TOOL_RESULT_RE` allowlist.
- [src/providers/anthropic.ts](src/providers/anthropic.ts) — wrap `this.client.messages.create` in a `try`/`catch` that calls `classifyProviderError(err, "anthropic")` and throws the typed error.
- [src/providers/openai.ts](src/providers/openai.ts) — same, around `this.client.chat.completions.create`.
- [src/providers/copilot.ts](src/providers/copilot.ts) — same, around the two call sites (`chatResponses`, `chatOpenAI`); the Anthropic-via-Copilot path catches `Anthropic.APIError` the same way.
- [src/providers/openai-codex.ts](src/providers/openai-codex.ts) — the bespoke `fetch` + SSE path: replace the four `throw new Error(...)` sites with `throw new ProviderError({ kind, status, retryAfterMs, cause, providerName })` (the `kind` derived from `response.status` via the same status-code map used by `classifyProviderError`).
- [src/providers/pi-ai.ts](src/providers/pi-ai.ts) — map `result.stopReason === "error"` and `result.errorMessage` to a typed error; map "Model not found" to `kind: "non_retryable"`.
- [src/providers/ollama.ts](src/providers/ollama.ts), [src/providers/llamacpp.ts](src/providers/llamacpp.ts), [src/providers/openrouter.ts](src/providers/openrouter.ts) — inherit the wrap from `OpenAIProvider` (they only override constructor + `maxContextTokens`), so no direct touch needed.
- [src/providers/router.ts](src/providers/router.ts) — replace [`nonRetryable` `String.includes`](src/providers/router.ts#L412-L414) with a check on `ProviderError.kind`. Both `non_retryable` **and** `orphaned_tool_result` (in addition to the existing `context_overflow`) short-circuit failover. The aggregate wrap at [src/providers/router.ts](src/providers/router.ts#L357-L360) is rewritten without referencing a binding that exists only in the success branch; `lastProviderName` is hoisted to the top of `chat()`. Inside `callProvider`'s `catch`, the `providerName` passed to `classifyProviderError` is the one hoisted to the **top** of `callProvider` (not the one currently declared inside the success branch at [src/providers/router.ts](src/providers/router.ts#L395)).
- [src/providers/index.ts](src/providers/index.ts) — export `ProviderError`, `ProviderErrorKind`, `classifyProviderError`.
- [src/agents/base.ts](src/agents/base.ts) — delete the four regex literals, the four `is*Error` helpers, and switch the `catch` block in `callLLM` on `err.kind` (treating non-`ProviderError` throws as `transient` for safety). The two existing internal sentinels (`"Agent cancelled"`, `"consecutive invalid tool calls"`) are **not** rewrapped — analysis r2 shows neither reaches this `catch` in practice.
- New tests in `src/providers/error.test.ts`, `src/providers/anthropic.test.ts` (new), `src/providers/openai.test.ts` (new), `src/providers/openai-codex.test.ts` (already exists, extended) and `src/agents/base.error.test.ts` (new) — see plan.

### What gets added

```ts
export type ProviderErrorKind =
  | "context_overflow"     // provider rejected the call: prompt > context window
  | "orphaned_tool_result" // saivage-side message shape: tool_use_id / tool_result mismatch
  | "throttling"           // 429 / overloaded_error / rate_limit_error / quota exhausted
  | "non_retryable"        // 400/401/403/404, invalid_request_error (after orphan check), content_filter, auth, model_not_found
  | "transient";           // network blip, 5xx without retry hint, timeout

export interface ProviderErrorInit {
  kind: ProviderErrorKind;
  message: string;
  status?: number;
  retryAfterMs?: number;
  providerName?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly providerName?: string;
  constructor(init: ProviderErrorInit) { ... }
}
```

`classifyProviderError(err, providerName)` is the single place that knows about each SDK's structural shape.

**Anthropic SDK narrowing (corrected).** The runtime check is `err instanceof Anthropic.APIError`, using the default value import already in use across the adapters: `import Anthropic from "@anthropic-ai/sdk";` ([src/providers/anthropic.ts](src/providers/anthropic.ts#L1)). Under `verbatimModuleSyntax`, this is a value import; `Anthropic.APIError` is a runtime constructor and is valid in `instanceof`. The classifier reads:

- `err.status` (typed `number | undefined` on the generic `APIError`),
- `err.type` (the API response body's `error.type`, typed as `ErrorType | null` on `APIError`) ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L12-L14)),
- `err.headers?.get("retry-after")` and `err.headers?.get("anthropic-ratelimit-requests-reset")` (`Headers | undefined`) ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L7-L8)),
- `err.message` (only as input to `ORPHANED_TOOL_RESULT_RE` inside the 400-branch).

The previous wording `err.error?.error?.type` is wrong: `APIError.error` is typed only as the JSON body `Object` ([node_modules/@anthropic-ai/sdk/core/error.d.ts](node_modules/@anthropic-ai/sdk/core/error.d.ts#L9-L10)), and under strict mode a `.error.type` walk on `Object` would not compile without unchecked casts. `err.type` is the supported and typed accessor.

**OpenAI SDK narrowing.** The same pattern: `err instanceof OpenAI.APIError`, then read `err.status`, `err.code`, `err.type`, `err.headers?.get("retry-after")`, and `err.headers?.get("retry-after-ms")` (OpenAI-specific) ([node_modules/openai/core/error.d.ts](node_modules/openai/core/error.d.ts#L7-L13)). `OpenAI.APIError.error` is also a JSON body `Object` and is not read by the classifier.

**Codex / raw `Error`** path stays the same conceptually: parse the leading `Codex API <N>: ` prefix for status, map status to `kind`, run `ORPHANED_TOOL_RESULT_RE` against the message body for the 400 branch. The codex adapter additionally constructs `ProviderError` directly at the throw site where it already has the status in hand (avoiding the round-trip through message parsing).

**Orphan-vs-non-retryable disambiguation inside the classifier.** For any error that would otherwise map to `non_retryable` because it is a 400 / `invalid_request_error` (Anthropic: `err.type === "invalid_request_error"` or `err.status === 400`; OpenAI: `err.code === "invalid_request_error"` or `err.status === 400`), the classifier first tests `err.message` against:

```ts
const ORPHANED_TOOL_RESULT_RE =
  /tool_use_id["' ]?(?:not found|did not match|without)|tool_use ids? (?:were|was) found without (?:tool_result|`tool_result`)|tool_result.{0,40}(?:not found|without (?:a )?(?:matching )?tool_use)|unexpected (?:`tool_result`|tool_result) block|tool_call_id.{0,40}(?:not found|did not match|without)/i;
```

A match returns `kind: "orphaned_tool_result"`. No match → `kind: "non_retryable"`. The regex lives next to its only call site inside `classifyProviderError`; nothing else in `src/agents/` or `src/providers/` does message-regex classification.

### What gets removed

- All four `*_RE` constants and all four `is*Error` helpers at [src/agents/base.ts](src/agents/base.ts#L872-L891).
- The duplicated `String.includes("exceeds the context window")` / `String.includes("context_length_exceeded")` check at [src/providers/router.ts](src/providers/router.ts#L412-L414).
- The catch-all `truncateDiagnostic`+regex path at [src/agents/base.ts](src/agents/base.ts#L539-L556) is replaced by an explicit switch on `err.kind` — the `truncateDiagnostic` helper itself stays because it is still used for the recovery diagnostic, but the regex-driven flow is gone.

### Risk

- Larger surface (6 provider files + base + router + 1 new file + barrel).
- Each provider adapter now does its own classification — if a new provider phrasing is missed, the default fallthrough is `transient` (retry), which is the safest default and matches today's behaviour for unknown strings.
- The Anthropic and OpenAI SDK error-class hierarchies are stable in the pinned dependency versions; `instanceof` is reliable against the namespaced `Anthropic.APIError` / `OpenAI.APIError` constructors.
- Behaviour change: today's `THROTTLING_RE` matches `capacity` and `overloaded` as throttling. Under B, OpenAI 503 with the literal "Service temporarily unavailable" becomes `transient` (capped retries) rather than `throttling` (uncapped), and OpenRouter "capacity" becomes `transient`. **This is the intended fix** but it does mean a real OpenRouter outage will now stop after `transientCap` (default 500) attempts instead of looping forever — surfacing the failure earlier. The user requested this in the F13 finding.
- The orphan-vs-non-retryable disambiguation depends on stable Anthropic/OpenAI 400-message phrasings. The `ORPHANED_TOOL_RESULT_RE` is conservatively broad (matches both vendors' current and historical phrasings); the test matrix pins it against captured live error fixtures.

### What it enables

- Closes the gap noted in **F03** (parsers should not regex provider output): together they reduce the agent's reliance on stringly-typed data flowing across module boundaries.
- Makes **F19** (provider barrel) cleaner: the barrel re-exports `ProviderError`, so consumers can `instanceof`-narrow.
- Aligns with **F07** (token estimation): the agent's pre-call estimator and the provider's post-call rejection now meet at the same typed error.
- Independent of **F09** (worker base): F13's classification lives on `BaseAgent`, not on `WorkerAgentBase`.

### What it forbids

- No regex-against-`err.message` anywhere in `src/agents/` or anywhere in `src/providers/` **except** the single `ORPHANED_TOOL_RESULT_RE` and the `Codex API <status>:` status-prefix scan, both confined to `src/providers/error.ts` and called only from `classifyProviderError`.
- No second copy of the non-retryable check inside the router.
- No silent swallow of `retry-after` headers in adapters that have them.
- No index-access on SDK `Headers` (e.g. `err.headers?.["retry-after"]`); always go through `Headers.get(...)`.

### Recommendation note

This is the recommended proposal. It is the architecturally-correct fix called out in the F13 finding, the additional surface is mechanical (a try/catch wrap per provider), and it deletes more code than it adds across the long term. The behaviour change on `capacity`/`overloaded` is precisely the bug the finding describes. The orphan-vs-non-retryable disambiguation is the one unavoidable piece of message inspection, and it is centralized.

---

## Proposal C — Considered and rejected

A third option — "centralise classification in the router, leave BaseAgent's switch as-is" — was considered. It is worse than B for two reasons: (1) it preserves the regex pattern that the finding objects to, just one layer down, and (2) it concentrates knowledge of every provider's error shape inside the router, which already has its own concerns (failover chain, sticky failover, health backoff). Distributing classification into each adapter (B) keeps each piece of provider-specific knowledge in exactly one file.

## Recommendation

**Proposal B**. It implements the architectural intent literally stated in [F13-base-agent-error-regex-brittle.md](../F13-base-agent-error-regex-brittle.md) ("each provider adapter normalises its errors into a small enum … before throwing"), respects the project guideline against keeping old + new in parallel (the regexes and the duplicated router check are deleted in the same change), and aligns with the typed-data direction also taken by F03.
