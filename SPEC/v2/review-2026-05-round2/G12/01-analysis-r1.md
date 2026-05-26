# G12 — Analysis (Round 1)

**Finding**: [../G12-prompt-injection-cop-fail-open-silent.md](../G12-prompt-injection-cop-fail-open-silent.md)
**Subsystem**: src/security (cop) + src/mcp (single consumer) + src/events (publication channel)

## 1. What the code actually does today

The prompt-injection cop lives in [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts). Three call shapes matter:

- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L44-L56) — `disabledCop()` returns `{ allowed: true, verdict: "allow", reason: "prompt injection scanner disabled", confidence: 0, scanner: "disabled" }`. This is the expected fail-open when `security.injectionScanner === false`.
- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L64-L75) — `DefaultPromptInjectionCop.scan` calls `scanWithModel`. If that returns `null`, the cop returns `{ allowed: true, scanner: "llm", reason: "llm unavailable; allowing", confidence: 0 }`.
- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L77-L128) — `scanWithModel` itself swallows three classes of failure and all collapse into `null` (then fail-open):
  - provider `isAvailable()` throws → catch block at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L88-L90), silent (no log, no event).
  - `router.chat(...)` throws → catch block at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L122-L126), `log.warn` only.
  - model returned content fails `parseModelVerdict` → silent `return null` at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L117-L118), no log.

The finding's paraphrase ("a single try/catch that returns `{ allowed: true }`") is slightly out of date — the catch branch does a `log.warn` and labels the result `scanner: "llm"` with `reason: "llm unavailable; allowing"`. **But the substantive complaint stands**:

- The provider-availability path is silent (no log).
- The unparseable-LLM path is silent (no log).
- Nothing reaches the operator dashboard. There is no event bus publish, no counter, no health-endpoint exposure.
- The caller cannot distinguish "scanner cleanly allowed" from "scanner blew up and defaulted to allow" — the only signal is a free-text `reason` field; `allowed: true` is identical between the two cases.

## 2. Single consumer surface

There is exactly one consumer of `cop.scan(...)` outside tests: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L160) (`scanUntrustedText`), used by:

- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L791) — `data.fetch_url` tool.
- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L793-L823) — `data.fetch_page_text` tool.
- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L162-L223) — `downloadUrl` helper invoked by `data.download_file` and `data.download_with_fallbacks`.

In all four paths, the only check on the scan result is `if (!scan.allowed) throw`. A degraded fail-open passes straight through and `prompt_injection_scan: { allowed: true, ... }` is embedded in the tool response handed back to the worker LLM (visible at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L233-L239) for downloads, [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L781-L789) for fetch_url, [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L812-L820) for fetch_page_text).

This concentration is good news for the fix: one call site, one struct field, one taxonomy.

## 3. Adjacent infrastructure that the fix can reuse

- `EventBus` exists at [src/events/bus.ts](../../../../src/events/bus.ts#L52-L113) and is the canonical publish channel for runtime signals. Constructed in bootstrap at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L201) (currently *after* the cop, see §4).
- `SystemEvent` taxonomy is defined at [src/types.ts](../../../../src/types.ts#L291-L307). Today's `type` enum is `stage_completed | stage_failed | escalation | inspector_complete | task_failed | plan_updated`. There is no security category.
- `EVENT_SEVERITY` map in [src/events/bus.ts](../../../../src/events/bus.ts#L27-L34) classifies each event type for filtering. Any new type needs an entry there.
- `log.warn` and `log.error` from [src/log.ts](../../../../src/log.ts) feed the supervisor's recent-logs ring buffer that the dashboard already consumes.

## 4. Bootstrap ordering constraint

The cop is constructed at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145-L151), part of step 4 (MCP runtime + builtin services). The EventBus is constructed at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L200-L201), step 8. So today the cop cannot see the event bus.

This is purely a wiring ordering accident — no other consumer of `eventBus` exists at step 4, and there is no reason `new EventBus()` cannot move to step 1. The project rule "no migration shims, no backward compat" cleanly allows reordering.

## 5. Tests that pin current behaviour

- [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts#L54-L75) has two tests that assert the silent fail-open shape:
  - "fails open when the LLM call throws" — asserts `result.allowed === true`, `result.reason === "llm unavailable; allowing"`.
  - "fails open when the LLM returns unparseable content" — asserts `result.allowed === true`.
  Both will need to be rewritten when the result shape changes.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L221-L262) pins the blocking-cop happy path with `{ allowed: false, ... }` and **does not** exercise a degraded cop today. A new test must cover degraded → fail-closed at the data-tool boundary.

## 6. Threat model intersection with G08

G08 (auto-started MCP browser tools) widens the untrusted-input surface — browser navigation lands content in the worker context via the data-agent fetch family, which is exactly the call site §2 lists. Without G12 fixed, a cop crash on a malformed UTF-16 BOM or oversize tool result silently disables the only gate that was supposed to filter that content. The fix should be in before G08 work expands browser-tool defaults.

## 7. What is and isn't in scope

In scope for G12:

- Cop signals "degraded" distinctly from "disabled" and "clean allow".
- Cop publishes a structured event on the catch + parse-failure branches.
- The one production caller (`scanUntrustedText`) reads the new signal and chooses fail-open vs fail-closed deliberately at the data-tool boundary (not silently inside the cop).
- Tests are rewritten to match — old behaviour is removed, not preserved.

Out of scope (deferred):

- A pluggable metrics façade. We have `log.*` and `EventBus`; both are sufficient for the dashboard to surface failures. A separate counter library is over-engineering per project rules.
- A `failurePolicy: "fail-open" | "fail-closed"` config knob. See [02-design-r1.md](02-design-r1.md) §Alternatives — rejected.
- Refactoring the cop interface to a streaming or batch API. No present need.
- Touching G08's auto-start defaults. Separate finding.

## 8. Risk summary

- The silent fail-open is real but currently bounded by (a) the one data-tool consumer and (b) the `log.warn` on the throw path. Operators reading logs can spot a failing cop today — but most operators watch the dashboard, not the log file.
- The fix is mechanically small: extend the result type, publish an event, flip one branch in `scanUntrustedText`, reorder two lines in bootstrap, rewrite two tests, add one test.
- Risk of the fix itself: a fail-closed default on the data tool is a behaviour change. If the security model is partially mis-configured (e.g. `injectionScanner: true` but the security role's provider is offline), the data-tool calls will start throwing where they used to fail-open silently. That is the *intended* outcome. The `disabledCop()` path remains fail-open because the operator explicitly opted out.
