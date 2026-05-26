# G12 Review (Round 1)

Reviewer: GPT-5.5

## Findings

1. Operator visibility is still not actually wired to the dashboard.

The design's core goal says degraded scans reach the operator through a `SystemEvent` "which the dashboard already surfaces" [SPEC/v2/review-2026-05-round2/G12/02-design-r1.md](02-design-r1.md#L8), and later repeats that the dashboard already consumes `SystemEvent`s / supervisor logs [SPEC/v2/review-2026-05-round2/G12/02-design-r1.md](02-design-r1.md#L125-L128). The plan then explicitly excludes web UI work because the event supposedly lands in an existing rendered feed [SPEC/v2/review-2026-05-round2/G12/03-plan-r1.md](03-plan-r1.md#L146). That does not match the code. `EventBus.publish` is only an in-memory fan-out over current subscribers [src/events/bus.ts](../../../../src/events/bus.ts#L80-L95). The web path creates a live `ChatAgent` subscriber [src/server/server.ts](../../../../src/server/server.ts#L683-L689), and `ChatAgent` records event notifications only into the active chat session [src/agents/chat.ts](../../../../src/agents/chat.ts#L119-L123) [src/agents/chat.ts](../../../../src/agents/chat.ts#L359-L365). The dashboard debug APIs do not read the event bus or chat logs: errors come from plan history, stage summaries, and task reports [src/server/server.ts](../../../../src/server/server.ts#L502-L595), while timeline entries come from plan history and task reports [src/server/server.ts](../../../../src/server/server.ts#L598-L657). The Vue debug view only polls those debug endpoints [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L38-L53). The log ring exists [src/log.ts](../../../../src/log.ts#L19-L31), but `/api/debug/state` does not expose it [src/server/server.ts](../../../../src/server/server.ts#L477-L500), and the supervisor only consumes it as model evidence for stuck detection [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L131-L145). So the proposed implementation would be visible only to a live chat subscriber or raw process logs, not to the dashboard/operator surface the finding calls out.

Required change: revise the design/plan to add a dashboard-visible, durable-enough signal. A small recent-event/security-status ring exposed through an existing or new debug endpoint and rendered in `DebugView` is sufficient. `EventBus` can remain the live fan-out, but EventBus severity alone cannot close G12.

2. Degraded telemetry can leak full untrusted source URLs.

The design says the event summary carries `source=...` [SPEC/v2/review-2026-05-round2/G12/02-design-r1.md](02-design-r1.md#L67) and the bootstrap observer publishes `detail.source` directly [SPEC/v2/review-2026-05-round2/G12/02-design-r1.md](02-design-r1.md#L78-L80). The production callers pass full `url.toString()` values as the scan source for downloads and fetches [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L214-L216) [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L770-L772) [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L802-L804), and `download_with_fallbacks` reaches the same helper path [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L858-L876). Full URLs can include userinfo, query tokens, fragments, or signed URLs. Publishing them into logs, chat notifications, or a future dashboard event feed would create a new security telemetry leak. The original finding asked for input length and caller-supplied tool name, not raw URL material.

Required change: make the observer detail carry `toolName` / source kind plus a redacted source summary. Strip userinfo, query, and fragment; consider limiting to origin + pathname and truncating long paths. Add tests for URL redaction and error-message redaction before any event or log emission.

3. Provider-unavailable cases are under-specified and under-tested.

The current scanner silently returns `null` when the parsed provider is missing and when `provider.isAvailable()` returns false, not only when the availability check throws [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L80-L90). Round 1 analysis names the throwing availability path but does not treat missing/false availability as degraded [SPEC/v2/review-2026-05-round2/G12/01-analysis-r1.md](01-analysis-r1.md#L10-L18), and the plan only requires a test where `isAvailable` rejects [SPEC/v2/review-2026-05-round2/G12/03-plan-r1.md](03-plan-r1.md#L92-L94). If the security provider is configured but unavailable, that is exactly the enabled-scanner degraded state G12 is about; leaving either branch as a silent `null` preserves a fail-open hole.

Required change: all no-scan paths after the scanner is enabled should return the typed degraded result: missing parsed provider, provider unavailable false, provider availability exception, router chat exception, and unparseable verdict. Add focused tests for unavailable false and missing provider in addition to the thrown availability case.

4. The MCP fail-closed test plan misses one production path.

The analysis correctly identifies that downloads and fallbacks both pass through `downloadUrl` [SPEC/v2/review-2026-05-round2/G12/01-analysis-r1.md](01-analysis-r1.md#L23-L32), and the actual fallback implementation calls `downloadUrl` inside its retry loop [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L858-L876). E7 only asks the degraded-cop test to cover `fetch_url`, `fetch_page_text`, and `download_file` [SPEC/v2/review-2026-05-round2/G12/03-plan-r1.md](03-plan-r1.md#L128-L132). Because `download_with_fallbacks` catches helper failures and wraps them as an aggregate download failure [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L858-L884), it needs its own assertion that degraded scans do not write the target file, that attempts retain the scanner-degraded cause, and that a manifest does not mask the security failure as an ordinary network miss.

Required change: include `download_with_fallbacks` in the focused degraded fail-closed coverage, or split it into a separate test if the assertions get too dense.

## What Looks Solid

- The core architecture split is right: the cop reports structured state, and the MCP data boundary chooses fail-closed. That matches the actual single helper boundary at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L160) and avoids a global `failurePolicy` knob.
- Rejecting a metrics subsystem and config migration is consistent with the project rules.
- Moving `new EventBus()` before builtins registration is mechanically safe; bootstrap currently creates the cop before the bus [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L144-L151) and creates the bus later [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L200-L201).
- `scanner: "degraded"` as a discriminant is a clean API change and fits the no-backward-compat rule.

## Required Revision Summary

1. Replace the "dashboard already consumes SystemEvents" assumption with a real dashboard-visible signal and tests.
2. Sanitize/redact sources and errors before publishing security telemetry.
3. Treat missing provider and `isAvailable() === false` as degraded, not silent `null`.
4. Cover `download_with_fallbacks` in degraded fail-closed tests.
5. Update acceptance criteria so G12 closes only when an operator can see the degraded scanner without an active chat session.

VERDICT: CHANGES_REQUESTED