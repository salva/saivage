# G31 — Implementation Plan r2

**Chosen design**: Proposal A from
[02-design-r2.md §1-§3](02-design-r2.md).

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Round 1**: [03-plan-r1.md](03-plan-r1.md); reviewer critique
[04-review-r1.md](04-review-r1.md). Round-2 changes addressed:
byte-accounting (§5), McpRuntime error contract used by all tests
(§7), structured `INVALID_ARGUMENT` coverage (§7 case 7), file-head
NUL probe regression for non-zero offset (§7 case 8), offset-at-EOF
behaviour (§7 case 9), refreshed anchors (§0, §5), corrected
verification checklist (§5).

## 0. Pre-flight (refreshed anchors)

1. **Confirm G30 has landed.** Live source still has sync imports at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26) and
   the sync `read_file` body at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278).
   G31 cannot land first. After G30, verify by grep:

   ```bash
   grep -nE "^import .*(closeSync|readFileSync|readSync|openSync|statSync)" src/mcp/builtins.ts
   # → empty
   grep -n "no-sync-fs" src/mcp/
   # → src/mcp/no-sync-fs.test.ts exists per ../G30/APPROVED.md
   ```

2. **Re-anchor the line numbers used below.** All anchors in this
   plan and in [02-design-r2.md](02-design-r2.md) are the live
   pre-G30 numbers. G30 changes the same regions. Before editing,
   capture the post-G30 lines:

   ```bash
   grep -n 'case "read_file"' src/mcp/builtins.ts
   grep -n 'name: "read_file"' src/mcp/builtins.ts
   grep -n "function parseOptionalTimeoutMs" src/mcp/builtins.ts
   grep -n "MAX_OUTPUT = mcpConfig.maxOutputBytes" src/mcp/builtins.ts
   grep -nE "maxOutputBytes: z\.number" src/config.ts
   ```

   Use those numbers as the targets for steps 1-5 below.

3. `git status` clean on `src/mcp/builtins.ts`,
   `src/mcp/builtins.test.ts`, `src/config.ts`,
   `src/config.test.ts`, and the inline-`mcp:` test files in §9.

4. `npm run build` green (baseline).

## 1. Add the config field

Edit the `mcp` block at
[src/config.ts](../../../../src/config.ts#L137-L147), append after
`maxDownloadBytes`:

```ts
maxFileReadBytes: z.number().default(200_000),
```

No new `superRefine` rule (independent of shell-timeout invariants).

## 2. Module-level let + register-time wiring

Edit [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L43)
(re-anchor per §0). Insert next to the existing caps:

```ts
let MAX_FILE_READ_BYTES = 200_000;
```

Edit [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1080)
(re-anchor per §0). Inside `registerBuiltinServices`, after
`MAX_DOWNLOAD_BYTES = mcpConfig.maxDownloadBytes;`:

```ts
MAX_FILE_READ_BYTES = mcpConfig.maxFileReadBytes;
```

## 3. Add the `parseNonNegativeInt` helper

Insert immediately above `parseOptionalTimeoutMs` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L375)
(re-anchor per §0):

```ts
function parseNonNegativeInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    !Number.isInteger(raw)
  ) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return raw;
}
```

## 4. Replace the `read_file` schema and handler

Edit the schema at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L243-L246)
with the form spelled out in
[02-design-r2.md §3.3](02-design-r2.md).

Edit the handler body at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278)
with the body spelled out in
[02-design-r2.md §3.4](02-design-r2.md). Critical points the
implementer must not skip:

- The argument-parsing `try/catch` translates thrown helper errors
  into the `INVALID_ARGUMENT` envelope (reviewer concern 3).
- `totalSize` is taken from `st.size` once and used everywhere
  afterwards.
- The NUL probe runs against `[0, min(4096, totalSize))` via a
  dedicated `handle.read(probeBuffer, 0, probeSize, 0)` call,
  independent of `effectiveOffset` (reviewer concern 4).
- The window read returns `{ bytesRead }`; the envelope reports
  `length: bytesRead` and slices `windowBuffer.subarray(0,
  windowBytes)` before decoding (reviewer concern 1).
- `offset === totalSize` is a valid empty success
  (reviewer concern 5).

After editing, audit `node:fs/promises` imports introduced by G30:
if any symbol is no longer referenced (`readFile` is a candidate
depending on how G30 rewrote the sibling handlers), remove the dead
import. Verify with `grep -c "<symbol>(" src/mcp/builtins.ts` from
the terminal — VS Code edit buffers have drifted on this file
before, per the workspace memory note on long-TS edit drift.

## 5. Terminal verification (corrected from r1)

After steps 1-4, from the terminal in `saivage/`:

```bash
# Config field present
grep -n "maxFileReadBytes" src/config.ts                 # 1 line, in mcp{}

# Module cap wired both at declaration and at register time
grep -n "let MAX_FILE_READ_BYTES" src/mcp/builtins.ts    # 1 line, near other lets
grep -n "MAX_FILE_READ_BYTES = mcpConfig.maxFileReadBytes" src/mcp/builtins.ts
                                                          # 1 line, in registerBuiltinServices

# Each documented error code appears at least once in the new handler
for code in FILE_TOO_LARGE LENGTH_TOO_LARGE INVALID_RANGE \
            BINARY_CONTENT NOT_A_FILE INVALID_ARGUMENT; do
  echo "$code: $(grep -c "code: \"$code\"" src/mcp/builtins.ts)"
done
# Each must print "<code>: 1" (or more if reused in nested branches).

# Helper added
grep -n "function parseNonNegativeInt" src/mcp/builtins.ts   # 1 line

# G30 invariant preserved
grep -nE "(readFileSync|readSync|openSync|closeSync|statSync)" src/mcp/builtins.ts
# → empty
```

Do not assert exact total occurrence counts (the r1 plan's
`MAX_FILE_READ_BYTES → 3` check was wrong because the new handler
references the symbol from multiple branches; reviewer concern 7).

## 6. Update the existing read_file happy-path test

Edit
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L69-L72).
Replace:

```ts
await expect(runtime.callTool("filesystem", "read_file", { path: "README.md" }))
  .resolves.toEqual({ content: "hello" });
```

with:

```ts
await expect(runtime.callTool("filesystem", "read_file", { path: "README.md" }))
  .resolves.toMatchObject({
    content: "hello",
    offset: 0,
    length: 5,
    size_bytes: 5,
    truncated: false,
  });
```

The "rejects filesystem access outside the project root" case at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L75-L77)
is unchanged — `resolvePath` throws before the new handler runs.

## 7. Add G31-specific regression tests

Append a new `describe("read_file size cap (G31)", ...)` block to
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).
Tests use `cfg.mcp.maxFileReadBytes` directly so they follow the
config; lower the cap in the existing `beforeEach` config-write at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L46-L55)
to `1024` for these tests:

```ts
mcp: { shellTimeoutFloorMs: 0, maxFileReadBytes: 1024 },
```

All error cases assert through the `McpRuntime.callTool` thrown-error
contract at
[src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193): the
runtime stringifies the structured `content` into the error message,
so matching on the embedded `code` substring is reliable.

### Case 1 — `FILE_TOO_LARGE` on whole-file read above cap

```ts
const MAX = cfg.mcp.maxFileReadBytes;
writeFileSync(join(projectRoot, "big.log"), "x".repeat(MAX + 1));
await expect(runtime.callTool("filesystem", "read_file", { path: "big.log" }))
  .rejects.toThrow(/FILE_TOO_LARGE/);
```

### Case 2 — windowed read returns the requested slice

```ts
writeFileSync(join(projectRoot, "win.log"), "abcdefghijklmnop");
await expect(runtime.callTool("filesystem", "read_file",
  { path: "win.log", offset: 4, length: 4 }))
  .resolves.toMatchObject({
    content: "efgh",
    offset: 4,
    length: 4,
    size_bytes: 16,
    truncated: true,
  });
```

### Case 3 — `LENGTH_TOO_LARGE` when `length > cap`

```ts
writeFileSync(join(projectRoot, "ok.txt"), "hi");
await expect(runtime.callTool("filesystem", "read_file",
  { path: "ok.txt", length: cfg.mcp.maxFileReadBytes + 1 }))
  .rejects.toThrow(/LENGTH_TOO_LARGE/);
```

### Case 4 — `INVALID_RANGE` when `offset > size`

```ts
writeFileSync(join(projectRoot, "small.txt"), "abc");
await expect(runtime.callTool("filesystem", "read_file",
  { path: "small.txt", offset: 99 }))
  .rejects.toThrow(/INVALID_RANGE/);
```

### Case 5 — `BINARY_CONTENT` on a NUL-containing file (no window)

```ts
writeFileSync(join(projectRoot, "bin.dat"), Buffer.from([1, 2, 0, 4]));
await expect(runtime.callTool("filesystem", "read_file", { path: "bin.dat" }))
  .rejects.toThrow(/BINARY_CONTENT/);
```

### Case 6 — `truncated: false` and length === bytesRead when file fits

```ts
writeFileSync(join(projectRoot, "tiny.txt"), "hi");
await expect(runtime.callTool("filesystem", "read_file", { path: "tiny.txt" }))
  .resolves.toMatchObject({
    content: "hi",
    offset: 0,
    length: 2,
    size_bytes: 2,
    truncated: false,
  });
```

(This case also exercises the probe/window buffer-reuse path in
[02-design-r2.md §3.4](02-design-r2.md), since `offset === 0 &&
toRead ≤ probeBytes`.)

### Case 7 — `INVALID_ARGUMENT` for malformed offset/length

Each invocation must surface a structured envelope (reviewer
concern 3); negative, fractional, NaN, and string values all funnel
through the same `parseNonNegativeInt` → `INVALID_ARGUMENT` path:

```ts
writeFileSync(join(projectRoot, "tiny.txt"), "hi");
for (const bad of [-1, 1.5, "0", Number.NaN]) {
  await expect(runtime.callTool("filesystem", "read_file",
    { path: "tiny.txt", offset: bad as never }))
    .rejects.toThrow(/INVALID_ARGUMENT/);
}
for (const bad of [-1, 1.5, "0", Number.NaN]) {
  await expect(runtime.callTool("filesystem", "read_file",
    { path: "tiny.txt", length: bad as never }))
    .rejects.toThrow(/INVALID_ARGUMENT/);
}
```

### Case 8 — `BINARY_CONTENT` fires even when the requested window has no NULs

Reviewer concern 4: the file-head probe runs independently of
`offset`. Construct a file whose head contains a NUL but whose later
window is plain ASCII; a non-zero-offset read must still be
rejected:

```ts
// NUL at byte 1; window [4, 8) is all ASCII.
writeFileSync(join(projectRoot, "head-nul.dat"),
  Buffer.from([0x41, 0x00, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]));
await expect(runtime.callTool("filesystem", "read_file",
  { path: "head-nul.dat", offset: 4, length: 4 }))
  .rejects.toThrow(/BINARY_CONTENT/);
```

### Case 9 — offset equal to file size returns empty content

Reviewer concern 5: `offset === size` is a valid empty success:

```ts
writeFileSync(join(projectRoot, "three.txt"), "abc");
await expect(runtime.callTool("filesystem", "read_file",
  { path: "three.txt", offset: 3 }))
  .resolves.toMatchObject({
    content: "",
    offset: 3,
    length: 0,
    size_bytes: 3,
    truncated: false,
  });
```

### Case 10 — `NOT_A_FILE` on a directory

```ts
mkdirSync(join(projectRoot, "sub"));
await expect(runtime.callTool("filesystem", "read_file", { path: "sub" }))
  .rejects.toThrow(/NOT_A_FILE/);
```

## 8. Update the config defaults test

Edit [src/config.test.ts](../../../../src/config.test.ts#L43-L66).
Add to the defaults block:

```ts
expect(config.mcp.maxFileReadBytes).toBe(200_000);
```

Add an override case modelled on the existing
`mcp: { ..., maxOutputBytes: 13 }` block at
[src/config.test.ts](../../../../src/config.test.ts#L56-L58):

```ts
writeFileSync(join(saivageRoot, "saivage.json"), JSON.stringify({
  mcp: { maxFileReadBytes: 4096 },
}, null, 2));
expect(loadConfig(true, projectRoot).mcp.maxFileReadBytes).toBe(4096);
```

## 9. Update other tests that construct `mcp` config inline

Add `maxFileReadBytes: 200_000` to every inline `mcp: {...}` literal
that currently sets `maxFetchChars: 200_000`:

- [src/knowledge/integration.test.ts](../../../../src/knowledge/integration.test.ts#L38-L44)
- [src/mcp/runtime.api.test.ts](../../../../src/mcp/runtime.api.test.ts#L8-L14)
- [src/mcp/toolContext.test.ts](../../../../src/mcp/toolContext.test.ts#L37-L43)
- [src/mcp/runtime.test.ts](../../../../src/mcp/runtime.test.ts#L27-L33),
  [src/mcp/runtime.test.ts](../../../../src/mcp/runtime.test.ts#L73-L79)

Confirm by grep after editing:

```bash
grep -rn "maxFileReadBytes" src/ | wc -l
# Expect ≥ 8: 1 in config.ts, 1 in config.test.ts default, 1 in
# config.test.ts override, 5 inline test literals, plus the
# builtins.test.ts beforeEach override.
```

The exact total is allowed to grow with future test fixtures; the
gate is "every existing `maxFetchChars: 200_000` literal now also
carries `maxFileReadBytes: 200_000`".

## 10. Documentation crumbs

1. [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md):
   add a `maxFileReadBytes` row in the `mcp.*` table, styled like the
   existing `maxFetchChars` row.
2. [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md): update the
   `read_file` row's limits column to point at `mcp.maxFileReadBytes`,
   mention `offset`/`length`, and list the structured error codes
   from [02-design-r2.md §3.5](02-design-r2.md).

## 11. Build, lint, test, daemon validation

```bash
npm run build
npm test -- src/mcp/builtins.test.ts
npm test -- src/config.test.ts
npm test
```

All four must pass. `src/mcp/no-sync-fs.test.ts` from G30 must remain
green (no `*Sync` symbols re-introduced).

After landing, redeploy and smoke-test the three bind-mount daemons
per [../G30/APPROVED.md](../G30/APPROVED.md#L13):

```bash
ssh root@10.0.3.111 'systemctl restart saivage.service && sleep 4 \
  && systemctl is-active saivage.service \
  && curl -fsS http://127.0.0.1:8080/health'
ssh root@10.0.3.112 'systemctl restart saivage.service && sleep 4 \
  && systemctl is-active saivage.service \
  && curl -fsS http://127.0.0.1:8080/health'
ssh root@10.0.3.113 'systemctl restart saivage.service && sleep 4 \
  && systemctl is-active saivage.service \
  && curl -fsS http://127.0.0.1:8080/health'
```

Drive one agent turn that calls `read_file` on a known >200 KiB
artefact (e.g. an entry under `getrich/results/*.json`) and confirm
the response is the `FILE_TOO_LARGE` envelope (visible via the
`/api/conversation` debug surface or directly in the dispatcher log)
rather than a multi-MiB slurp. `saivage-v3-getrich-v2` (10.0.3.170)
is unaffected and needs no restart.

## 12. Test gates summary

- All ten G31-specific tests in step 7 pass.
- The pre-existing `read_file` happy-path test (step 6) passes
  against the new envelope.
- `src/mcp/no-sync-fs.test.ts` (G30) still passes.
- `src/config.test.ts` asserts default + override of
  `maxFileReadBytes`.
- All inline `mcp: {...}` test literals carry `maxFileReadBytes`.
- `npm test` is fully green.

## 13. Roll-back

A single-commit revert is sufficient: the new
`mcp.maxFileReadBytes` field drops out of the schema, on-disk
configs are unaffected (the field was optional with a default), the
schema and handler revert to the pre-G31 shape, and the test fixtures
shed the new entries. No agent-conversation implications: the added
success-envelope fields are additive and not referenced anywhere in
`src/` outside the test fixtures.
