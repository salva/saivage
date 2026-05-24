# F13 — Analysis (r2)

## Changes from r1

- Corrected the discussion of `consecutive invalid tool calls`: it is thrown by [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L177) inside tool dispatch (called from `runLoop` after `callLLM` returns), so it never flows through `callLLM`'s `catch` and never reaches `NON_RETRYABLE_RE`.
- Corrected the discussion of `"Agent cancelled"`: both throw sites at [src/agents/base.ts](src/agents/base.ts#L489) and [src/agents/base.ts](src/agents/base.ts#L861) propagate out of `callLLM` without re-entering the `try { router.chat(...) }` block — the line 489 throw is the loop guard before the `try`; the line 861 throw fires inside `sleepWithCancellation`, which is called from within the `catch` and so propagates outward. `NON_RETRYABLE_RE` does not see either sentinel in practice.
- As a consequence, `NON_RETRYABLE_RE` at [src/agents/base.ts](src/agents/base.ts#L874) is effectively dead code in `callLLM`. The redesign therefore does not need to migrate either sentinel into the new typed-error surface — they remain raw `Error` throws and the fix is local to provider-error classification.
- Rewrote the "constraints" section to drop the implication that the redesign must re-thread the two internal sentinels through `ProviderError`.

## Problem restated

`BaseAgent.callLLM` decides whether a failed LLM call should be (a) repaired-by-compacting, (b) propagated as fatal, (c) retried after exponential backoff, or (d) retried indefinitely as "throttling". The decision is taken by matching `err.message` against four regular expressions:

- [src/agents/base.ts](src/agents/base.ts#L872-L875) — the four `*_RE` literals.
- [src/agents/base.ts](src/agents/base.ts#L877-L891) — the four `is*Error` helpers.
- [src/agents/base.ts](src/agents/base.ts#L515-L580) — the retry switch that consumes them.

Each provider adapter throws either:

- the underlying SDK error verbatim (Anthropic SDK, OpenAI SDK, OpenRouter via OpenAI SDK, Copilot via OpenAI SDK, llama.cpp/Ollama via OpenAI SDK), or
- a freshly-constructed `new Error("<message>")` with provider-specific phrasing ([src/providers/openai-codex.ts](src/providers/openai-codex.ts#L137), [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L251-L259), [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L73)).

By the time the error reaches `callLLM`, the router has additionally wrapped it: [src/providers/router.ts](src/providers/router.ts#L357-L360) constructs `new Error("All providers failed for X: <lastError.message>", { cause: lastError })`. BaseAgent inspects only `err.message` — the structured `cause` chain is discarded.

There are four concrete consequences:

1. **`THROTTLING_RE` matches `capacity`** ([src/agents/base.ts](src/agents/base.ts#L875)). OpenRouter uses the word "capacity" both for transient inter-routing failures (retry-friendly) and for upstream-provider death (must not retry). Any time the upstream string contains the literal "capacity", `callLLM` skips the `nonThrottleAttempts` cap entirely ([src/agents/base.ts](src/agents/base.ts#L547-L555)) and loops in 20-minute backoff forever.
2. **`NON_RETRYABLE_RE` is effectively dead in `callLLM`** ([src/agents/base.ts](src/agents/base.ts#L874)): the regex is `/consecutive invalid tool calls|agent cancelled/i`. Neither sentinel is actually thrown from `router.chat`:
   - `"consecutive invalid tool calls"` is thrown from [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L177) (and re-thrown at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L212)). It exits `runLoop` after `callLLM` has already returned.
   - `"Agent cancelled"` is thrown at [src/agents/base.ts](src/agents/base.ts#L489) (loop guard before `try`) and at [src/agents/base.ts](src/agents/base.ts#L861) inside `sleepWithCancellation`, which is invoked from within the `catch` block at [src/agents/base.ts](src/agents/base.ts#L575). Neither path re-enters the `try { router.chat(...) }` body, so `NON_RETRYABLE_RE` is never tested against them.
   The regex also fails to match the natural provider strings for genuinely non-retryable conditions — `400 Bad Request`, `invalid_request_error`, `401 Unauthorized`, `403`, `404 model_not_found`, `unsupported parameter`, `content_filter`. These get retried 500 times before failing as "transient".
3. **`CONTEXT_OVERFLOW_RE` is duplicated and partial.** BaseAgent's regex tries to cover `context.{0,20}(window|length)|exceeds?.{0,20}(context|token|limit)|max.{0,10}tokens?.{0,10}exceed|too many tokens`. The router carries its **own** parallel non-retryable predicate at [src/providers/router.ts](src/providers/router.ts#L412-L414): `errMsg.includes("exceeds the context window") || errMsg.includes("context_length_exceeded")`. The two predicates disagree (the router's is stricter), the router consumes its predicate **inside** the failover loop (treating context overflow as non-retryable across providers, which short-circuits `throw result.error`), and then BaseAgent applies its own broader predicate to the wrapped message. The two layers can — and do — classify the same error differently.
4. **`ORPHANED_TOOL_RE` matches Anthropic / OpenAI invalid-request errors.** Anthropic returns HTTP 400 / `invalid_request_error` with text such as `"messages.N: 'tool_use_id' not found in 'tool_use' block"` or `"Unexpected 'tool_result' block"` when the saivage-side message shape is malformed. OpenAI returns 400 with text mentioning unknown `tool_call_id`. These travel as generic invalid-request errors at the provider boundary; only their message text distinguishes them from the genuinely non-retryable invalid-request cases (auth, bad model, bad parameter). Any redesign must keep that distinction intact, because the compact-and-retry path repairs the saivage-side conversation state and the call then succeeds.
5. **Provider rate-limit metadata is thrown away.** Anthropic and OpenAI SDKs surface `retry-after` and reset timestamps on `APIError.headers`. The adapter throws the SDK error; BaseAgent matches a regex against `.message` and applies its own `BASE_DELAY_S * BACKOFF_MULT^attempt` schedule, which has nothing to do with what the provider asked for.

## Contract

Concrete contract of `callLLM`:

- **Input**: in-place `this.messages`, `this.ctx.router`, `this.compactionState`, `this.transientCap` ([src/agents/base.ts](src/agents/base.ts#L690-L693)).
- **Output**: a `ChatResponse` on success, or a thrown `Error` that the agent's `runLoop` propagates to the parent.
- **Error modes** the loop tries to discriminate (current names → intended behaviour):
  - `context_overflow` → compact via `compactWithReinjection()` and immediately retry on the same `roundId`, no diagnostic added to prompt; counts against `compactionState.compactionCount`.
  - `orphaned_tool_result` → same handling as context_overflow.
  - `non_retryable` → propagate immediately; parent must decide.
  - `throttling` → exponential backoff; **does not** count against `transientCap`.
  - `transient` (default) → exponential backoff; counts against `transientCap` (default 500).
- **Lifecycle**: callers see only success or "LLM call failed after N non-throttling attempts" (the catch-all wrap at [src/agents/base.ts](src/agents/base.ts#L551-L557)) or a passthrough of the non-retryable error.

Parallel contract on the router side ([src/providers/router.ts](src/providers/router.ts#L405-L418)):

- For each provider candidate, the router catches all exceptions, decides `nonRetryable` from a 2-literal `String.includes` check, and either rethrows (non-retryable) or records the failure and tries the next candidate. The router's `nonRetryable` is **only** "context overflow"; everything else (including `orphaned_tool_result`) is treated as a candidate-level retryable failure today, which means the router exhausts the failover chain on a Saivage-side message shape error before BaseAgent ever gets a chance to compact.

So context-overflow detection lives in **two** places with **different** patterns, orphaned-tool-result detection lives in **one** place (BaseAgent regex) and is invisible to the router, and the router silently swallows every other provider error category into its own backoff loop (sticky failover with 15s → 10min cooldown per model) — orthogonal to BaseAgent's own backoff schedule.

## Call sites & dependencies

Direct consumers of the four classifiers — all private to [src/agents/base.ts](src/agents/base.ts):

- [src/agents/base.ts](src/agents/base.ts#L515) `isContextOverflowError`, `isOrphanedToolResultError`.
- [src/agents/base.ts](src/agents/base.ts#L539) `isNonRetryableError`.
- [src/agents/base.ts](src/agents/base.ts#L545) `isThrottlingError`.

The four `is*Error` functions are not exported — no other file in `src/` imports them (verified by `grep` across `src/**/*.ts`).

Upstream throw sites:

| Provider file | What it throws | Has structured info? |
|---|---|---|
| [src/providers/anthropic.ts](src/providers/anthropic.ts#L30-L44) | Anthropic SDK errors (`Anthropic.APIError` subclasses) with `.status`, `.headers`, `.error.type` (`overloaded_error`, `rate_limit_error`, `invalid_request_error`, `authentication_error`, …) | Yes — fully structured |
| [src/providers/openai.ts](src/providers/openai.ts#L38-L51), `openrouter.ts`, `ollama.ts`, `llamacpp.ts`, [src/providers/copilot.ts](src/providers/copilot.ts#L218-L226) (chat completions / responses path) | OpenAI SDK errors (`OpenAI.APIError` subclasses) with `.status`, `.headers`, `.code`, `.type` | Yes — fully structured |
| [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L137) | `new Error("Codex API <status>: <body slice>")` | Status only in string |
| [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L251-L259) | `new Error("Codex stream error: <msg>")` / `new Error("<err.message>")` | Lost |
| [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L70-L73) | `new Error("LLM error: <result.errorMessage>")` after `stopReason === "error"` | Lost; pi-ai's own `stopReason` is structured but discarded |

The router then wraps the **last** failure with `new Error("All providers failed for X: <lastError.message>", { cause: lastError })` ([src/providers/router.ts](src/providers/router.ts#L357-L360)). BaseAgent's regex therefore runs against `"All providers failed for <spec>: <provider-formatted message>"` — the wrap prefix does not match any regex but does make every error string longer, which interacts with the regex anchors. The `cause` chain is available but ignored.

## Constraints any solution must respect

- **No backward compatibility** ([_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md#mandatory-project-guidelines)). The four regex helpers and the duplicated check in `router.callProvider` must both go in the same change as their replacement; no parallel "old + new" period.
- **No regex-fragment shims for skill/memory code** — [src/skills/](src/skills/) is out of scope ([_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md#saivage-v2-repo-facts-use-these-dont-re-derive)).
- **Provider abstraction must hold for the eight existing adapters.** Any solution that requires every provider file to grow a deep classification table is acceptable; one that requires changes to the underlying SDKs is not.
- **The router still does sticky failover.** Whatever the classification surface looks like, the router must continue to (i) treat genuine non-retryable errors as halt-the-chain, (ii) treat everything else as candidate-failure-and-try-next, **and (iii) also halt the chain on `orphaned_tool_result`**, because that is a Saivage-side message-shape error — trying it on a second provider will fail identically and only delays the compaction repair.
- **BaseAgent has two distinct "compact-and-retry" categories** (`context_overflow`, `orphaned_tool_result`); they must remain separately classifiable because the diagnostic message differs. `orphaned_tool_result` is generated by the provider as an invalid-request error (HTTP 400 / `invalid_request_error`) when the saivage-side `tool_use`/`tool_result` interleaving is malformed, so any classifier that maps "generic 400 / invalid_request_error" must inspect the provider message to distinguish the two before deciding `non_retryable`.
- **Saivage-internal non-retryable sentinels** (`"Agent cancelled"`, `"consecutive invalid tool calls"`) are out-of-band relative to `callLLM`'s error switch: they are thrown from the cancellation guard, from `sleepWithCancellation`, and from `Dispatcher.dispatch`, all on paths that bypass `router.chat`'s `catch`. The redesign therefore leaves their throw sites alone; they continue to flow up through `runLoop` as raw `Error`s.
- **`transientCap`** ([src/agents/base.ts](src/agents/base.ts#L690-L693)) and the `nonThrottleAttempts` semantics (throttling does **not** count) must be preserved as observable behaviour.
- Tests must remain runnable with `npx vitest run` per [_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md#saivage-v2-repo-facts-use-these-dont-re-derive).

## Cross-issue context

- **F03** ([F03-naive-json-extraction.md](../F03-naive-json-extraction.md)) is the analogous "providers throw stringly-typed payloads, callers regex them" problem on the response-parsing side; the cure here (typed provider results) and the cure there (typed `parseToolReport` helpers) are independent but conceptually aligned.
- **F07** ([F07-token-estimation-chars-over-4.md](../F07-token-estimation-chars-over-4.md)) flags that pre-call token estimation can mis-trigger compaction; F13 is the post-call complement (failure to detect that the provider already rejected the call as overflowing).
- **F09** ([F09-worker-agent-helpers-duplicated.md](../F09-worker-agent-helpers-duplicated.md)) is approved and centralises `normalizeTask` / `parseTaskReport` / `buildFailureReport` on a `WorkerAgentBase`. The error-classification surface targeted by F13 lives on `BaseAgent` and is shared by **all** agents (worker + non-worker), so F13 must not be folded into `WorkerAgentBase`.
- **F19** ([F19-provider-barrel-incomplete.md](../F19-provider-barrel-incomplete.md)) covers the incomplete barrel re-export from [src/providers/index.ts](src/providers/index.ts). If F13 introduces a new exported type (e.g. `ProviderError`) it must be added to that barrel; F13 should land **before** F19 fixes the barrel so the new export is included in the cleanup.
