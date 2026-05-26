# F25 Analysis r1 — prompt-injection cop regex blocklist guarantees false positives

## Problem restated

The prompt-injection cop runs a regex blocklist BEFORE the LLM scan and short-circuits to `block` on any match. The blocklist matches phrases that are common in legitimate documents that *discuss* prompt injection — security articles, research papers, OWASP write-ups, our own [SPEC/v2/review-2026-05/F25-prompt-injection-cop-regex-fp.md](SPEC/v2/review-2026-05/F25-prompt-injection-cop-regex-fp.md), and even the LLM cop's own system prompt if a researcher were to paste it back into a fetched page. The LLM cop's system prompt explicitly says *"Allow ordinary documents, datasets, code examples, and articles, even if they discuss security academically"* ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L120-L122)) — so the regex layer directly contradicts the policy the LLM layer is told to follow.

Because the regex layer wins, the LLM never even sees the content. The failure is also silent at the agent layer: `scanUntrustedText` throws, `downloadUrl` catches and stuffs the error string into `attempt.error`, returns `null`, and the agent reads the result as "the fetch failed" ([src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L222)). The researcher agent retries with a different URL, hits the same regex on the next page, and the loop continues until the user notices and disables the cop entirely (the only escape switch).

## Actual behaviour

`scan()` calls `scanHeuristically` first; if the regex matches, it returns immediately with `allowed: false`:

- `scan()` short-circuit: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L84-L94).
- `scanHeuristically()` returns `block` on the first regex hit with confidence 0.95: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L156-L176).
- `BLOCK_PATTERNS`: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L28-L38). The eight patterns match plain English that any security article would contain, e.g. `/you\s+are\s+now\s+...\s+an?\s+agent/i` against "you are now an agent of change" or `/ignore\s+(all\s+)?(previous|prior|...)\s+instructions/i` against any documentation that quotes the canonical attack string.
- `SUSPICIOUS_PATTERNS` (only consulted when the regex did NOT block): [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L40-L49). These act as the LLM gating filter: the LLM is only asked when one of these matches in otherwise-clean content.
- `parseModelVerdict()` returns `verdict: "allow"` by default when JSON is malformed (only `"block"` is treated literally): [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L188-L201) — so LLM-side failures fail open, while regex-side hits fail closed.

There is an architectural asymmetry: the regex pathway has an aggressive block bias, the LLM pathway has an allow bias. The two are stacked such that the aggressive one runs first.

## Failure propagation

- Cop throws `Prompt injection blocked: <reason>`: [src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L160).
- `downloadUrl` catches, records `attempt.error`, returns `null`: [src/mcp/builtins.ts](src/mcp/builtins.ts#L211-L222).
- Caller sees an empty/failed download result. There is no escalation channel; the agent cannot distinguish "404" from "blocked by cop" from "binary file too large" from any other failure.

## Contract

`PromptInjectionCop.scan(request)` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L9-L23)):

- Input: `{ source: string; content: string; contentType?: string }`.
- Output: `PromptInjectionScanResult` with `allowed: boolean`, `verdict: "allow"|"block"`, `reason: string`, `confidence: number`, `scanner: "heuristic"|"llm"|"disabled"|"skipped"`, optional `model`.
- Error modes: model call may throw inside `scanWithModel`, which is caught and logged via `log.warn`; the heuristic result is returned as fallback ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L96-L148)).
- Lifecycle: constructed once per server in `bootstrap.ts` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L142)), passed by reference into the MCP builtins data handler ([src/mcp/builtins.ts](src/mcp/builtins.ts#L766)).

## Call sites & dependencies

- Constructed by `createPromptInjectionCop()` in [src/server/bootstrap.ts](src/server/bootstrap.ts#L142).
- Consumed only via `scanUntrustedText()` inside `downloadUrl()` in [src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L222). That is the single production call site.
- Result is surfaced inside `DownloadSuccess.prompt_injection_scan` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L235)) when the download succeeds. When the cop blocks, the result is *not* surfaced; only `attempt.error` carries a stringified message.
- Schema constraint: the cop's output type does not appear in any persisted schema; it is internal to the MCP fetch response.
- Config knobs: `config.security.injectionScanner` (default `true`), `injectionModel`, `maxScanLengthBytes` ([src/config.ts](src/config.ts#L80-L86)).

## Constraints any solution must respect

1. **Architecture-first, no backward compat.** Per project guidelines, no migration shim. Whatever is removed is removed in the same change; existing tests update.
2. **Single call site is the MCP data download path.** Any redesign of the result type must update [src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L235) and the existing test in [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts#L1-L19).
3. **The LLM scan must remain the source of truth.** The LLM system prompt already encodes the correct policy (allow academic discussion, block clear instruction attempts). The regex set must not contradict it.
4. **Failure to scan must not be silent at the agent layer.** Either the cop returns a structured "blocked" result with `scanner` and `reason` set, and the download path surfaces that distinctly from a network error, or the cop never blocks based on regex alone.
5. **Out-of-scope items not to be touched here:** F03 (LLM verdict JSON parser is brittle — separate issue), F04 (hardcoded scan model — separate issue). Reference them but do not patch in this slice.
6. **Cop must remain disable-able.** `disabledCop()` and `config.security.injectionScanner = false` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L64-L76), [src/config.ts](src/config.ts#L80-L86)) must keep working.
7. **No new docstrings/comments on unrelated code.** Edits limited to the cop, the cop test, the MCP download caller, and (only if the result type changes) the immediate consumers of `prompt_injection_scan`.
