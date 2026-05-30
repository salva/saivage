# G12 — DISAPPROVED (superseded by G12b)

**Status**: DISAPPROVED on user directive (2026-05-26). The user added the project-wide principle "no fragile heuristics like checking whether some agent has called some tool or not — treat agents as adults". The approved design retained the prompt-injection cop and merely hardened its failure mode; per the new principle the cop is a fragile heuristic and must be dropped entirely. See [../G12b/](../G12b/) for the redo.

The original record follows for reference only.

---

# G12 — APPROVED (superseded)

**Chosen proposal**: r1 design recommendation refined through r2-r4 (per [02-design-r4.md](02-design-r4.md)). The prompt-injection cop returns a typed `scanner: "degraded"` discriminant variant from all five no-scan branches (`provider_missing`, `provider_unavailable`, `provider_availability_error`, `llm_call_failed`, `llm_unparseable`). Policy is split: the cop classifies state; the data-tool boundary in `scanUntrustedText` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L160)) throws on the degraded variant so untrusted text never reaches worker LLM context when the scanner is enabled-but-broken. A new `SecurityStatusRing` plus `GET /api/debug/security` route in [src/server/server.ts](../../../../src/server/server.ts) and a new Security tab in [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue) provide operator visibility without requiring an active chat session. Source/error fields are sanitized inside the cop: observer detail carries `toolName` + `sourceKind` + redacted `sourceSummary` (origin + truncated pathname; no userinfo/query/fragment) and a length-capped `errorMessage` with credentials stripped via a literal end-delimiter-aware regex `(?!Bearer\s+<redacted>(?:$|[\s,;]))`. The rejected alternative (a `failurePolicy: fail-open|fail-closed` config knob + separate metrics façade) is explicitly rejected — it legitimises the silent-fail anti-pattern, duplicates EventBus, and merges classifier with policy.

**Approved by**: GPT-5.5 (copilot) reviewer at round 4 — see [04-review-r4.md](04-review-r4.md). All required changes addressed: dashboard-visible signal (`SecurityStatusRing` + `/api/debug/security` + DebugView Security tab); source/error redaction inside the cop; all five no-scan branches return typed degraded result; download_with_fallbacks covered in degraded fail-closed tests; `McpRuntime.callTool` tested as a throwing API via `.rejects.toThrow(/scanner degraded/)`; redaction helper canonical output stable for the bearer-in-Authorization input.

**Implementation pointer**: [03-plan-r4.md](03-plan-r4.md). Validation includes tsc, focused vitest, full vitest, `npm run build`, `npm run build:web`, and lint. Acceptance gates on V6b: operator sees degraded scanner in DebugView without an active chat session.

**Daemon impact**: Operator-gated saivage-v3 restart only if necessary; existing harnesses untouched.
