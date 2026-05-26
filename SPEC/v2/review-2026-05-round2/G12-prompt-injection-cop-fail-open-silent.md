# G12 — `prompt-injection-cop` fails open silently with no operator visibility

**Subsystem:** src/security/
**Category:** security / observability
**Severity:** medium
**Transversality:** local (one module), security-critical

## Summary

The prompt-injection scanner catches every internal error and returns `{ allowed: true }`. There is no metric, no event-bus publish, no structured log marker that "the scanner failed open on this request." Operators who deployed the cop expecting it to gate untrusted tool output will not learn from logs or the dashboard when the cop is silently letting traffic through — they'll see the green "scanner enabled" indicator and assume coverage. This is a classic *fail-open without telemetry* anti-pattern in a security module.

## Evidence

`src/security/prompt-injection-cop.ts` (~line 143). The exported `scan(...)` function wraps its scanner call in `try { ... } catch (err) { return { allowed: true }; }` (paraphrased). There is no `log.warn`, no counter increment, no event.

The whole module is gated behind a config flag (e.g. `cop.enabled`); when off, the gate returns `allowed: true` unconditionally — that's the *expected* fail-open. But the error path returns the same shape as the disabled path, so the calling code (typically the MCP tool-result post-processor) cannot tell "scanner was off" from "scanner blew up". Both look like clean passes.

Combine with G08's hardcoded MCP-server defaults (Playwright autostart with browser navigation tools) and the threat model gets worse: untrusted web content arrives via `fetch_page_text`-style tools, the cop is expected to scan it for injection attempts, the cop crashes on an unexpected encoding, and the content lands in a worker LLM context unannotated.

## Why this matters

- A security control that fails open without observability is, in production, *equivalent to no control at all*. The operator can't distinguish working-and-protecting from broken-and-permitting.
- The runtime already has an event bus (`EventBus` used by [src/chat/localCommands.ts](src/chat/localCommands.ts#L154-L157)) and a recent-logs ring buffer (used by the supervisor at [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L129)). Publishing a `cop_failure` event on the catch path is mechanically trivial.
- This is not a hypothetical: secrets-scanning, prompt-injection scanning, and tool-output filters in similar systems have all been reported to silently fail on edge-case inputs (multi-MB tool results, UTF-16 BOMs, etc.). The cop being one of the youngest modules in the tree raises the prior on undiagnosed input failures.

## Rough remediation direction

1. On the catch branch, do **not** just return `allowed: true`. Return `{ allowed: true, degraded: true, error: <sanitised message> }` and let the caller decide. (For high-risk paths — content from `fetch_*` tools — fail closed instead.)
2. Publish a `security_cop_failure` runtime event with the input length, tool name (caller-supplied), and a redacted error message. Wire it to the dashboard so a failing cop is visible alongside other runtime health signals.
3. Add a counter `cop.failures_total` (and `cop.scans_total`) so monitoring can alert on a non-zero failure rate.
4. Optionally, make the policy configurable: `cop.failurePolicy: "fail-open" | "fail-closed"` so projects can choose. Default fail-closed for production-shaped deployments, fail-open for development.

## Cross-links

- Compounded by G08 (auto-started MCP browser tools widen the untrusted-input surface).
- Same observability gap class as the supervisor's silent abort decisions (G01) — both are control-loop modules that need to publish their actions to the event bus.
