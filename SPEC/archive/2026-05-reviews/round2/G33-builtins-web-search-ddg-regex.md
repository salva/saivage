# G33 — `web_search` builtin scrapes DuckDuckGo HTML with regex

**Subsystem**: mcp
**Category**: short-sighted
**Severity**: medium
**Transversality**: local

## Summary

The `web_search` builtin issues a GET against DuckDuckGo's HTML
endpoint and extracts results by running regex over the response body.
HTML parsing with regex is brittle by construction; DuckDuckGo's
markup changes silently and the regex either returns garbage or no
results at all. There is no fallback search provider, no schema
validation on the parsed output, and no test that exercises the parser
against pinned HTML fixtures.

## Evidence (with line-linked refs)

- Fetch and regex-extract loop:
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L743-L770).

## Why this matters

Agents call `web_search` to discover unfamiliar APIs and library
documentation; a silent breakage means the agent thinks the web has
nothing useful and proceeds with stale knowledge. Because the
breakage mode is "empty results" rather than "error", supervisor
heuristics never flag the regression — the agent just gets dumber.

## Rough remediation direction (one bullet "one conceptual level up")

- Either depend on a real search API (Brave, SerpAPI, etc. with an
  abstracted provider interface) or parse the HTML with a proper DOM
  library; add a fixture-driven unit test that pins the parser to a
  captured DuckDuckGo response and fails loudly when the markup
  changes.

## Cross-links

- G34 (fetch_url streaming cap — same family).
