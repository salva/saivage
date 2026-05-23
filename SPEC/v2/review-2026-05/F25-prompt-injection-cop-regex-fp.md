# F25 — Prompt-injection cop regex blocklist guarantees false positives on injection docs

**Category**: short-sighted
**Severity**: medium
**Transversality**: local

## Summary

`prompt-injection-cop.ts` runs an LLM scan and, in parallel, a regex blocklist that matches strings like "ignore previous instructions", "you are now", "system:", etc. The blocklist will reliably flag any documentation, research note, or test fixture that **discusses** prompt injection — including Saivage's own SPEC files if a researcher ever fetches them via the web tool.

## Evidence

- `BLOCK_PATTERNS` regex set and the `DEFAULT_SCAN_MODEL = "github-copilot/gpt-5.4"` constant: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L1-L200).
- The scanner runs on every web-fetched payload before it reaches the agent.

## Why this matters

False-positive blocks are silent: the researcher agent sees "fetched URL returned no content" and assumes the page is empty. The researcher then retries (maybe with a different URL), the cop blocks again, and so on. The only escape is for the user to notice and disable the cop entirely. The right architecture is "regex sets are LOG-only; only LLM verdicts can block" — at minimum the regex set should require a co-occurring LLM verdict to count as a block.

## Related

- F04 (hardcoded scan model)
- F03 (its parser uses the same naive JSON regex)
