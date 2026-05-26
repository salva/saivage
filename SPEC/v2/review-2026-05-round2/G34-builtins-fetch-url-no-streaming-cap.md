# G34 — `fetch_url` buffers the full response before applying any size cap

**Subsystem**: mcp
**Category**: short-sighted
**Severity**: medium
**Transversality**: local

## Summary

The `fetch_url` and `fetch_page_content` handlers honour the
`max_bytes`/`max_chars` cap only after `await response.text()` or
`await response.arrayBuffer()` has already materialised the full
response in memory. A hostile or misbehaving server can therefore force
Saivage to allocate gigabytes before the cap is consulted, even though
the cap is configured for a much smaller value.

## Evidence (with line-linked refs)

- Cap computed but only enforced after full materialisation:
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L820-L860).
- Configurable defaults (`maxDownloadBytes`, `maxFetchChars`):
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L42-L43).

## Why this matters

The whole point of `maxDownloadBytes` is to bound memory and bandwidth
spent on third-party content. Allocating the full body before the
check makes the cap a post-hoc guard that protects only the
downstream LLM context, not the Saivage process itself. A 5 GB
response will OOM the in-process MCP runtime well before the byte
counter fires.

## Rough remediation direction (one bullet "one conceptual level up")

- Switch to the streaming `response.body` reader, accumulate chunks
  with a running byte count, and abort the read (closing the socket)
  the moment the cap is hit; surface the truncation explicitly in the
  tool result so the agent knows the content was clipped.

## Cross-links

- G33 (web_search regex parsing — same handler family).
- Round 1: F09 (tool result size budgets).
