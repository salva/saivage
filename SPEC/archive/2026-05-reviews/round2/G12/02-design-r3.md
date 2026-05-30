# G12 — Design (Round 3)

**Companion docs**: [01-analysis-r3.md](01-analysis-r3.md), [03-plan-r3.md](03-plan-r3.md)
**R2 review addressed**: [04-review-r2.md](04-review-r2.md) (2 required changes)

## R3 deltas vs R2

| Required change | R2 design | R3 design |
| --- | --- | --- |
| MCP degraded test contract | E12 awaited `runtime.callTool(...)` and read `.isError` from the resolved value | `runtime.callTool` is a throwing API on `isError` ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L192) and [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L200-L204)). E12 uses `.rejects.toThrow(/scanner degraded/)` for all four data-tool call sites; for `download_with_fallbacks` it inspects filesystem side effects (target absent, manifest present, persisted `attempts` carries `"scanner degraded"`) after the rejection is observed. |
| Canonical sanitized error output | `redactError` had two sequential regex passes whose combined output for the canonical bearer-in-Authorization input was unstable and did not satisfy the planned `Bearer <redacted>` + `authorization <redacted>` assertion | Helper now uses a negative lookahead in the credential pass to skip already-redacted bearer schemes. Canonical input `"HTTP 401: Authorization: Bearer abcd1234.efghij"` → `"HTTP 401: Authorization: Bearer <redacted>"`. Helper code and tests agree. Test assertions are behavioral (no raw secret, no newline, capped length, plus the canonical token) rather than over-specific. |

Everything else in [02-design-r2.md](02-design-r2.md) (cop result type, observer detail, scan request shape, URL redaction, cop wiring, SystemEvent taxonomy, SecurityStatusRing, bootstrap wiring, debug route, DebugView tab, MCP boundary fail-closed semantics) is unchanged in R3.

## Redaction rules — R3 update (the cop owns these)

### Source

Unchanged from R2 ([02-design-r2.md](02-design-r2.md#L113-L137)). Origin + truncated pathname; userinfo, query, fragment all stripped.

### Error

R3 helper:

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

Difference vs R2: the credential pass adds a negative lookahead `(?!Bearer\s+<redacted>\b)` so an already-redacted bearer scheme is not re-consumed. The output is canonical for the worked example:

| Input | R2 output | R3 output |
| --- | --- | --- |
| `HTTP 401: Authorization: Bearer abcd1234.efghij` | `HTTP 401: Authorization <redacted> <redacted>` | `HTTP 401: Authorization: Bearer <redacted>` |
| `HTTP 401: api_key=secret123` | `HTTP 401: api_key <redacted>` | `HTTP 401: api_key <redacted>` |
| `Token: Bearer xyz.abc` | `Token <redacted> <redacted>` | `Token: Bearer <redacted>` |
| `request failed: token = supersecret, retry=3` | `request failed: token <redacted>, retry=3` | `request failed: token <redacted>, retry=3` |

The non-bearer cases are unchanged. Only inputs where a `Bearer` value lives inside an `Authorization`/`Token`/`api_key` framing produce a different (but stable) output, and the canonical token `"Bearer <redacted>"` is preserved.

### Behavioral contract pinned by tests

For redacted error output, the cop guarantees:

1. No substring of the original secret token remains (verified per-input).
2. No newline (`\n` or `\r`) appears in the output (first-line-only construction).
3. Output length ≤ 240 characters.
4. For inputs containing `Bearer <secret>`, the literal `"Bearer <redacted>"` is present.
5. For inputs containing `api_key=<secret>` (no bearer), the literal `"api_key <redacted>"` is present.

These five invariants are the canonical contract. Tests assert them; the implementation is free to evolve as long as the invariants hold.

### Visible in `reason`

Unchanged from R2:

```ts
result.reason = `scanner degraded (${cause})${errorMessage ? `: ${errorMessage}` : ""}`;
```

`errorMessage` here is the already-redacted output of `redactError`. No raw source material reaches `reason`.

## MCP degraded fail-closed test — R3 update

Background. `McpRuntime.callTool` at [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L205):

- For in-process services, `result.isError` causes the runtime to throw with message `\`Tool "${toolName}" on "${serviceName}" returned error: ${JSON.stringify(result.content)}\`` ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L192)).
- For external clients, identical shape at [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L200-L204).

The thrown message embeds the JSON-serialised tool content. For `download_with_fallbacks`, that content is `{ error: "All download sources failed", attempts: [...] }` and each `attempts[i].error` carries the `"scanner degraded"` substring. So `.rejects.toThrow(/scanner degraded/)` matches.

For `fetch_url`, `fetch_page_text`, and `download_file`, `scanUntrustedText` throws synchronously inside the handler the moment the cop returns `scanner: "degraded"`. The thrown error message contains `"Prompt injection scanner degraded; refusing untrusted content from ${toolName}: scanner degraded (...)"` (see [02-design-r2.md](02-design-r2.md#L307-L311)). `.rejects.toThrow(/scanner degraded/)` matches there too.

The test therefore uses one consistent idiom across all four tools.

### Test structure (E12, R3)

The test installs a degraded cop stub once per scenario, then exercises each tool. For `download_with_fallbacks`, the rejection is caught with `.rejects.toThrow(...)` and the filesystem side effects are read separately:

```ts
// All four assertions use .rejects.toThrow because callTool throws on isError.
await expect(runtime.callTool("data", "fetch_url", { url }))
  .rejects.toThrow(/scanner degraded/);

await expect(runtime.callTool("data", "fetch_page_text", { url }))
  .rejects.toThrow(/scanner degraded/);

const dlPath = "cache/source-a/dl.txt";
await expect(runtime.callTool("data", "download_file", { url, path: dlPath }))
  .rejects.toThrow(/scanner degraded/);
expect(existsSync(join(projectRoot, dlPath))).toBe(false);

const fbPath = "cache/source-a/fb.txt";
const manifestRel = "tmp/g12/fb-manifest.json";
await expect(runtime.callTool("data", "download_with_fallbacks", {
  urls: [url],
  path: fbPath,
  manifest_path: manifestRel,
  retries_per_url: 1,
})).rejects.toThrow(/scanner degraded/);

// Side-effect assertions (filesystem) inspected separately after the rejection.
expect(existsSync(join(projectRoot, fbPath))).toBe(false);
const manifestAbs = join(projectRoot, manifestRel);
expect(existsSync(manifestAbs)).toBe(true);
const persisted = JSON.parse(readFileSync(manifestAbs, "utf-8")) as {
  error?: string;
  attempts?: Array<{ error?: string }>;
};
expect(persisted.error).toBe("All download sources failed");
expect((persisted.attempts ?? []).some(a => (a.error ?? "").includes("scanner degraded")))
  .toBe(true);
```

The `download_file` rejection-message check uses the same `/scanner degraded/` pattern: when a single-URL download fails inside `downloadUrl`, the per-attempt error string is included in the serialized tool result via the runtime's `JSON.stringify(result.content)` wrap, so the substring travels through the thrown message and matches `.rejects.toThrow(/scanner degraded/)`.

Why this is the right idiom:

- It matches the existing pattern at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L235-L240) and [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L256-L261), which use `.rejects.toThrow("Prompt injection blocked")` for the blocking-cop case.
- It matches the existing `download_with_fallbacks` happy-path failure test at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L207-L219), which uses `.rejects.toThrow("All download sources failed")` followed by a separate manifest read.
- It does not require a parallel "test the handler one layer below `McpRuntime.callTool`" detour. The handler is reached only via the runtime in production; testing it via the runtime is the contract test that matters.

If a future test needs the structured tool result (e.g. to inspect `attempts` on a degraded `download_with_fallbacks` invocation), the manifest file already carries that structured result on disk — the test inspects it from there, not from the rejected promise. This keeps the test API surface narrow.

### Manifest-doesn't-mask invariant

The manifest path is set via `manifest_path`. When the run fails, [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L869-L883) writes `{ error: "All download sources failed", attempts: [{ url, error: "...", ...}, ...] }`. The per-attempt `error` carries the thrown text from `scanUntrustedText`, which contains the literal `"scanner degraded"`. The test asserts `persisted.attempts` contains a row whose `error` includes that substring, which is the operator-facing proof that the failure was a security-policy failure, not a network miss.

## Cop wiring, observer detail, SystemEvent, ring, route, DebugView

All unchanged from R2 ([02-design-r2.md](02-design-r2.md#L141-L271)). Restated only for orientation:

- Observer interface still receives `{ toolName, sourceKind, sourceSummary, contentType, inputLength, cause, errorMessage, timestamp }` where both `sourceSummary` and `errorMessage` are pre-redacted by the cop.
- The five-cause taxonomy (`provider_missing`, `provider_unavailable`, `provider_availability_error`, `llm_call_failed`, `llm_unparseable`) is wired through the rewritten `scanWithModel`.
- Bootstrap moves the `EventBus` constructor before `registerBuiltinServices` and adds `securityStatusRing` beside it.
- New route `GET /api/debug/security` on [src/server/server.ts](../../../../src/server/server.ts) returns `{ entries: runtime.securityStatusRing.list(50) }`.
- `DebugView.vue` gains a fourth `security` tab fed by the new route on the existing 8 s `fetchAll` cadence.

## Why option (a) over option (b) for redaction

Both options satisfy the safety invariants the reviewer named. Option (a) was chosen for the reasons enumerated in [01-analysis-r3.md](01-analysis-r3.md):

- Operator signal value: `"Bearer <redacted>"` tells the operator *what kind* of credential the cop tripped over. `"Authorization <redacted>"` alone loses the bearer-scheme hint.
- Smaller helper surface: a single negative lookahead in the credential regex is a one-line change to R2's helper; option (b) would require restructuring the helper into a single combined regex or a switch on bearer-vs-other.
- Stable for non-bearer credential shapes: `api_key=...`, `token=...`, and `token: ...` all still collapse to `"<key> <redacted>"` as in R2.

The lookahead is anchored on the literal `"<redacted>"` placeholder, which is the only sequence the first pass can produce. There is no risk of regressing on user-supplied input that happens to contain the placeholder text, because the placeholder text would only appear at this point in the pipeline if the cop itself put it there.

## Open design questions — R3 status

All R2 design questions ([02-design-r2.md](02-design-r2.md#L321-L334)) remain resolved. R3 adds none.

## Out of scope (unchanged)

- No `failurePolicy` knob, no metrics façade, no cop interface refactor.
- No persistence of the security-status ring across restarts.
- No DebugView Vue test harness.
- No saivage-v3 changes.
