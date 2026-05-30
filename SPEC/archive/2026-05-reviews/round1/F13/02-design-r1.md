# F13 — Design (r1)

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

- New file: `src/providers/error.ts` — defines `ProviderError` and the `ProviderErrorKind` union; defines a single `classifyProviderError(err): ProviderError` that inspects native SDK shapes.
- [src/providers/anthropic.ts](src/providers/anthropic.ts) — wrap `this.client.messages.create` in a `try`/`catch` that calls `classifyProviderError(err)` and throws the typed error.
- [src/providers/openai.ts](src/providers/openai.ts) — same, around `this.client.chat.completions.create`.
- [src/providers/copilot.ts](src/providers/copilot.ts) — same, around the two call sites (`chatResponses`, `chatOpenAI`); the Anthropic-via-Copilot path catches `Anthropic.APIError` the same way.
- [src/providers/openai-codex.ts](src/providers/openai-codex.ts) — the bespoke `fetch` + SSE path: replace the four `throw new Error(...)` sites ([src/providers/openai-codex.ts](src/providers/openai-codex.ts#L137), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L251), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L257), and the wrap at the top of `chat`) with `throw new ProviderError({ kind, status, retryAfterMs, cause })`.
- [src/providers/pi-ai.ts](src/providers/pi-ai.ts) — map `result.stopReason === "error"` and `result.errorMessage` to a typed error; map "Model not found" to `kind: "non_retryable"`.
- [src/providers/ollama.ts](src/providers/ollama.ts), [src/providers/llamacpp.ts](src/providers/llamacpp.ts), [src/providers/openrouter.ts](src/providers/openrouter.ts) — inherit the wrap from `OpenAIProvider` (they only override constructor + `maxContextTokens`), so no direct touch needed.
- [src/providers/router.ts](src/providers/router.ts) — replace [`nonRetryable` `String.includes`](src/providers/router.ts#L412-L414) with `err instanceof ProviderError && err.kind === "non_retryable"`. The router's wrap at [src/providers/router.ts](src/providers/router.ts#L357-L360) becomes `throw new ProviderError({ kind: "transient", cause: lastError, ... })` — the wrap stops obscuring the inner kind.
- [src/providers/index.ts](src/providers/index.ts) — export `ProviderError`, `ProviderErrorKind`.
- [src/agents/base.ts](src/agents/base.ts) — delete the four regex literals, the four `is*Error` helpers, and the `truncateDiagnostic`-of-`err.message`-on-`unknown` path. The `catch` block in `callLLM` switches on `err.kind`:
  - `context_overflow` / `orphaned_tool_result` → existing compact-and-retry path.
  - `non_retryable` → propagate.
  - `throttling` → backoff; respect `err.retryAfterMs` when present (clamped to `[BASE_DELAY_S, MAX_DELAY_S]`).
  - `transient` → backoff and count against `transientCap`.
  - Anything else (not a `ProviderError`) → treat as `transient` for safety.
- New tests in `src/providers/error.test.ts`, `src/providers/anthropic.test.ts` (new), `src/providers/openai.test.ts` (new), `src/providers/openai-codex.test.ts` (already exists) and `src/agents/base.error.test.ts` (new) — see plan.

### What gets added

```ts
export type ProviderErrorKind =
  | "context_overflow"     // provider rejected the call: prompt > context window
  | "orphaned_tool_result" // saivage-side: tool_use_id mismatch
  | "throttling"           // 429 / overloaded_error / rate_limit_error / quota exhausted
  | "non_retryable"        // 400/401/403/404, invalid_request_error, content_filter, auth, model_not_found
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

`classifyProviderError(err, providerName)` is the single place that knows about `Anthropic.APIError` subclasses (via `instanceof Anthropic.APIError` + `.status` + `error.error.type`), `OpenAI.APIError` (via `instanceof OpenAI.APIError` + `.status` + `.code` + `.type`), Codex `response.status`, and pi-ai's `errorMessage` heuristics. It also reads `retry-after` / `anthropic-ratelimit-*-reset` headers when available and converts them to `retryAfterMs`.

The agent-side internal sentinels (`"Agent cancelled"`, `"consecutive invalid tool calls"`) become **explicit** `throw new ProviderError({ kind: "non_retryable", message, ... })` at their throw sites in BaseAgent — they no longer travel as regex-matched strings.

### What gets removed

- All four `*_RE` constants and all four `is*Error` helpers at [src/agents/base.ts](src/agents/base.ts#L872-L891).
- The duplicated `String.includes("exceeds the context window")` / `String.includes("context_length_exceeded")` check at [src/providers/router.ts](src/providers/router.ts#L412-L414).
- The catch-all `truncateDiagnostic`+regex path at [src/agents/base.ts](src/agents/base.ts#L539-L556) is replaced by an explicit switch on `err.kind` — the `truncateDiagnostic` helper itself stays because it is still used for the recovery diagnostic, but the regex-driven flow is gone.

### Risk

- Larger surface (6 provider files + base + router + 1 new file + barrel).
- Each provider adapter now does its own classification — if a new provider phrasing is missed, the default fallthrough is `transient` (retry), which is the safest default and matches today's behaviour for unknown strings.
- The Anthropic and OpenAI SDK error-class hierarchies are stable in the pinned dependency versions; `instanceof` is reliable.
- Behaviour change: today's `THROTTLING_RE` matches `capacity` and `overloaded` as throttling. Under B, OpenAI 503 with the literal "Service temporarily unavailable" becomes `transient` (capped retries) rather than `throttling` (uncapped), and OpenRouter "capacity" becomes `transient`. **This is the intended fix** but it does mean a real OpenRouter outage will now stop after `transientCap` (default 500) attempts instead of looping forever — surfacing the failure earlier. The user requested this in the F13 finding.

### What it enables

- Closes the gap noted in **F03** (parsers should not regex provider output): together they reduce the agent's reliance on stringly-typed data flowing across module boundaries.
- Makes **F19** (provider barrel) cleaner: the barrel re-exports `ProviderError`, so consumers can `instanceof`-narrow.
- Aligns with **F07** (token estimation): the agent's pre-call estimator and the provider's post-call rejection now meet at the same typed error.
- Independent of **F09** (worker base): F13's classification lives on `BaseAgent`, not on `WorkerAgentBase`.

### What it forbids

- No regex-against-`err.message` anywhere in `src/agents/` or `src/providers/`.
- No second copy of the non-retryable check inside the router.
- No silent swallow of `retry-after` headers in adapters that have them.

### Recommendation note

This is the recommended proposal. It is the architecturally-correct fix called out in the F13 finding, the additional surface is mechanical (a try/catch wrap per provider), and it deletes more code than it adds across the long term. The behaviour change on `capacity`/`overloaded` is precisely the bug the finding describes.

---

## Proposal C — Considered and rejected

A third option — "centralise classification in the router, leave BaseAgent's switch as-is" — was considered. It is worse than B for two reasons: (1) it preserves the regex pattern that the finding objects to, just one layer down, and (2) it concentrates knowledge of every provider's error shape inside the router, which already has its own concerns (failover chain, sticky failover, health backoff). Distributing classification into each adapter (B) keeps each piece of provider-specific knowledge in exactly one file.

## Recommendation

**Proposal B**. It implements the architectural intent literally stated in [F13-base-agent-error-regex-brittle.md](../F13-base-agent-error-regex-brittle.md) ("each provider adapter normalises its errors into a small enum … before throwing"), respects the project guideline against keeping old + new in parallel (the regexes and the duplicated router check are deleted in the same change), and aligns with the typed-data direction also taken by F03.
