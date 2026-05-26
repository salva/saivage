# F13 — BaseAgent regex error classification is provider-agnostic but brittle

**Category**: short-sighted
**Severity**: medium
**Transversality**: module

## Summary

`BaseAgent.callLLM` decides how to handle a provider error by matching the error message against four regex sets (`CONTEXT_OVERFLOW_RE`, `ORPHANED_TOOL_RE`, `NON_RETRYABLE_RE`, `THROTTLING_RE`). Each provider currently lobs its native error message in untouched, so the classifier sees "rate limit exceeded", "tokens-per-min", "capacity", "context_length_exceeded", "invalid_request_error", etc. — and the regex sets are written to whatever today's vendors happen to say.

## Evidence

- The retry switch and the helper predicates `isContextOverflowError` / `isOrphanedToolResultError` / `isNonRetryableError` / `isThrottlingError`: [src/agents/base.ts](src/agents/base.ts#L450-L590).
- Providers throw raw strings: e.g. [src/providers/anthropic.ts](src/providers/anthropic.ts), [src/providers/openai-codex.ts](src/providers/openai-codex.ts).

## Why this matters

The throttling regex matches "capacity" — which OpenRouter uses both for transient routing failures (retry-friendly) and for upstream provider death (definitely-not-retry-friendly). When `THROTTLING_RE` matches a genuinely non-retryable error, the loop sits in 20-minute exponential backoff forever; when `CONTEXT_OVERFLOW_RE` misses a new-style error string ("input too long for the model"), compaction never fires.

The correct architecture is for each provider adapter to normalise its errors into a small enum (`{ kind: "context_overflow" | "throttling" | "non_retryable" | "transient", retryAfterMs?: number }`) before throwing, so the BaseAgent can switch on a value and not on string lottery.

## Related

- F07 (token estimation also mis-routes here)
- F19 (provider barrel)
