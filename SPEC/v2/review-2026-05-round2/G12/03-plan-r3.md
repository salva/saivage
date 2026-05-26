# G12 — Plan (Round 3)

**Companion docs**: [01-analysis-r3.md](01-analysis-r3.md), [02-design-r3.md](02-design-r3.md)
**R2 review addressed**: [04-review-r2.md](04-review-r2.md) (2 required changes)

All edits land in [saivage](../../../../) (Saivage v2 tree). No changes to `saivage-v3/`.

## R3 deltas vs R2

| Area | R2 plan | R3 plan |
| --- | --- | --- |
| E2 helper (`redactError`) | Two sequential regexes; conflicted with E9 #9's exact-string assertion on the canonical bearer-in-Authorization input | Second regex grows a negative lookahead `(?!Bearer\s+<redacted>\b)` so `"Bearer <redacted>"` survives intact. Helper output for the canonical input is `"HTTP 401: Authorization: Bearer <redacted>"`. |
| E9 #9 test | Asserted observer's `errorMessage` contains both `"Bearer <redacted>"` and `"authorization <redacted>"` (substring) | Asserts the canonical sanitized output as a stable string and three behavioral invariants (no raw secret, no newline, length ≤ 240). Asserts `"Bearer <redacted>"` is present. Drops the second-marker expectation. |
| E12 (MCP fail-closed test) | Awaited `runtime.callTool(...)` and read `.isError` from the resolved value | Uses `.rejects.toThrow(/scanner degraded/)` for all four data tools. For `download_with_fallbacks`, inspects target-file absence, manifest presence, and persisted-attempts-contain-`"scanner degraded"` after the rejection is observed. |

Everything else in [03-plan-r2.md](03-plan-r2.md) (E1, E3–E8, E10, E11, E13, E14, validation, acceptance) is unchanged unless explicitly noted below.

## Edit set — R3 changes only

### E2 — Redaction helpers (R3 update)

File: [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts) (same file as E1; helpers at module scope, not exported)

`inferSourceKind` and `redactSource` are unchanged from R2 ([03-plan-r2.md](03-plan-r2.md#L131-L150)).

`redactError` becomes:

```ts
function redactError(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] ?? raw;
  const scrubbed = firstLine
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
    .replace(
      /(authorization|api[-_]?key|token)\s*[:=]\s*(?!Bearer\s+<redacted>\b)[^\s,;]+/gi,
      "$1 <redacted>",
    );
  return scrubbed.length > 240 ? scrubbed.slice(0, 237) + "..." : scrubbed;
}
```

Sole difference vs R2: the negative lookahead `(?!Bearer\s+<redacted>\b)` in the second `replace`. Rationale and worked examples in [02-design-r3.md](02-design-r3.md).

The helpers remain private to the module. Indirect coverage through the public `scan(...)` path (driving redacted output into the observer detail) is the contract surface.

### E9 — Cop tests (R3 update for #9 only)

File: [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts)

All tests in R2's E9 list ([03-plan-r2.md](03-plan-r2.md#L329-L388)) — items #1 through #12 — are kept as planned, except **#9 is rewritten**:

#### #9 (R3) — "redacts bearer tokens and credential-shaped substrings in observer error message"

```ts
it("redacts bearer tokens and credential-shaped substrings in observer error message", async () => {
  const observer = makeRecordingObserver();
  const router = makeRouterThrowing(
    new Error("HTTP 401: Authorization: Bearer abcd1234.efghij"),
  );
  const cop = makeCop(router, observer);

  const result = await cop.scan({
    source: "https://example.com/path",
    content: "benign",
    contentType: "text/plain",
    toolName: "fetch_url",
    sourceKind: "url",
  });

  expect(result.scanner).toBe("degraded");
  expect(observer.events).toHaveLength(1);

  const msg = observer.events[0]!.errorMessage ?? "";
  // Canonical sanitized output.
  expect(msg).toBe("HTTP 401: Authorization: Bearer <redacted>");
  // Behavioral invariants (per [02-design-r3.md](02-design-r3.md)):
  expect(msg).not.toContain("abcd1234");
  expect(msg).not.toContain("efghij");
  expect(msg).not.toMatch(/[\r\n]/);
  expect(msg.length).toBeLessThanOrEqual(240);
  expect(msg).toContain("Bearer <redacted>");
});

it("redacts api_key credentials when no bearer is present", async () => {
  const observer = makeRecordingObserver();
  const router = makeRouterThrowing(
    new Error("HTTP 403: api_key=ZZZZsecret123"),
  );
  const cop = makeCop(router, observer);

  await cop.scan({
    source: "https://example.com/x",
    content: "benign",
    contentType: "text/plain",
    toolName: "fetch_url",
    sourceKind: "url",
  });

  const msg = observer.events[0]!.errorMessage ?? "";
  expect(msg).not.toContain("ZZZZsecret123");
  expect(msg).toContain("api_key <redacted>");
  expect(msg.length).toBeLessThanOrEqual(240);
});

it("collapses multi-line errors to first line and caps length", async () => {
  const observer = makeRecordingObserver();
  const long = "X".repeat(300);
  const router = makeRouterThrowing(new Error(`top line: ${long}\n  at frame1\n  at frame2`));
  const cop = makeCop(router, observer);

  await cop.scan({
    source: "https://example.com/x",
    content: "benign",
    contentType: "text/plain",
    toolName: "fetch_url",
    sourceKind: "url",
  });

  const msg = observer.events[0]!.errorMessage ?? "";
  expect(msg).not.toMatch(/[\r\n]/);
  expect(msg).not.toContain("frame1");
  expect(msg).not.toContain("frame2");
  expect(msg.length).toBeLessThanOrEqual(240);
  expect(msg.endsWith("...")).toBe(true);
});
```

Three sibling tests around the same redactor. The first is the canonical-input test the R2 review flagged. The second exercises the non-bearer branch (which the R2 helper already handled correctly, but R2 did not pin a test). The third pins the multi-line and length-cap behaviour as testable invariants.

Tests #1–#8 and #10–#12 from R2's E9 list are unchanged.

### E12 — MCP fail-closed test (R3 rewrite)

File: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)

R2's E12 ([03-plan-r2.md](03-plan-r2.md#L497-L546)) is replaced wholesale. The new test follows the existing prompt-injection test idiom at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L221-L262) and the existing `download_with_fallbacks` failure-path idiom at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L207-L219).

Inserted immediately after "does not write downloaded files rejected by the prompt-injection cop" at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L243-L262):

```ts
it(
  "fails closed when the prompt-injection cop is degraded across fetch_url, fetch_page_text, download_file, and download_with_fallbacks",
  async () => {
    const degradedCop: PromptInjectionCop = {
      async scan() {
        return {
          allowed: true,
          verdict: "allow",
          reason: "scanner degraded (llm_call_failed): HTTP 500 upstream",
          confidence: 0,
          scanner: "degraded",
        };
      },
    };
    registerBuiltinServices(runtime, cfg.mcp, { promptInjectionCop: degradedCop });

    await withTextServer("benign content", async (url) => {
      // 1. fetch_url — runtime throws because the handler returns isError.
      await expect(runtime.callTool("data", "fetch_url", { url }))
        .rejects.toThrow(/scanner degraded/);

      // 2. fetch_page_text — same contract.
      await expect(runtime.callTool("data", "fetch_page_text", { url }))
        .rejects.toThrow(/scanner degraded/);

      // 3. download_file — same contract; verify no file written.
      const dlPath = "cache/source-a/dl.txt";
      await expect(runtime.callTool("data", "download_file", { url, path: dlPath }))
        .rejects.toThrow(/scanner degraded/);
      expect(existsSync(join(projectRoot, dlPath))).toBe(false);

      // 4. download_with_fallbacks — same contract; verify manifest preserves cause.
      const fbPath = "cache/source-a/fb.txt";
      const manifestRel = "tmp/g12/fb-manifest.json";
      await expect(runtime.callTool("data", "download_with_fallbacks", {
        urls: [url],
        path: fbPath,
        manifest_path: manifestRel,
        retries_per_url: 1,
      })).rejects.toThrow(/scanner degraded/);

      // Side-effect assertions inspected separately from the rejected promise:
      // target file absent, manifest present, persisted attempts retain the cause.
      expect(existsSync(join(projectRoot, fbPath))).toBe(false);

      const manifestAbs = join(projectRoot, manifestRel);
      expect(existsSync(manifestAbs)).toBe(true);
      const persisted = JSON.parse(readFileSync(manifestAbs, "utf-8")) as {
        error?: string;
        path?: string;
        attempts?: Array<{ url?: string; error?: string }>;
      };
      expect(persisted.error).toBe("All download sources failed");
      expect(persisted.path).toBe(fbPath);
      expect(persisted.attempts ?? []).not.toHaveLength(0);
      expect(
        (persisted.attempts ?? []).some(a => (a.error ?? "").includes("scanner degraded")),
      ).toBe(true);
    });
  },
);
```

Key contract notes for the implementer:

- The runtime serialises the in-process tool result's `content` and embeds it in the thrown `Error.message`. For `download_with_fallbacks`, the content includes the `attempts[]` array, each entry's `error` carries the literal `"scanner degraded"` substring, so `.rejects.toThrow(/scanner degraded/)` matches the rejection text directly from the runtime ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L192) and [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L200-L204)).
- The filesystem side effects (target absent, manifest present, manifest content) are inspected with `existsSync` + `readFileSync` + `JSON.parse`, matching the existing R2 test idiom for the no-cop fallback case at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L213-L218).
- The substring check on `persisted.attempts[].error` is the operator-facing proof that the manifest does not mask the security failure as an ordinary network miss. The aggregate `persisted.error` stays `"All download sources failed"` (that is mechanically the case), but the per-attempt cause is preserved.

Required imports at the top of the test file (R2 already lists most of these; confirm `readFileSync` is imported in the `node:fs` import block — it is, per the existing manifest test at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1-L20)):

- `existsSync`, `readFileSync` — already imported.
- `join` from `node:path` — already imported.
- `PromptInjectionCop` type — already imported.

No new fixture, no new helper, no new module-level state.

### E1, E3–E8, E10, E11, E13, E14

Unchanged from R2. See [03-plan-r2.md](03-plan-r2.md):

- E1 — Cop: structured degraded result + observer hook (all five causes) ([03-plan-r2.md](03-plan-r2.md#L26-L116)).
- E3 — Bootstrap: ring + reordering + observer wire-up ([03-plan-r2.md](03-plan-r2.md#L167-L207)).
- E4 — `SystemEvent` taxonomy + severity ([03-plan-r2.md](03-plan-r2.md#L209-L218)).
- E5 — New module `SecurityStatusRing` ([03-plan-r2.md](03-plan-r2.md#L220-L270)).
- E6 — New `GET /api/debug/security` route ([03-plan-r2.md](03-plan-r2.md#L272-L282)).
- E7 — DebugView Security tab ([03-plan-r2.md](03-plan-r2.md#L284-L327)).
- E8 — MCP boundary: fail-closed + toolName propagation ([03-plan-r2.md](03-plan-r2.md#L329-L355)).
- E10 — `SecurityStatusRing` tests ([03-plan-r2.md](03-plan-r2.md#L455-L463)).
- E11 — `EventBus` severity test ([03-plan-r2.md](03-plan-r2.md#L465-L475)).
- E13 — `SaivageRuntime` shutdown cleanup ([03-plan-r2.md](03-plan-r2.md#L548-L552)).
- E14 — Touch-up grep ([03-plan-r2.md](03-plan-r2.md#L554-L560)).

## Out of edit set (R3)

Same as R2 ([03-plan-r2.md](03-plan-r2.md#L562-L570)). R3 introduces no new excluded items.

## Validation

V0–V7 from R2 ([03-plan-r2.md](03-plan-r2.md#L572-L658)) are unchanged. R3 adds no new validation step; the changes are mechanically covered by V2 (focused vitest of [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) and [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)) and V3 (full vitest).

For convenience, the V2 invocation:

```bash
npx vitest run src/security/prompt-injection-cop.test.ts src/security/status-ring.test.ts src/mcp/builtins.test.ts src/events/bus.test.ts
```

This single command exercises E9 #9 (R3), E9 sibling tests for `api_key` and multi-line, and E12 (R3).

## Operator-gated saivage-v3 restart

Unchanged from R2: not required for G12. All R3 edits remain in `/home/salva/g/ml/saivage` (Saivage v2). No container restart is part of normal implementation.

## Acceptance

The R2 acceptance criteria ([03-plan-r2.md](03-plan-r2.md#L668-L678)) hold. R3 refines two items:

- Item 5 (redaction tests): the canonical sanitized output for `"HTTP 401: Authorization: Bearer abcd1234.efghij"` is `"HTTP 401: Authorization: Bearer <redacted>"`. The redacted output also satisfies: no `"abcd1234"`/`"efghij"` substring, no newline, length ≤ 240, contains `"Bearer <redacted>"`. URL-redaction assertions (no userinfo, no query, no fragment, signed-URL signature gone, oversize pathnames truncated with `"..."`) are unchanged.
- Item 6 (`download_with_fallbacks` test): the call rejects with `/scanner degraded/`; the target file is absent on disk; the manifest file is present on disk; the persisted `attempts` array contains at least one entry whose `error` field contains `"scanner degraded"`. The three other data tools (`fetch_url`, `fetch_page_text`, `download_file`) also reject with `/scanner degraded/`. `download_file` also verifies the target file is absent on disk.

All other R2 acceptance criteria (E1–E13 implemented and merged; V0, V0b, V1, V2, V3, V4, V5, V6a, V6b pass; all five no-scan branches route to typed degraded; old `"llm unavailable; allowing"` string is gone; no `failurePolicy` knob; no parallel metrics façade) are unchanged.
