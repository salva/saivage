# G34 — Review r3

**Reviewer**: GPT-5.5

## Blocking findings

No blocking findings.

## Verification

- The round-2 timer-cleanup blocker is addressed. The prior review required an explicit cleanup function and `finally` coverage for every response-body path [SPEC/v2/review-2026-05-round2/G34/04-review-r2.md](SPEC/v2/review-2026-05-round2/G34/04-review-r2.md#L7). Round 3 adds `TimedFetch.dispose()` to the helper contract [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L63-L73), clears the timer on pre-response `fetch()` failure [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L76-L104), wraps `downloadUrl` in `try/finally` with `timed.dispose()` [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L323-L468), and applies the same shape to `fetch_url` [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L480-L572). The plan also pins success, pre-header error, and mid-body error timer-count tests [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L62-L65), with explicit gate criteria [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L252-L254).

- The mid-body timeout partial-success blocker is addressed. The prior review called out `reader.cancel()` resolving a pending read as `{ done: true }`, which could return a prefix as success [SPEC/v2/review-2026-05-round2/G34/04-review-r2.md](SPEC/v2/review-2026-05-round2/G34/04-review-r2.md#L9). Round 3 checks `signal?.aborted` before treating `done` as EOF in both bounded readers [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L149-L156), [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L199-L205), and the `fetch_url` handler catches read failures through `classifyNetworkError(..., { timedOut: timedOut() })` [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L535-L549). The plan now pins both the helper throw and the public `fetch_url` envelope with `isError: true`, `code === "TIMEOUT"`, and no leaked `content` body [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L66-L69), [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L174-L176), [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L255-L256).

- The UTF-8 truncation blocker is addressed. The prior review correctly rejected the one-shot `TextDecoder` assumption [SPEC/v2/review-2026-05-round2/G34/04-review-r2.md](SPEC/v2/review-2026-05-round2/G34/04-review-r2.md#L11). Round 3 makes the text reader own a streaming decode loop, decodes each accepted chunk with `{ stream: true }`, and flushes only on the non-truncated path [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L145-L176). That is the right contract for dropping an incomplete cap-boundary UTF-8 tail without producing U+FFFD, while preserving normal final flush behavior for complete responses. The plan pins both the mid-rune truncated case and the untruncated well-formed case [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L70-L74), [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L257-L258).

- The plan still matches the live failure surface. The current code has a character cap and full materialization through `response.arrayBuffer()` / `response.text()` [src/mcp/builtins.ts](src/mcp/builtins.ts#L42-L43), [src/mcp/builtins.ts](src/mcp/builtins.ts#L197), [src/mcp/builtins.ts](src/mcp/builtins.ts#L764-L797), and the tool schemas still advertise `max_chars` [src/mcp/builtins.ts](src/mcp/builtins.ts#L670-L686). Round 3 explicitly covers the config rename, helper extraction, handler rewrites, schema rename, docs, tests, build, and redeploy sequence [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L35-L193).

## Non-blocking notes

- There is one wording nit: the design says section 4.5 carries forward unchanged while later revising the `fetch_page_text` try/finally/schema shape [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L318-L322), [SPEC/v2/review-2026-05-round2/G34/02-design-r3.md](SPEC/v2/review-2026-05-round2/G34/02-design-r3.md#L590-L598). The implementation plan's Step 8 is clear, so this does not block approval [SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G34/03-plan-r3.md#L131-L140).

## Summary

Round 3 directly closes all three round-2 blockers: timer cleanup is explicit and scoped with `try/finally`, mid-body aborts cannot become partial successes, and UTF-8 truncation uses streaming decoder semantics with pinned regression tests. Approved.

VERDICT: APPROVED