# F21 — Copilot adapter hardcodes vscode + extension version strings

**Category**: short-sighted
**Severity**: medium
**Transversality**: local

## Summary

`copilot.ts` sets a fixed `User-Agent: GitHubCopilotChat/0.35.0`, `Editor-Plugin-Version: copilot-chat/0.35.0`, and `Editor-Version: vscode/1.107.0`. The Copilot upstream actively rejects calls that fail to match a recent vscode/copilot pair; once Microsoft tightens the check we are silently locked out.

## Evidence

- Header constants: [src/providers/copilot.ts](src/providers/copilot.ts) (`COPILOT_HEADERS`).
- The `ANTHROPIC_API_MODELS` set is also hardcoded as a static allow-list rather than discovered.

## Why this matters

Two implicit assumptions: (a) a stable upstream that never rotates allowed clients (false), (b) operators are willing to redeploy the whole Saivage runtime just to bump a header string. Both should be moved into either `SaivageConfig.providers.copilot.headers` (operator-overridable) or auto-derived from the installed Copilot CLI version at runtime.

## Related

- F11 (constants generally)
- F19 (provider barrel)
