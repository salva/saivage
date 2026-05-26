# G35 — `SECRET_ENV_PATTERNS` regex strips legitimate env vars

**Subsystem**: mcp
**Category**: bad-design
**Severity**: low
**Transversality**: local

## Summary

The shell handler scrubs the spawned process's environment by deleting
any variable whose name matches a `SECRET_ENV_PATTERNS` regex set that
includes broad patterns such as `/SECRET/i`, `/TOKEN/i`, and
`/PASSWORD/i`. These patterns are unanchored, so harmless variables
like `MY_SECRETARY`, `STAGETOKENISER_PATH`, or `RESET_PASSWORD_URL`
are deleted as well, breaking tools that depend on them.

## Evidence (with line-linked refs)

- Pattern list and stripping loop:
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L416-L432).

## Why this matters

The scrubber is the only thing standing between OAuth refresh tokens
and arbitrary user shell commands, so its precision matters. The
current rule errs aggressively toward false positives: any spawned
build script or analysis tool that legitimately uses a "secretary"-
shaped variable name silently fails. Worse, the breadth invites
operators to add even more permissive patterns when a leak is found,
compounding the false-positive rate.

## Rough remediation direction (one bullet "one conceptual level up")

- Anchor the patterns to word boundaries (`/\bSECRET\b/i`,
  `/\bTOKEN\b/i`) and back them with an explicit allowlist of
  environment variable name prefixes that production code is allowed
  to expose; document the allow/deny rules in one place near
  `secrets.ts`.

## Cross-links

- Round 1: F25 (secret scanning surface).
- G30 (same file).
