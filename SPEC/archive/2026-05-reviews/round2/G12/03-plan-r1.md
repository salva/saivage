# G12 — Plan (Round 1)

**Companion docs**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md)

All edits are in [saivage](../../../../) (Saivage v2 tree). No changes to v3 (`saivage-v3/`).

## Edit set

### E1 — Extend SystemEvent taxonomy

File: [src/types.ts](../../../../src/types.ts)

At [src/types.ts](../../../../src/types.ts#L291-L307), add `"security_cop_degraded"` to the `type` enum array, immediately after `"plan_updated"`. No other field changes.

### E2 — Classify the new event severity

File: [src/events/bus.ts](../../../../src/events/bus.ts)

At [src/events/bus.ts](../../../../src/events/bus.ts#L27-L34), add `security_cop_degraded: "warning",` to `EVENT_SEVERITY`. (`Record<SystemEvent["type"], string>` is exhaustive, so the TS compiler will refuse to build without this entry — a free guard.)

### E3 — Cop: structured degraded result + observer hook

File: [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts)

- At [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L17-L24), change the `scanner` field union to `"llm" | "disabled" | "skipped" | "degraded"`.
- Define a new exported observer type beside the cop interface:

  ```ts
  export interface CopObserver {
    onDegraded(detail: CopDegradedDetail): void;
  }
  export interface CopDegradedDetail {
    source: string;
    contentType?: string;
    inputLength: number;
    cause: "provider_unavailable" | "llm_call_failed" | "llm_unparseable";
    errorMessage?: string;
  }
  ```

- At [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L30-L42), `createPromptInjectionCop` gains a fourth parameter `observer?: CopObserver`. When the cop is enabled, the observer is forwarded to `DefaultPromptInjectionCop`.
- `DefaultPromptInjectionCop` constructor takes a third optional argument `private observer?: CopObserver`. Drop the per-line JSDoc — no comments on changed code per project rules.
- Rewrite `scan` and `scanWithModel` so that:
  - The provider-availability catch at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L86-L90) now does `log.warn("[prompt-injection-cop] provider availability check failed: ...")` and returns a *typed degraded signal* (e.g. a tagged union or a thrown sentinel — implementer's choice) so `scan` can produce the new degraded result and call the observer.
  - The LLM-call catch at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L122-L126) reports `cause: "llm_call_failed"`.
  - The `parseModelVerdict` returning null path at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L117-L118) reports `cause: "llm_unparseable"` with `errorMessage` left undefined.
  - All three paths end in `scan(...)` returning `{ allowed: true, verdict: "allow", reason, confidence: 0, scanner: "degraded", model: this.options.modelSpec }` where `reason` is a short human-readable string.
  - The old "llm unavailable; allowing" return at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L68-L74) is deleted; that path is replaced by the degraded path. There is no migration shim.
- Observer is invoked with `void` semantics: `this.observer?.onDegraded(detail)` is called synchronously before returning. Any throw from the observer is swallowed inside a local `try/catch` that only `log.error`s — a faulty subscriber must not break the scanner.

### E4 — Bootstrap reordering + observer wire-up

File: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts)

- Move `const eventBus = new EventBus();` and the surrounding `// 8. Event bus` comment from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L200-L201) to just before step 4 (immediately before `const mcpRuntime = new McpRuntime(config);` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L144)). Renumber the comment to put the event bus first.
- At the `createPromptInjectionCop` call ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145-L151)), add the observer argument:

  ```ts
  promptInjectionCop: createPromptInjectionCop(
    config,
    router,
    config.security.injectionScanner ? routing.resolve("security").modelSpec : undefined,
    {
      onDegraded: (detail) => {
        void eventBus.publish({
          type: "security_cop_degraded",
          summary:
            `prompt-injection cop degraded (${detail.cause}) on ${detail.source}` +
            ` [${detail.inputLength}b${detail.contentType ? `, ${detail.contentType}` : ""}]` +
            (detail.errorMessage ? ` — ${detail.errorMessage}` : ""),
          timestamp: new Date().toISOString(),
        });
      },
    },
  ),
  ```

- Verify there is no other consumer of `eventBus` before the moved line — there isn't (analysis §4).

### E5 — Data tool: explicit fail-closed on degraded

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)

At [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L160), extend `scanUntrustedText` to refuse degraded results:

```ts
async function scanUntrustedText(
  scanner: PromptInjectionCop,
  source: string,
  content: string,
  contentType?: string,
): Promise<PromptInjectionScanResult> {
  const scan = await scanner.scan({ source, content, contentType });
  if (!scan.allowed) {
    throw new Error(`Prompt injection blocked: ${scan.reason}`);
  }
  if (scan.scanner === "degraded") {
    throw new Error(
      `Prompt injection scanner degraded; refusing untrusted content from ${source}: ${scan.reason}`,
    );
  }
  return scan;
}
```

No other change to builtins.ts is required — the four call sites at lines 214, 770, 802, 836 already pass through the new throw.

### E6 — Rewrite cop tests

File: [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts)

Per project rules: rewrite, not extend. Tests pin the new shape.

- "fails open when the LLM call throws" → renamed to "returns degraded result when the LLM call throws". Asserts:
  - `result.allowed === true` (still true — the cop reports, the caller decides)
  - `result.scanner === "degraded"`
  - The observer mock was invoked once with `cause: "llm_call_failed"`.
- "fails open when the LLM returns unparseable content" → "returns degraded result when the LLM returns unparseable content"; asserts `scanner === "degraded"` and observer called with `cause: "llm_unparseable"`.
- New test: "returns degraded when the provider's isAvailable throws"; uses a router whose `getProvider` returns a provider whose `isAvailable` rejects; asserts `cause: "provider_unavailable"`.
- New test: "an observer that throws is swallowed and a result still returned" (asserts the cop is robust to a broken subscriber).
- The "blocks/allows/disabled" tests are untouched apart from the `scanner` enum string check (still `"llm"` / `"disabled"`).
- A small helper `makeRecordingObserver()` returns `{ events: CopDegradedDetail[]; onDegraded(d): void }`.

### E7 — Add a builtins fail-closed test

File: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)

After the existing "blocks fetched content rejected by the prompt-injection cop" test at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L221), add: "fails closed when the prompt-injection cop is degraded".

The test passes a `PromptInjectionCop` whose `scan` returns `{ allowed: true, verdict: "allow", reason: "...", confidence: 0, scanner: "degraded" }`, then asserts that `fetch_url`, `fetch_page_text`, and `download_file` all throw with a message containing `"scanner degraded"` and that no file is written for `download_file`. (Combine into one test using three sub-assertions to match the existing file's grain.)

### E8 — Add an event bus test for the new type

File: [src/events/bus.test.ts](../../../../src/events/bus.test.ts)

Add one assertion that publishing `{ type: "security_cop_degraded", summary: "x" }` to a subscriber with `filter: { minSeverity: "warning" }` reaches the subscriber, and that the same subscriber with `filter: { minSeverity: "error" }` does not. (Reuses existing helper patterns; one new `it(...)` block.)

### E9 — Touch-up any direct destructuring of the cop result

Run a workspace grep (see Validation §V0 below). At the time of writing, the only consumers outside the cop module's own tests are in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) (handled by E5). No agent code reads `PromptInjectionScanResult` fields directly. Confirm this during implementation; if any other consumer surfaces, audit it before proceeding.

## Out of edit set (explicitly)

- No change to `SaivageConfig.security` ([src/config.ts](../../../../src/config.ts#L112-L118)).
- No new `src/observability/` module.
- No web-UI changes — the new event lands in the existing event feed (warning severity) and is rendered by the existing dashboard event renderers.
- No JSDoc/docstring/comment additions on lines that did not change.
- No changes to `disabledCop()` semantics.
- No saivage-v3 changes; this finding is scoped to saivage v2.

## Validation

Run from `saivage/` (i.e. `cd /home/salva/g/ml/saivage`).

### V0 — Confirm consumer surface

```bash
rg -n "PromptInjectionScanResult|promptInjectionCop|prompt_injection_scan|cop\\.scan|scan\\(\\s*\\{" --type ts -g '!**/node_modules/**'
```

Expected non-test consumers: [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts). Anything else is a new hit that the plan must absorb before continuing.

### V1 — Typecheck

```bash
npx tsc --noEmit
```

Must be clean. `EVENT_SEVERITY` exhaustiveness (E2) and `scanner` union widening (E3) are the two compile-time anchors.

### V2 — Focused vitest

```bash
npx vitest run src/security/prompt-injection-cop.test.ts src/mcp/builtins.test.ts src/events/bus.test.ts
```

All tests pass. The two rewritten tests in E6 and the new ones in E6/E7/E8 are the meaningful coverage.

### V3 — Full vitest

```bash
npx vitest run
```

Catches any incidental consumer that destructures `scanner`/`reason` (e.g. in integration tests for the data tool).

### V4 — Build (tsup)

```bash
npm run build
```

Confirms the prompts/ assets and the dist bundle still ship. Required because [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) is in the entry graph.

### V5 — Lint (no-emit)

```bash
npx eslint --max-warnings 0 src/security/prompt-injection-cop.ts src/mcp/builtins.ts src/events/bus.ts src/types.ts src/server/bootstrap.ts
```

Project rule "no over-engineering" plus the project's eslint config will catch a stray `any` or an unused-import on the new observer surface.

## Operator-gated saivage-v3 restart

**Not required.** This change is local to the saivage v2 tree (`/home/salva/g/ml/saivage`). The saivage-v3 harness at 10.0.3.112 runs its own build of [saivage-v3/src](../../../../../saivage-v3/src) and is unaffected by edits under `saivage/src`. Do not restart `saivage.service` on `saivage-v3` or `saivage-v3-getrich-v2` for this finding.

If, during implementation, the saivage v2 dist is being exercised against a live container (e.g. the legacy `saivage` LXC at 10.0.3.111 running on GetRich), the operator decides whether to restart that service. The default for this finding is "no restart".

## Acceptance

The finding is closed when:

1. The recommended design ([02-design-r1.md](02-design-r1.md)) is implemented per E1–E8.
2. V1–V4 pass.
3. A new `security_cop_degraded` event reaches subscribers in the test suite and (manually verified, optional) in a smoke run.
4. The data-tool fetch family throws on a degraded cop instead of admitting unscanned content. Covered by E7.
5. No `failurePolicy` config knob exists and no parallel metrics façade has been introduced.
