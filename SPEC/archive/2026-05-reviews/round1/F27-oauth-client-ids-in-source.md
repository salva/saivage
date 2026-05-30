# F27 — OAuth client IDs embedded as source-level constants in three files

**Category**: short-sighted
**Severity**: low
**Transversality**: module

## Summary

The `client_id` strings for Anthropic OAuth, OpenAI Codex OAuth, and GitHub Copilot device-code flow are all hardcoded constants inside their respective auth modules. Rotating any of these (or supporting a per-tenant client id) requires a source patch and rebuild.

## Evidence

- [src/auth/anthropic.ts](src/auth/anthropic.ts).
- [src/auth/openai-codex.ts](src/auth/openai-codex.ts).
- [src/auth/github-copilot.ts](src/auth/github-copilot.ts).

## Why this matters

Two operator pain-points: (a) when a provider rotates client IDs upstream, every Saivage deployment must rebuild rather than re-config; (b) the `oauthToProviderName` mapping in `auth/store.ts` collapses `openai-codex → openai` which contradicts the router's distinct `openai-codex` provider — making profile resolution non-obvious. Both should live in `SaivageConfig` (or, for OAuth flows specifically, in a static `providers/oauth-config.json` shipped with the bundle but overrideable).

## Related

- F15 (oauth resolution overlap)
- F19 (provider barrel)
