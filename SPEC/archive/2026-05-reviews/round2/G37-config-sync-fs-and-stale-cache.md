# G37 — `loadConfig` is sync-fs and caches without mtime invalidation

**Subsystem**: config
**Category**: bad-design
**Severity**: medium
**Transversality**: module

## Summary

`loadConfig` opens `.saivage/saivage.json` with `readFileSync` and
caches the parsed result in a module-level variable keyed by config
directory. There is no mtime check, no force-reload trigger from
disk-watch events, and no async variant. Operators who edit
`saivage.json` to update routing or quotas at runtime see no effect
until the process is restarted — and the read still happens on the
event loop whenever `force=true` is passed.

## Evidence (with line-linked refs)

- Sync read of config and cache structure:
  [src/config.ts](src/config.ts#L240-L275).

## Why this matters

Saivage advertises itself as a long-running planner/runtime. Operators
expect to be able to edit `saivage.json` — for example, to swap
providers after a credential rotation — without a service restart.
The combination of "sync I/O" plus "cache that never invalidates"
makes the config layer both unresponsive and brittle.

## Rough remediation direction (one bullet "one conceptual level up")

- Convert `loadConfig` to async (`fs/promises`), add an `fs.watch`-
  backed invalidator that flips a dirty flag, and expose a
  `reloadConfig()` API used by `/api/config` and SIGHUP handlers.

## Cross-links

- Round 1: F22 (sync fs migration).
- G36 (auth store sync fs), G30 (builtins sync fs).
