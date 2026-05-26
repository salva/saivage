# G31 — Implementation Plan r1

**Chosen design**: Proposal A from
[02-design-r1.md §1-§3](02-design-r1.md#L11-L210).

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

## 0. Pre-flight

1. **Confirm G30 has landed.** Check that
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26)
   no longer imports `readFileSync`, `readSync`, `openSync`,
   `closeSync`, `statSync` and that `src/mcp/no-sync-fs.test.ts`
   exists per [../G30/APPROVED.md](../G30/APPROVED.md). If G30 has
   not landed, stop and ask the metaplan owner to resequence; G31
   cannot be safely landed first because step 3 below assumes the
   async handler shape.
2. `git status` clean on `src/mcp/builtins.ts`, `src/mcp/builtins.test.ts`,
   `src/config.ts`, `src/config.test.ts`.
3. `npm run build` green (baseline).

## 1. Add the new config field

Edit [src/config.ts](../../../../src/config.ts#L137-L147), append to
the `mcp` object schema (order: keep grouped with the other size caps):

```ts
mcp: z
  .object({
    shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000),
    shellTimeoutFloorMs: z.number().default(10 * 60 * 1000),
    inProcessTimeoutMs: z.number().default(300_000),
    maxOutputBytes: z.number().default(100 * 1024),
    maxFetchChars: z.number().default(200_000),
    maxDownloadBytes: z.number().default(250 * 1024 * 1024),
    maxFileReadBytes: z.number().default(200_000),  // ← G31
  })
  .default({})
  .superRefine(...)
```

No new `superRefine` rule — `maxFileReadBytes` is independent of the
shell-timeout invariants.

## 2. Add the module-level let and wire it from registerBuiltinServices

Edit [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L43),
insert next to the existing caps:

```ts
let MAX_OUTPUT = 100 * 1024;
// ...
let MAX_FETCH_CHARS = 200_000;
let MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
let MAX_FILE_READ_BYTES = 200_000;   // ← G31
let SHELL_TIMEOUT_FLOOR_MS = 10 * 60 * 1000;
```

Edit [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1080),
add inside `registerBuiltinServices`:

```ts
MAX_OUTPUT = mcpConfig.maxOutputBytes;
MAX_FETCH_CHARS = mcpConfig.maxFetchChars;
MAX_DOWNLOAD_BYTES = mcpConfig.maxDownloadBytes;
MAX_FILE_READ_BYTES = mcpConfig.maxFileReadBytes;   // ← G31
SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;
```

## 3. Add `parseNonNegativeInt` helper

Insert immediately above the `parseOptionalTimeoutMs` definition at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L385):

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

## 4. Replace the `read_file` tool schema

Edit [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L243-L246).
Replace the existing single-property schema entry with the multi-property
form spelled out in [02-design-r1.md §3.3](02-design-r1.md#L94-L122).

## 5. Replace the `read_file` handler body

Edit [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278)
(post-G30 this is `await readFile(fp, "utf-8")`). Replace with the body
spelled out in [02-design-r1.md §3.4](02-design-r1.md#L126-L210). The
required `node:fs/promises` symbols (`readFile`, `stat`, `open`) are
already imported by G30; no new top-level imports.

Verify with the terminal (not the in-editor buffer; see workspace memory
on Vue/TS edit-buffer drift) immediately after the edit:

```bash
grep -c "FILE_TOO_LARGE" src/mcp/builtins.ts        # → 1
grep -c "BINARY_CONTENT" src/mcp/builtins.ts        # → 1
grep -c "MAX_FILE_READ_BYTES" src/mcp/builtins.ts   # → 3 (declare + assign + use)
grep -n "readFileSync" src/mcp/builtins.ts          # → empty (G30 invariant preserved)
```

## 6. Update the existing read_file test

Edit
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L69-L77).
The existing block:

```ts
it("allows filesystem access inside the project root", async () => {
  writeFileSync(join(projectRoot, "README.md"), "hello", "utf-8");
  await expect(runtime.callTool("filesystem", "read_file", { path: "README.md" }))
    .resolves.toEqual({ content: "hello" });
});
```

becomes:

```ts
it("allows filesystem access inside the project root", async () => {
  writeFileSync(join(projectRoot, "README.md"), "hello", "utf-8");
  await expect(runtime.callTool("filesystem", "read_file", { path: "README.md" }))
    .resolves.toMatchObject({
      content: "hello",
      offset: 0,
      length: 5,
      size_bytes: 5,
      truncated: false,
    });
});
```

The "rejects filesystem access outside the project root" case at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L75-L77)
is unchanged (the `resolvePath` guard runs before the new logic).

## 7. Add G31-specific regression tests

Append a new `describe("read_file size cap (G31)", ...)` block to
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts) using
the existing `beforeEach` fixture. Tests:

1. **fails fast on file larger than cap (no window)**

   ```ts
   writeFileSync(join(projectRoot, "big.log"), "x".repeat(MAX + 1));
   const r = await runtime.callTool("filesystem", "read_file", { path: "big.log" });
   expect(r).toMatchObject({ error: expect.stringContaining("FILE_TOO_LARGE"),
                             code: "FILE_TOO_LARGE",
                             size_bytes: MAX + 1,
                             max_bytes: MAX });
   ```

   `MAX` is read from `cfg.mcp.maxFileReadBytes` so the test follows the
   config — do **not** hard-code 200_000. Lower `maxFileReadBytes` in
   the `beforeEach` config to e.g. 1024 for these tests by extending
   the `mcp: { shellTimeoutFloorMs: 0 }` block at
   [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L50)
   to also set `maxFileReadBytes: 1024`.

2. **returns the requested window when offset+length supplied**

   ```ts
   writeFileSync(join(projectRoot, "big.log"), "abcdefghijklmnop");
   const r = await runtime.callTool("filesystem", "read_file",
     { path: "big.log", offset: 4, length: 4 });
   expect(r).toMatchObject({ content: "efgh", offset: 4, length: 4,
                             size_bytes: 16, truncated: true });
   ```

3. **rejects length larger than cap**

   ```ts
   const r = await runtime.callTool("filesystem", "read_file",
     { path: "any.log", length: MAX + 1 });
   expect(r).toMatchObject({ code: "LENGTH_TOO_LARGE" });
   ```

4. **rejects offset past EOF**

   ```ts
   writeFileSync(join(projectRoot, "small.txt"), "abc");
   const r = await runtime.callTool("filesystem", "read_file",
     { path: "small.txt", offset: 99 });
   expect(r).toMatchObject({ code: "INVALID_RANGE" });
   ```

5. **rejects NUL-byte payload**

   ```ts
   writeFileSync(join(projectRoot, "bin.dat"), Buffer.from([1, 2, 0, 4]));
   const r = await runtime.callTool("filesystem", "read_file", { path: "bin.dat" });
   expect(r).toMatchObject({ code: "BINARY_CONTENT" });
   ```

6. **truncated flag false when whole content fits**

   ```ts
   writeFileSync(join(projectRoot, "tiny.txt"), "hi");
   const r = await runtime.callTool("filesystem", "read_file", { path: "tiny.txt" });
   expect(r).toMatchObject({ content: "hi", truncated: false });
   ```

7. **invalid offset (string, negative, NaN) raises validation error**

   ```ts
   await expect(runtime.callTool("filesystem", "read_file",
     { path: "tiny.txt", offset: -1 }))
     .rejects.toThrow("offset must be a non-negative integer");
   ```

## 8. Update the config defaults test

Edit [src/config.test.ts](../../../../src/config.test.ts#L43-L66).
Add to the defaults assertions:

```ts
expect(config.mcp.maxFileReadBytes).toBe(200_000);
```

Add an override case modelled on the existing `maxOutputBytes: 13`
override at [src/config.test.ts](../../../../src/config.test.ts#L56)
to confirm the field round-trips.

## 9. Update other tests that construct `mcp` config inline

The following files construct synthetic `mcp` configs and will need a
default added so type inference does not break:

- [src/knowledge/integration.test.ts](../../../../src/knowledge/integration.test.ts#L38-L44)
- [src/mcp/runtime.api.test.ts](../../../../src/mcp/runtime.api.test.ts#L8-L14)
- [src/mcp/toolContext.test.ts](../../../../src/mcp/toolContext.test.ts#L37-L43)
- [src/mcp/runtime.test.ts](../../../../src/mcp/runtime.test.ts#L27-L33),
  [src/mcp/runtime.test.ts](../../../../src/mcp/runtime.test.ts#L73-L79)

Add `maxFileReadBytes: 200_000` to each inline `mcp: {...}` literal,
mirroring the existing `maxFetchChars` entries.

Confirm by terminal grep after the edits:

```bash
grep -rn "maxFileReadBytes" src/ | wc -l   # expect ≥ 7
```

## 10. Documentation crumbs

1. [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md):
   add a `maxFileReadBytes` row in the `mcp.*` table, copy-styled from
   the existing `maxFetchChars` row.
2. [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md): update the
   `read_file` row's "limits" column to point at `mcp.maxFileReadBytes`
   and mention the new `offset`/`length` params.

## 11. Build, lint, test, daemon validation

```bash
npm run build
npm test -- src/mcp/builtins.test.ts
npm test -- src/config.test.ts
npm test
```

All four must pass. The G30 regression guard
`src/mcp/no-sync-fs.test.ts` ([../G30/APPROVED.md](../G30/APPROVED.md))
must remain green — it asserts that no sync-fs call has crept back into
`src/mcp/`.

After landing, redeploy and smoke-test the three bind-mount daemons
identified by G30:

- `saivage` (10.0.3.111)
- `diedrico` (10.0.3.113)
- `saivage-v3` (10.0.3.112)

Smoke procedure (one per daemon, run from the host):

```bash
ssh root@10.0.3.111 'systemctl restart saivage.service && sleep 4 \
  && systemctl is-active saivage.service \
  && curl -fsS http://127.0.0.1:8080/health'
```

Then drive one agent turn that calls `read_file` on a file known to
exceed 200 KiB (e.g. `getrich/results/*.json`) and confirm the
response is the `FILE_TOO_LARGE` envelope with `code` and
`max_bytes`, not a multi-megabyte slurp. `saivage-v3-getrich-v2`
(10.0.3.170) is unaffected and does not need a restart for G31 (it
ships a copy of `saivage-v3`).

## 12. Test gates summary

- All seven G31-specific tests in step 7 pass.
- The pre-existing `read_file` happy-path test still passes against
  the new envelope (step 6).
- `src/mcp/no-sync-fs.test.ts` from G30 still passes (no `*Sync`
  symbols reintroduced).
- `src/config.test.ts` asserts default + override of
  `maxFileReadBytes`.
- `npm test` is fully green; no other tests need editing beyond the
  inline `mcp: {...}` literals in step 9.

## 13. Roll-back

A single-commit revert is sufficient. The new `mcp.maxFileReadBytes`
field gets dropped from the schema; existing `saivage.json` files are
unaffected because the field was optional with a default. No on-disk
migration, no shutdown handoff implications, no agent-conversation
implications (the new fields in the success envelope are additive and
unused by any internal code path — agents adapt within one turn).
