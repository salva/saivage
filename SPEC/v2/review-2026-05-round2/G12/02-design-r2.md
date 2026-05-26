# G12 — Design (Round 2)

**Companion docs**: [01-analysis-r2.md](01-analysis-r2.md), [03-plan-r2.md](03-plan-r2.md)
**R1 review addressed**: [04-review-r1.md](04-review-r1.md) (all 4 required changes + tightened acceptance)

## R2 deltas vs R1

| Required change | R1 design | R2 design |
| --- | --- | --- |
| Real dashboard-visible signal without an active chat session | Relied on EventBus subscribers + a claim that the dashboard already consumes SystemEvents | Adds a bootstrap-owned `SecurityStatusRing` (in-memory, capped), an EventBus subscriber that mirrors `security_cop_degraded` into the ring, a new `GET /api/debug/security` HTTP route, and a fourth `security` tab in `DebugView.vue`. EventBus stays as live fan-out but is no longer the only operator-visible surface. |
| Sanitize/redact source and error before publish | Said `summary` would carry `source=...` and "redacted" `errorMessage` without a rule | The cop computes `sourceSummary` (origin + truncated pathname; never userinfo, query, fragment) and `errorMessage` (first line, stripped of `Bearer`/`Authorization`/credential-shaped tokens, capped at 240 chars). Both feed every downstream surface (log, ring, event). Tests pin the redaction rule. |
| All no-scan paths after enable → degraded | Only `provider_unavailable / llm_call_failed / llm_unparseable` were named | Five distinct causes; `provider_missing`, `provider_unavailable`, `provider_availability_error`, `llm_call_failed`, `llm_unparseable`. Each branch is wired and tested. |
| `download_with_fallbacks` in degraded fail-closed coverage | Test plan covered only `fetch_url`, `fetch_page_text`, `download_file` | Adds explicit `download_with_fallbacks` test: target file not written; each attempt row's `error` contains `"scanner degraded"`; manifest (when `manifest_path` is set) records the degraded cause and does not mask it as a network miss. |
| Acceptance | Allowed manual smoke runs | Closes only when (a) the new debug endpoint returns the ring entry within seconds of a degraded scan, (b) `DebugView.vue` renders it without an active chat session, (c) all redaction tests pass. |
| Observer payload shape | Single `source: string` | `toolName: string`, `sourceKind: "url" | "tool_input" | "other"`, `sourceSummary: string` (already redacted). |

## Goals

1. The cop's "degraded" state is *structurally* distinguishable from a clean allow and from an operator-disabled cop.
2. Every degraded scan reaches the operator without requiring an active chat session: through `log.warn`, through a `SystemEvent` on the bus, and through a new debug HTTP route rendered in `DebugView`.
3. Security telemetry never re-emits raw untrusted source material or raw error stacks.
4. The single production caller decides fail-open vs fail-closed *explicitly*, in code the reviewer can audit, not inside the security module.
5. No new config surface, no migration shim, no parallel "metrics" layer.

## Shape changes

### Cop result type

`PromptInjectionScanResult` in [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L17-L24) gains one `scanner` variant `"degraded"`:

```ts
export interface PromptInjectionScanResult {
  allowed: boolean;
  verdict: "allow" | "block";
  reason: string;
  confidence: number;
  scanner: "llm" | "disabled" | "skipped" | "degraded";
  model?: string;
}
```

Discriminating on `scanner` gives callers a TypeScript-checked branch. We do **not** add a `degraded: boolean` and a parallel `error: string` field (R1 alternative considered and rejected: redundant with `scanner === "degraded"` and the existing `reason`).

### Observer detail

The cop module exports two new types alongside `PromptInjectionCop`:

```ts
export type CopDegradedCause =
  | "provider_missing"
  | "provider_unavailable"
  | "provider_availability_error"
  | "llm_call_failed"
  | "llm_unparseable";

export interface CopDegradedDetail {
  toolName: string;            // caller-supplied; never the raw source URL
  sourceKind: "url" | "tool_input" | "other";
  sourceSummary: string;       // already redacted by the cop (see §Redaction)
  contentType?: string;
  inputLength: number;
  cause: CopDegradedCause;
  errorMessage?: string;       // already redacted (first line, no stack)
  timestamp: string;           // ISO-8601, set by the cop
}

export interface CopObserver {
  onDegraded(detail: CopDegradedDetail): void;
}
```

R2 changes from R1:

- Single `source: string` → `toolName + sourceKind + sourceSummary`. `toolName` is what the caller passes (`"fetch_url"`, `"fetch_page_text"`, `"download_file"`, `"download_with_fallbacks"`); the caller's responsibility is to pass *its own identity*, not raw user input.
- `sourceSummary` is computed by the cop, not the caller, so a buggy or careless future caller cannot leak material by accident.
- `timestamp` is set by the cop (deterministic source of truth for the ring entry).

### Scan request

`PromptInjectionScanRequest` ([src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L10-L14)) gains two optional fields:

```ts
export interface PromptInjectionScanRequest {
  source: string;
  content: string;
  contentType?: string;
  toolName?: string;     // caller identity for telemetry; defaults to "<unknown>"
  sourceKind?: "url" | "tool_input" | "other"; // hint for redaction; defaults via inference
}
```

`scanUntrustedText` is the only caller and will pass both fields explicitly.

## Redaction rules (the cop owns these)

The cop performs all redaction before invoking the observer, before `log.warn`, and before constructing the degraded `reason` field. Callers cannot opt out.

### Source

Algorithm (pseudo):

```text
function redactSource(raw, kind):
  if kind === "url" OR raw.startsWith("http://") OR raw.startsWith("https://"):
    try:
      u = new URL(raw)
      u.username = ""
      u.password = ""
      u.search = ""
      u.hash = ""
      path = u.pathname.length > 80
             ? u.pathname.slice(0, 77) + "..."
             : u.pathname
      return u.origin + path
    catch:
      return "<malformed-url>"
  // non-URL or "other"
  return raw.length > 80 ? raw.slice(0, 77) + "..." : raw
```

Outcome: `https://user:pw@example.com:8443/v1/secret-path?token=abcd#frag` → `https://example.com:8443/v1/secret-path`. Signed URLs lose the signature; userinfo is removed; fragments cannot leak into logs.

### Error

```text
function redactError(err):
  raw = err instanceof Error ? err.message : String(err)
  firstLine = raw.split(/\r?\n/)[0]
  scrubbed = firstLine
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
    .replace(/(authorization|api[-_]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1 <redacted>")
  return scrubbed.length > 240 ? scrubbed.slice(0, 237) + "..." : scrubbed
```

This is intentionally narrow. The cop's failure messages today come from `router.chat` errors (provider 5xx text, fetch errors) and `parseModelVerdict` having returned `null` (in which case `errorMessage` is undefined). Stack traces from typical `Error` objects do not appear because we deliberately read `.message`, not `.stack`.

### Visible in `reason`

The cop's returned `result.reason` is constructed once from the redacted parts:

```ts
result.reason = `scanner degraded (${cause})${errorMessage ? `: ${errorMessage}` : ""}`;
```

This is what callers see and what propagates into the thrown error message at the MCP boundary. It never contains raw source material.

## Cop wiring

`DefaultPromptInjectionCop` gains an optional third constructor argument:

```ts
constructor(
  private router: ModelRouter,
  private options: { modelSpec: string; maxScanChars: number },
  private observer?: CopObserver,
) {}
```

`scanWithModel`'s return contract changes from `Promise<PromptInjectionScanResult | null>` to `Promise<PromptInjectionScanResult>`. The five no-scan branches each construct a degraded result with the right `cause`, invoke `this.observer?.onDegraded(detail)` (wrapped in a `try/catch` that calls `log.error` on observer throws), and return:

```ts
{
  allowed: true,
  verdict: "allow",
  reason: `scanner degraded (${cause})${errorMessage ? `: ${errorMessage}` : ""}`,
  confidence: 0,
  scanner: "degraded",
  model: this.options.modelSpec,
}
```

`scan(...)` no longer needs the "if `scanWithModel` returned null" fallback — that path is deleted.

`createPromptInjectionCop` ([src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L30-L42)) grows a fourth parameter `observer?: CopObserver` and forwards it to `DefaultPromptInjectionCop`. `disabledCop()` ignores it (operators who turned the cop off do not get telemetry).

## Event taxonomy

`SystemEvent.type` ([src/types.ts](../../../../src/types.ts#L295-L302)) gains `"security_cop_degraded"`. `EVENT_SEVERITY` ([src/events/bus.ts](../../../../src/events/bus.ts#L27-L34)) gets `security_cop_degraded: "warning"`. The TypeScript exhaustiveness check on `Record<SystemEvent["type"], string>` enforces this — without the entry, `tsc` fails. R2 reuses the existing event schema and folds detail into the `summary` field exactly as R1 did, but the summary is built from already-redacted parts:

```ts
summary: `prompt-injection cop degraded (${detail.cause}) in ${detail.toolName} on ${detail.sourceSummary}` +
         ` [${detail.inputLength}b${detail.contentType ? `, ${detail.contentType}` : ""}]` +
         (detail.errorMessage ? ` — ${detail.errorMessage}` : "")
```

No new optional fields are added to `SystemEventSchema` because the ring (next section) carries the structured detail.

## Security status ring (new — addresses required change #1)

A small, in-process ring buffer:

```ts
// src/security/status-ring.ts (new file)
export interface SecurityStatusEntry {
  id: string;                  // stable, monotonic; "sec-<n>"
  timestamp: string;           // ISO-8601
  toolName: string;
  sourceKind: "url" | "tool_input" | "other";
  sourceSummary: string;
  contentType?: string;
  inputLength: number;
  cause: CopDegradedCause;
  errorMessage?: string;
}

export class SecurityStatusRing {
  private readonly capacity: number;
  private readonly entries: SecurityStatusEntry[] = [];
  private counter = 0;
  constructor(capacity = 100) { this.capacity = capacity; }
  record(detail: CopDegradedDetail): SecurityStatusEntry { /* ... */ }
  list(limit = 50): SecurityStatusEntry[] { /* most-recent-first */ }
  clear(): void { /* exposed for the shutdown reset path */ }
}
```

The ring is constructed in bootstrap alongside the EventBus (§Bootstrap below), exposed on `SaivageRuntime`, and consumed by both the EventBus subscriber (which mirrors degraded scans into it) and the new debug route.

Rationale: the EventBus is intentionally a *live* fan-out — subscribers attached after a degraded scan never see the prior event. The ring is the durable-enough surface that lets an operator open the dashboard hours later and still see "cop has degraded N times since startup". Capacity 100 keeps memory tiny (<50 KB at full capacity) and matches the supervisor's prior recent-logs scale.

## Bootstrap wiring

Move `const eventBus = new EventBus();` from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L200-L201) to immediately before step 4 (currently the comment line at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L143-L144)). Add the ring beside it:

```ts
// 3b. Event bus and security status ring (must precede MCP runtime so the
// prompt-injection cop can publish degraded events at construction time).
const eventBus = new EventBus();
const securityStatusRing = new SecurityStatusRing();

// 4. Initialize MCP runtime + builtin services
const mcpRuntime = new McpRuntime(config);
registerBuiltinServices(mcpRuntime, config.mcp, {
  promptInjectionCop: createPromptInjectionCop(
    config,
    router,
    config.security.injectionScanner ? routing.resolve("security").modelSpec : undefined,
    {
      onDegraded: (detail) => {
        const entry = securityStatusRing.record(detail);
        void eventBus.publish({
          type: "security_cop_degraded",
          summary:
            `prompt-injection cop degraded (${entry.cause}) in ${entry.toolName} on ${entry.sourceSummary}` +
            ` [${entry.inputLength}b${entry.contentType ? `, ${entry.contentType}` : ""}]` +
            (entry.errorMessage ? ` — ${entry.errorMessage}` : ""),
          timestamp: entry.timestamp,
        });
      },
    },
  ),
});
```

The `SaivageRuntime` interface ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L52)) gains a `securityStatusRing: SecurityStatusRing` field; the runtime assembly at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L221) wires it in.

Before-the-bus check: a `rg "eventBus" src/server/bootstrap.ts` between L1 and L200 confirms the next read is the runtime assembly. The reorder is mechanically safe.

## Debug HTTP route (new — addresses required change #1)

A new route is added to [src/server/server.ts](../../../../src/server/server.ts), placed immediately after the existing `/api/debug/timeline` block (around [src/server/server.ts](../../../../src/server/server.ts#L598-L658)):

```ts
app.get("/api/debug/security", async () => {
  return {
    entries: runtime.securityStatusRing.list(50),
  };
});
```

That is the whole route. The ring already returns most-recent-first, the caps are enforced inside the ring, and the entries are already redacted at insertion time. Auth, content-type, and CORS handling are inherited from the surrounding `app.get(...)` declarations.

## DebugView (new tab — addresses required change #1)

`web/src/components/DebugView.vue` gains:

1. A `SecurityEntry` interface mirroring `SecurityStatusEntry`.
2. A `security` ref array and a `fetchSecurity()` function that polls `/api/debug/security`.
3. The `activeTab` union becomes `"state" | "errors" | "timeline" | "security"`.
4. `tabItems` ([web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L111-L115)) gains a fourth entry with the `ShieldAlert` lucide icon.
5. `fetchAll()` includes `fetchSecurity()` in its `Promise.all`.
6. A `<div v-if="activeTab === 'security'" ...>` block in the template renders each entry as a card (timestamp, toolName, sourceKind chip, cause chip, redacted sourceSummary, redacted errorMessage). Empty state: "No degraded scans recorded since startup."

The cards reuse the existing `error-card` CSS class structure to avoid a wave of new styles. The severity chip uses `var(--warn)`.

## Caller-side fail-closed (MCP boundary)

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L161), `scanUntrustedText` becomes:

```ts
async function scanUntrustedText(
  scanner: PromptInjectionCop,
  source: string,
  content: string,
  contentType: string | undefined,
  toolName: string,
): Promise<PromptInjectionScanResult> {
  const scan = await scanner.scan({
    source,
    content,
    contentType,
    toolName,
    sourceKind: "url",
  });
  if (!scan.allowed) {
    throw new Error(`Prompt injection blocked: ${scan.reason}`);
  }
  if (scan.scanner === "degraded") {
    throw new Error(
      `Prompt injection scanner degraded; refusing untrusted content from ${toolName}: ${scan.reason}`,
    );
  }
  return scan;
}
```

The four call sites add `toolName`:

- `downloadUrl` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L214-L216)) takes a new `toolName: string` argument forwarded from its callers and passes it through.
- `data.fetch_url` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L770-L772)) passes `"fetch_url"`.
- `data.fetch_page_text` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L802-L804)) passes `"fetch_page_text"`.
- `data.download_file` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L832-L851)) passes `"download_file"` into `downloadUrl`.
- `data.download_with_fallbacks` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L858-L884)) passes `"download_with_fallbacks"` into `downloadUrl`.

The thrown error message from a degraded scan contains the literal substring `"scanner degraded"`. `download_with_fallbacks` catches and stores it in each `attempts[i].error`; the aggregate `{ error: "All download sources failed", ... }` therefore carries the per-attempt scanner-degraded cause in its `attempts` array (not masked as a network miss). The manifest write at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L880-L883) persists the same structure.

## Why this is the right level

- The cop is a *control surface* (inspects + reports). The MCP boundary is the *policy surface* (decides what to do). Mixing them was the original mistake. R1 already separated them; R2 preserves that.
- Redaction lives in the cop, not in callers, so a future caller cannot accidentally re-leak source material.
- The ring + debug route + DebugView tab is the minimum set that makes G12 actually visible to an operator without an active chat session. The reviewer's required-change #1 forced this scope and it's worth the cost: ~30 lines server-side, ~50 lines Vue, one new route, one new tab.
- Per project rule "no backward compat": the cop result shape and request shape change; the two tests in [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts#L54-L75) are *rewritten*, not extended, and the old "llm unavailable; allowing" string is removed entirely.

## Alternative proposal (rejected): config-driven `failurePolicy` + counters

Unchanged from R1 ([02-design-r1.md](02-design-r1.md#L142-L182)). Same five reasons; same conclusion. R2 strengthens reason #1: the dashboard does *not* already consume `SystemEvent`s — we now know we must do real wiring, which is exactly what the recommended path does without adding a config knob.

## Open design questions resolved

- **Should `provider_missing` (no parsed provider lookup returns `undefined`) emit `log.warn`?** Yes, same level as the four others. In practice it indicates a misconfigured `security.injectionModel` (e.g. typo) and operators must learn about it.
- **Should the ring persist across restarts?** No. A degraded scanner is a *current* state, not a historical artefact, and the existing supervisor / runtime model treats `SystemEvent`s as ephemeral. After restart, "no entries" is the correct semantics.
- **Should the new `/api/debug/security` route be inside the existing `/api/debug/state` payload?** No. Separate endpoint keeps the polling cadence independent and matches the existing one-route-per-tab structure of `DebugView.vue`.
- **Does `scanUntrustedText` log the degraded throw?** No additional log. The cop already emits `log.warn` at the degraded branch, and the thrown error propagates into the tool result's `isError: true` payload where supervisor and chat surfaces see it. Two log lines per incident would be duplicate noise.
- **Why pass `toolName` through `downloadUrl` instead of inferring it inside?** Because `downloadUrl` is called from two distinct tools (`download_file` and `download_with_fallbacks`). The reviewer's required-change #2 explicitly asks for the caller-supplied tool name.
