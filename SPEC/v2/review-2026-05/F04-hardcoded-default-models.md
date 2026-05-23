# F04 — Hardcoded `github-copilot/gpt-5.4` supervisor/security model in three places

**Category**: inconsistency
**Severity**: medium
**Transversality**: cross-cutting

## Summary

The string `"github-copilot/gpt-5.4"` is hardcoded as the default model for two unrelated subsystems (runtime supervisor and prompt-injection cop), and additionally as the default in the `SaivageConfig` schema. There is no shared constant; rotating to a different model requires three edits.

## Evidence

- Supervisor: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L8).
- Security: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts) (`DEFAULT_SCAN_MODEL`).
- Config schema default for `security.injectionModel`: [src/config.ts](src/config.ts#L78-L82).
- Config schema default for `supervisor.model`: [src/config.ts](src/config.ts#L84-L92).
- Orchestrator default is yet another model: [src/config.ts](src/config.ts#L42-L46) (`"anthropic/claude-sonnet-4-20250514"`).

## Why this matters

The hardcoded model encodes a vendor + product version (`gpt-5.4`) directly in source. When the provider deprecates that model or the routing config silently re-routes it, the supervisor and the security scanner start failing in ways that don't show up in agent traffic. The orchestrator picking a different default further suggests no single owner has thought about "what model does Saivage assume is available out of the box?"

## Operator comments

No model should be hard-coded. If no model is set in the config, the system must just fail to work and report the issue.

## Related

- F11 (magic constants generally)
- F19 (provider barrel incompleteness)
