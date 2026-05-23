# F33 — Two different default projects: `cli.initProject` vs `config.writeDefaultConfig`

**Category**: inconsistency
**Severity**: medium
**Transversality**: module

## Summary

There are two places that write a "default" project config and they disagree:

- `cli.ts initProject` writes a `config.json` with `provider: "openai-codex/gpt-5.3-codex"` and `notifications.channels: []`.
- `config.ts writeDefaultConfig` writes a `saivage.json` with the orchestrator model `"anthropic/claude-sonnet-4-20250514"` (via schema default) and `notifications.channels: ["web"]`.

A fresh `saivage init` therefore produces a project whose `config.json` and `saivage.json` disagree about which provider is the default and whether any notification channel is enabled.

## Evidence

- CLI default: [src/server/cli.ts](src/server/cli.ts) (search `initProject`, near the top).
- Config schema default: [src/config.ts](src/config.ts#L42-L46) (orchestrator model) and [src/config.ts](src/config.ts#L101-L108) (notifications).
- Default `writeDefaultConfig` body: [src/config.ts](src/config.ts#L196-L235).

## Why this matters

The user's own memory captures this: "When resetting GetRich v2 Saivage state, `initProjectTree`/seed helpers can clobber `.saivage/saivage.json`." That is exactly because the two writers don't agree on what the canonical defaults are. Consolidating into a single `seedProject(targetDir, overrides?)` helper that both `cli.ts initProject` and `config.writeDefaultConfig` call would fix the drift.

## Related

- F32 (config blocks undocumented)
