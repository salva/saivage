# G12 — Design (Round 1)

**Companion docs**: [01-analysis-r1.md](01-analysis-r1.md), [03-plan-r1.md](03-plan-r1.md)

## Goals

1. The cop's "degraded" state is *structurally* distinguishable from a clean allow and from an operator-disabled cop.
2. Every degraded scan reaches the operator: through `log.warn` on the cop side and through a `SystemEvent` on the bus, which the dashboard already surfaces.
3. The single production caller decides fail-open vs fail-closed *explicitly*, in code the reviewer can audit, not inside the security module.
4. No new config surface, no migration shim, no parallel "metrics" layer.

## Recommended proposal: structured-degradation + caller-side fail-closed

### Shape changes

`PromptInjectionScanResult` in [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L17-L24) gains one required field:

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

A fourth `scanner` variant `"degraded"` replaces today's overloaded use of `"llm"` for the failure paths. `disabledCop()` keeps `"disabled"`, `bufferToScannableText` non-text path keeps `"skipped"`, healthy LLM verdicts keep `"llm"`. The three failure paths in `scanWithModel` all surface as `"degraded"` with a populated `reason` carrying a redacted error message.

We do **not** add separate `degraded: boolean` and `error: string` fields (the finding's suggested shape). Reasons:

- `scanner === "degraded"` is the boolean and is exhaustive against the existing union.
- A redacted `reason` already exists; adding a second free-text field invites divergence.
- Discriminating on the existing `scanner` enum gives the caller a TypeScript-checked branch.

### Cop wiring

`DefaultPromptInjectionCop` gains an optional dependency:

```ts
constructor(
  private router: ModelRouter,
  private options: { modelSpec: string; maxScanChars: number },
  private observer?: { onDegraded(detail: CopDegradedDetail): void },
) {}
```

`CopDegradedDetail` is internal to the cop module:

```ts
interface CopDegradedDetail {
  source: string;
  contentType?: string;
  inputLength: number;
  cause: "provider_unavailable" | "llm_call_failed" | "llm_unparseable";
  errorMessage?: string; // already redacted (no stack, no headers)
}
```

The three failure points each call `observer?.onDegraded(...)` with the right `cause` and a one-line redacted `errorMessage` (the existing `log.warn` line is reused).

The cop returns a `"degraded"` result and otherwise keeps the structure of its happy path.

### Event taxonomy

`SystemEvent.type` in [src/types.ts](../../../../src/types.ts#L291-L307) gets one new variant: `"security_cop_degraded"`. New required-ish fields are folded into the existing `summary` string; the schema gains no optional properties beyond what already exists (`stage_id`, `task_id`, `report_id`, `summary`, `timestamp`). The `summary` carries `cop degraded (cause=...): source=... bytes=... — <reason>`.

`EVENT_SEVERITY` in [src/events/bus.ts](../../../../src/events/bus.ts#L27-L34) gets `security_cop_degraded: "warning"`. Warning severity matches the existing supervisor / chat-handler treatment of recoverable degradations.

### Bootstrap wiring

Move `const eventBus = new EventBus();` from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L201) to immediately before step 4 (before `registerBuiltinServices` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145-L151)). Pass an inline observer to `createPromptInjectionCop`:

```ts
promptInjectionCop: createPromptInjectionCop(config, router, modelSpec, {
  onDegraded: (detail) => {
    void eventBus.publish({
      type: "security_cop_degraded",
      summary: `prompt-injection cop degraded (${detail.cause}) on ${detail.source} — ${detail.errorMessage ?? "unparseable verdict"}`,
      timestamp: new Date().toISOString(),
    });
  },
}),
```

`createPromptInjectionCop` grows a fourth parameter — an optional observer. `disabledCop()` ignores it.

### Caller-side fail-closed

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L160), `scanUntrustedText` becomes:

```ts
async function scanUntrustedText(scanner, source, content, contentType) {
  const scan = await scanner.scan({ source, content, contentType });
  if (!scan.allowed) throw new Error(`Prompt injection blocked: ${scan.reason}`);
  if (scan.scanner === "degraded") {
    throw new Error(`Prompt injection scanner degraded; refusing untrusted content from ${source}: ${scan.reason}`);
  }
  return scan;
}
```

This is the single point where "we deliberately refuse to admit unscanned content to the worker LLM context" lives. The cop itself does not decide policy — it reports state. `disabledCop()` returns `scanner: "disabled"` and is unaffected (operators who turned the scanner off get fail-open as they explicitly chose).

### Why this is the right level

Per the project rule "architecture-first": the cop is a *control surface* (it inspects and reports), and the data-tool boundary is the *policy surface* (it decides what to do with the report). Mixing the two — letting the cop both classify and decide — was the original mistake. We separate them and the change happens to be small.

Per the project rule "no backward compat": the result shape changes, the test fixtures change with it, and the new `scanner: "degraded"` variant becomes part of the API. Nothing rolls over from the old shape.

## Alternative proposal (rejected): config-driven `failurePolicy` + counters

This is the shape the finding's `## Rough remediation direction` step 4 hints at and the more conceptual alternative.

### What it would look like

- `SaivageConfig.security` gains `failurePolicy: z.enum(["fail-open", "fail-closed"]).default("fail-closed")` (or similar) at [src/config.ts](../../../../src/config.ts#L112-L118).
- A new in-process counter façade (e.g. `src/observability/counters.ts`) with `incrementCounter("cop.failures_total")`, `incrementCounter("cop.scans_total")`. Exposed via a new `/api/metrics` or appended to `/api/runtime-state`.
- The cop reads `failurePolicy` and either returns `{ allowed: true, scanner: "degraded" }` or `{ allowed: false, verdict: "block", reason: "scanner degraded; failurePolicy=fail-closed" }`.
- The caller still does only `if (!scan.allowed) throw`.

### Why it is rejected

1. **Adds two new public surfaces** (a config key, a metrics façade) where one already-public surface (`EventBus.publish`) suffices. The dashboard already consumes `SystemEvent`s. We do not need a parallel transport for one new signal.
2. **The "fail-open" mode of the knob is indefensible.** A security cop that an operator can put into silent fail-open mode is the exact anti-pattern this finding criticises. Offering the knob legitimises it.
3. **Policy lives in the cop instead of at the call site.** This is the opposite of the analysis in §6 of the recommended proposal — the cop becomes both classifier and policy, which the recommended design explicitly separates. With one consumer today and an open door to other consumers (a future agent-prompt scanner, a memory-write scanner, …) tomorrow, baking policy into the cop forces every future consumer to inherit the same `failurePolicy` rather than choose its own (a Telegram-channel scanner has a different threat model than a `data.fetch_url` scanner).
4. **Counters duplicate `EventBus`.** The dashboard's "supervisor logs" feed and `/api/runtime-state` are already wired. A new counters surface is two more endpoints, two more web-UI consumers, two more tests, two more places to keep in sync. Per "no over-engineering", the EventBus path is sufficient.
5. **Architecture-first / no backward compat does not mean "add knobs to cover both behaviours indefinitely".** It means pick the right architecture and remove the wrong one. Fail-closed at the data tool *is* the right architecture; fail-open through a config knob is not worth supporting.

The one piece of the alternative that does have merit — counting scans for monitoring — is folded into the recommended design via the event bus: each `security_cop_degraded` event is a counter increment by another name, and dashboard consumers already aggregate events by type.

## Open design questions resolved

- **Should the cop log on the provider-unavailable branch?** Yes. The current silent path at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L86-L90) gets a `log.warn`. Same level as the LLM-call failure path for parity.
- **Should `parseModelVerdict` failure publish an event?** Yes. Same `cause: "llm_unparseable"`. This was the silent-fail path that operators are *least* likely to notice without telemetry.
- **Does the observer callback need to be async?** No. `EventBus.publish` returns a `Promise`, but observer invocation is fire-and-forget — the cop returns the scan result without awaiting. `void eventBus.publish(...)` is intentional; a stalled bus subscriber must not block scanning.
- **Why not put the observer in `createPromptInjectionCop`'s parameter list as a required arg?** Because `disabledCop()` does not need it, and call sites in tests that exercise `DefaultPromptInjectionCop` directly should not be forced to construct a stub observer. Optional with a no-op default keeps tests narrow.
