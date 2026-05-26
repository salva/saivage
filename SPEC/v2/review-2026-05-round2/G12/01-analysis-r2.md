# G12 — Analysis (Round 2)

**Finding**: [../G12-prompt-injection-cop-fail-open-silent.md](../G12-prompt-injection-cop-fail-open-silent.md)
**R1 review**: [04-review-r1.md](04-review-r1.md) (verdict CHANGES_REQUESTED, 4 required changes + acceptance tightening)
**Subsystem**: src/security (cop) + src/mcp (single consumer) + src/events (in-process fan-out) + src/server (debug endpoint) + web/src/components (DebugView)

## R2 deltas vs R1

| Required change | R1 stance | R2 stance |
| --- | --- | --- |
| Dashboard-visible signal without an active chat session | Assumed EventBus already feeds the dashboard — wrong | Confirmed wrong against source; added a security-status ring + new debug endpoint + DebugView tab (§3, §7) |
| Sanitize/redact source URLs and error messages | Said `source` would be published verbatim and `errorMessage` was "redacted" with no rule | Defined a redaction contract: caller-supplied `toolName`, structured `sourceKind`, URL reduced to origin + truncated pathname, error stripped of stacks/headers/secrets (§3, §7) |
| Treat missing provider and `isAvailable() === false` as degraded | Only the throwing-availability case was named/tested | All five no-scan paths after the scanner is enabled now route into the typed degraded result; tests for missing provider and unavailable-false added (§1, §7) |
| Cover `download_with_fallbacks` in degraded fail-closed tests | Test covered fetch_url, fetch_page_text, download_file only | `download_with_fallbacks` is now in-scope: target file not written, attempt rows preserve the degraded-cause string, manifest does not mask security as ordinary network miss (§2, §7) |
| Acceptance: closes only when operator sees degraded scanner without an active chat session | Acceptance allowed "manual smoke run" with the dashboard claim untested | Acceptance gates on the new debug endpoint returning the ring entry and DebugView rendering it (§7) |

## 1. What the code actually does today

The prompt-injection cop lives in [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts). Four call shapes matter, and R2 names all five no-scan paths the reviewer asked us to fix.

- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L44-L56) — `disabledCop()` returns `{ allowed: true, verdict: "allow", reason: "prompt injection scanner disabled", confidence: 0, scanner: "disabled" }`. This is the expected fail-open when `security.injectionScanner === false` and is the only path R2 leaves untouched.
- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L64-L75) — `DefaultPromptInjectionCop.scan` calls `scanWithModel`. If the helper returns `null`, the cop currently returns `{ allowed: true, scanner: "llm", reason: "llm unavailable; allowing", confidence: 0 }`. This `null` is overloaded across five different failure modes — that is the bug at the core of G12.
- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L80-L82) — when `tryParseModelId` does not match a `provider/model` shape, `parsed` is `undefined`. The cop then skips the availability check entirely and proceeds to `router.chat`. This is not exactly a no-scan path, but if `parsed` is set and `getProvider` returns `undefined` ([L82](../../../../src/security/prompt-injection-cop.ts#L82)), `scanWithModel` returns `null` silently. **That is the "missing parsed provider" case the reviewer named.**
- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L84-L86) — when `await provider.isAvailable()` resolves to `false`, the helper returns `null` silently. **That is the "unavailable-false" case the reviewer named.**
- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L86-L88) — when `provider.isAvailable()` throws, the helper returns `null` silently. R1 was the only path that named this case.
- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L122-L126) — when `router.chat(...)` throws, the helper logs `log.warn` and returns `null`. The free-text `reason` "llm unavailable; allowing" surfaces in the caller, but the caller cannot tell apart `chat` failure from any of the other four.
- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L117-L118) — when `parseModelVerdict(response.content)` returns `null`, the helper returns `null` silently — no log, no event.

R1's analysis named only three of the five. R2 names all five and routes each into the typed degraded result with a distinct `cause`. The five `cause` values are:

1. `provider_missing` — `getProvider(parsed.provider)` returned `undefined`. ([L82](../../../../src/security/prompt-injection-cop.ts#L82))
2. `provider_unavailable` — `await provider.isAvailable()` resolved to `false`. ([L84-L85](../../../../src/security/prompt-injection-cop.ts#L84-L85))
3. `provider_availability_error` — `await provider.isAvailable()` threw. ([L86-L88](../../../../src/security/prompt-injection-cop.ts#L86-L88))
4. `llm_call_failed` — `router.chat` threw. ([L122-L126](../../../../src/security/prompt-injection-cop.ts#L122-L126))
5. `llm_unparseable` — `parseModelVerdict` returned `null`. ([L117-L118](../../../../src/security/prompt-injection-cop.ts#L117-L118))

R2 collapses the R1 "provider_unavailable" cause name onto cause (2) and renames the throw path to `provider_availability_error` so each cause maps to exactly one branch and the test taxonomy is exhaustive.

## 2. Single consumer surface (revisited)

There is exactly one production consumer of `cop.scan(...)`: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L161), the helper `scanUntrustedText`. It is invoked from four tool branches:

- `data.fetch_url` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L770-L772) — passes `url.toString()` as `source`.
- `data.fetch_page_text` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L802-L804) — passes `url.toString()` as `source`.
- `data.download_file` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L832-L851) via `downloadUrl` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L214-L216) — passes `url.toString()` as `source`.
- `data.download_with_fallbacks` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L858-L884) via the same `downloadUrl` helper.

Two source-leak observations the R1 review forced us to confront:

- All four call sites pass `url.toString()`, so the cop receives the full URL including userinfo, query, fragment, and any signed-URL tokens. R1's design copied this `source` field into both the `log.warn` message and the EventBus `summary` field. R2 redacts at the cop boundary so neither the log nor the event ever carries the raw URL.
- The fallback path in `download_with_fallbacks` aggregates `downloadUrl` failures into an `attempts` array and, when a `manifest_path` is supplied, persists the manifest at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L869-L883). If the scanner is degraded, the per-attempt `error` field currently inherits whatever `scanUntrustedText` throws. R2's fail-closed rule (cop throws on `scanner === "degraded"` with a message tagged "scanner degraded") makes that attempt error self-identifying, so the manifest cannot mask security failures as ordinary HTTP / network misses.

## 3. Adjacent infrastructure for the fix

- `EventBus` exists at [src/events/bus.ts](../../../../src/events/bus.ts#L56-L113). It is in-process pub/sub: `publish()` fans out to current subscribers only; there is no persistence, no replay, and no debug-endpoint integration. ([src/events/bus.ts](../../../../src/events/bus.ts#L80-L113))
- `SystemEvent` taxonomy at [src/types.ts](../../../../src/types.ts#L294-L307): current types are `stage_completed | stage_failed | escalation | inspector_complete | task_failed | plan_updated`. No security category exists.
- `EVENT_SEVERITY` at [src/events/bus.ts](../../../../src/events/bus.ts#L27-L34): `Record<SystemEvent["type"], string>`. Adding a new variant without an entry here is a compile error — useful as a guard.
- `log.warn` and `log.error` at [src/log.ts](../../../../src/log.ts#L39-L60) push into a 2,000-entry ring buffer ([src/log.ts](../../../../src/log.ts#L17-L34)) exposed by `getRecentLogs`. R1 claimed the dashboard already consumes this — it does not. The supervisor reads it as model evidence ([src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L131-L145)); no HTTP endpoint exposes it today.
- Debug HTTP routes live at [src/server/server.ts](../../../../src/server/server.ts#L477-L657): `/api/debug/state`, `/api/debug/errors`, `/api/debug/timeline`. They read plan history, stage summaries, task reports, and the saivage config from disk — none of them surface security telemetry.
- `web/src/components/DebugView.vue` polls those three endpoints every 8 s ([web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L33-L70)) and renders three tabs (`state | errors | timeline`) via `activeTab` at [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L23). The Errors tab template at [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L157-L168) is the closest existing renderer to what G12 needs.
- The `SaivageRuntime` type is defined at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L52) and includes `eventBus: EventBus`. The route module imports it at [src/server/server.ts](../../../../src/server/server.ts#L12) and passes `runtime` to every handler, so a new `/api/debug/security` route has direct access to a shared ring.

## 4. Bootstrap ordering constraint

The cop is constructed inside `registerBuiltinServices(...)` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L148-L154), part of step 4. The EventBus is constructed at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L200-L201) (step 8). The cop today cannot publish to the bus.

R2 keeps R1's plan to move `const eventBus = new EventBus();` up to before step 4. Verification of "no earlier consumer" still holds: a `rg "eventBus" src/server/bootstrap.ts` confirms the next read of `eventBus` is at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L221) (assembly of `SaivageRuntime`). Moving the `const` up is mechanically safe.

R2 adds one new constraint: the security-status ring (§7 E5) must be constructed alongside or before the EventBus, because the EventBus subscription that fills the ring is registered immediately after the bus is created. Both objects live on `SaivageRuntime`, so they cross the bootstrap → routes boundary in one shot.

## 5. Tests that pin current behaviour

- [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts#L1-L80): five tests; the two at L54-L75 ("fails open when the LLM call throws", "fails open when the LLM returns unparseable content") pin the silent fail-open shape and must be rewritten. The missing-provider and unavailable-false branches are not exercised at all today.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L221-L262): the blocking-cop happy path is pinned (returns `{ allowed: false, ... }`). Degraded cop behaviour is not exercised. `download_with_fallbacks` happy/error paths are pinned at L206-L218 but with no cop variation.
- `web/src/components/DebugView.vue` has no test file in tree today (`rg -l DebugView.*test` returns nothing under `web/`). The dashboard-visibility acceptance is therefore validated by a server-side integration test on the new `/api/debug/security` route plus a manual operator-side smoke check (§7 V6 below) — adding a Vue test harness is out of scope for G12.

## 6. Threat model intersection with G08

Unchanged from R1. G08 widens the untrusted-input surface; the cop is the only gate. R2's redaction rule (§7 E1) also helps G08-adjacent telemetry: even if a future tool opens a new ingress that happens to log the source URL, the cop's degraded event will never re-emit raw URL material.

## 7. What is and isn't in scope

In scope for G12 R2:

- `PromptInjectionScanResult.scanner` gains `"degraded"`. (E1)
- All five no-scan paths in `scanWithModel` route into the typed degraded result. (E1)
- The cop computes a redacted `sourceSummary` and a redacted `errorMessage`; the raw URL never reaches the observer. (E1, E2)
- The cop accepts an optional observer; the observer is invoked synchronously with a typed detail; observer throws are swallowed with `log.error`. (E1)
- Bootstrap moves the `EventBus` constructor before `registerBuiltinServices` and constructs a small in-memory security-status ring beside it. The cop's observer pushes detail into the ring and also publishes a `security_cop_degraded` SystemEvent. (E3, E4, E5)
- A new `SystemEvent` variant `security_cop_degraded` (severity `"warning"`) is added. (E4)
- A new HTTP route `GET /api/debug/security` exposes the ring (most-recent-first, capped). (E6)
- `web/src/components/DebugView.vue` gains a fourth tab `security` that renders the ring. (E7)
- `scanUntrustedText` fails closed on `scanner === "degraded"`. (E8)
- Tests are rewritten/added for: redaction (URL userinfo, query, fragment, signed URLs; error messages); missing-provider, unavailable-false, availability-throw, chat-throw, unparseable-verdict; observer-throw resilience; `scanUntrustedText` degraded-throw; `data.download_with_fallbacks` degraded fail-closed (target file not written, attempt error self-identifies as scanner-degraded, manifest does not mask the failure). (E9, E10, E11, E12)

Out of scope (deferred), unchanged from R1:

- A pluggable metrics façade. Ring + EventBus + log are enough for the dashboard.
- A `failurePolicy: "fail-open" | "fail-closed"` config knob.
- Refactoring the cop interface to streaming/batch.
- Touching G08's auto-start defaults.
- A Vue test harness for `DebugView.vue` (no harness exists today).
- Persisting the security-status ring across restarts — `SystemEvent`s are intentionally ephemeral and a degraded scanner is a *live* operational signal; a missing entry after restart means "no degraded scan since startup", which is the correct semantics.

## 8. Risk summary

- The silent fail-open is real and broader than R1 stated: five branches, not three. The fail-closed change at the MCP boundary will start throwing on configurations where the security model is configured but its provider is currently offline. That is the *intended* outcome (the cop reports honestly; the data tool refuses to admit unscanned content). The `disabledCop()` path remains fail-open because the operator explicitly opted out.
- The new debug route and DebugView tab are small additions, but they cross the server/web boundary and require both a TypeScript build and a web build to pass (V4, V5 below). DebugView.vue is on the [user memory](../../../../web/src/components/) list of "Vue SFC corruption" hot spots; the plan calls out `grep -c "<script setup>"` after each edit.
- Redaction rules can over- or under-strip. R2 defines them concretely in the design and adds focused tests so the contract is checked, not assumed.
- No saivage-v3 changes. Operator-gated restart is **not** required for this finding unless a v2-on-v3 harness reload is explicitly requested.
