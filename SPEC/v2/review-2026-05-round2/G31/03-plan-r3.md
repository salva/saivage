# G31 — Implementation Plan r3

**Chosen design**: Proposal A from
[02-design-r3.md](02-design-r3.md), which inherits everything from
[02-design-r2.md](02-design-r2.md) and adds the filesystem-error
classifier.

**Round 2 baseline**: [03-plan-r2.md](03-plan-r2.md); reviewer
critique [04-review-r2.md](04-review-r2.md).

r3 is a delta plan. Steps that are identical to
[03-plan-r2.md](03-plan-r2.md) are referenced, not duplicated.
Steps that change are spelled out in full.

## 0. Pre-flight (unchanged)

Same as [03-plan-r2.md §0](03-plan-r2.md#L10-L40). Confirm G30 has
landed, re-anchor the live line numbers in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts), confirm
`git status` is clean on the touched files, baseline
`npm run build`.

## 1. Add the config field (unchanged)

[03-plan-r2.md §1](03-plan-r2.md#L42-L53). Add
`maxFileReadBytes: z.number().default(200_000)` to the `mcp` block
in [src/config.ts](../../../../src/config.ts#L137-L147).

## 2. Module-level let + register-time wiring (unchanged)

[03-plan-r2.md §2](03-plan-r2.md#L55-L70).

## 3. Add helpers

Two helpers, both inserted immediately above the existing
`parseOptionalTimeoutMs` function at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L375)
(re-anchor per §0).

### 3.1 `parseNonNegativeInt` (unchanged from r2)

Body as spelled out in
[03-plan-r2.md §3](03-plan-r2.md#L72-L91).

### 3.2 `classifyFsError` (new in r3)

Body as spelled out in
[02-design-r3.md §3](02-design-r3.md#L40-L82). Inserted between
`parseNonNegativeInt` and `parseOptionalTimeoutMs`.

The type `FsErrorCode` and the interface `ClassifiedFsError` go
right above the function; both are module-internal.

## 4. Replace the `read_file` schema (unchanged)

[03-plan-r2.md §4 schema block](03-plan-r2.md#L93-L97). Schema is
unchanged in r3.

## 5. Replace the `read_file` handler

Identical to [03-plan-r2.md §4 handler body](03-plan-r2.md#L99-L141)
**plus** the three call-site wrappers from
[02-design-r3.md §4](02-design-r3.md#L84-L182). For the implementer,
the assembly order inside the new `case "read_file":` block is:

1. Argument parse `try/catch` → `INVALID_ARGUMENT`.
2. `length > MAX_FILE_READ_BYTES` → `LENGTH_TOO_LARGE`.
3. `stat` wrapped in `try/catch` → classifier on rejection
   ([02-design-r3.md §4.1](02-design-r3.md#L86-L113)).
4. `!st.isFile()` → `NOT_A_FILE` (unchanged from r2).
5. `effectiveOffset > totalSize` → `INVALID_RANGE`.
6. Whole-file read above cap → `FILE_TOO_LARGE`.
7. `open` wrapped in `try/catch` → classifier on rejection
   ([02-design-r3.md §4.2](02-design-r3.md#L115-L128)).
8. NUL probe + window read inside
   `try { ... } catch (err) { readFailure = classifyFsError(...,
   "read"); } finally { await handle.close(); }` block. After the
   `finally`, return the binary-content envelope if the probe
   detected NUL, then the `readFailure` envelope if the catch
   captured a rejection, then the success envelope.

A faithful, complete handler reference assembly:

```ts
case "read_file": {
  const fp = resolvePath(args.path as string);

  let offset: number | undefined;
  let length: number | undefined;
  try {
    offset = parseNonNegativeInt(args.offset, "offset");
    length = parseNonNegativeInt(args.length, "length");
  } catch (err) {
    return {
      content: {
        error: `INVALID_ARGUMENT: ${(err as Error).message}`,
        code: "INVALID_ARGUMENT",
        path: args.path,
      },
      isError: true,
    };
  }

  if (length !== undefined && length > MAX_FILE_READ_BYTES) {
    return {
      content: {
        error:
          `LENGTH_TOO_LARGE: length=${length} exceeds ` +
          `mcp.maxFileReadBytes=${MAX_FILE_READ_BYTES}. ` +
          `Issue multiple windowed reads or use run_command head/tail.`,
        code: "LENGTH_TOO_LARGE",
        path: args.path,
        length,
        max_bytes: MAX_FILE_READ_BYTES,
      },
      isError: true,
    };
  }

  let st;
  try {
    st = await stat(fp);
  } catch (err) {
    const classified = classifyFsError(err, args.path as string, "stat");
    return { content: { ...classified, path: args.path }, isError: true };
  }
  if (!st.isFile()) {
    return {
      content: {
        error: `NOT_A_FILE: ${args.path} is not a regular file`,
        code: "NOT_A_FILE",
        path: args.path,
      },
      isError: true,
    };
  }

  const totalSize = st.size;
  const effectiveOffset = offset ?? 0;

  if (effectiveOffset > totalSize) {
    return {
      content: {
        error:
          `INVALID_RANGE: offset=${effectiveOffset} exceeds ` +
          `file size=${totalSize}`,
        code: "INVALID_RANGE",
        path: args.path,
        offset: effectiveOffset,
        size_bytes: totalSize,
      },
      isError: true,
    };
  }

  if (
    offset === undefined &&
    length === undefined &&
    totalSize > MAX_FILE_READ_BYTES
  ) {
    return {
      content: {
        error:
          `FILE_TOO_LARGE: size=${totalSize} bytes exceeds ` +
          `mcp.maxFileReadBytes=${MAX_FILE_READ_BYTES}. ` +
          `Re-issue with explicit offset/length (each ≤ ${MAX_FILE_READ_BYTES}), ` +
          `or use run_command with head/tail/grep, or use search_files.`,
        code: "FILE_TOO_LARGE",
        path: args.path,
        size_bytes: totalSize,
        max_bytes: MAX_FILE_READ_BYTES,
      },
      isError: true,
    };
  }

  let handle;
  try {
    handle = await open(fp, "r");
  } catch (err) {
    const classified = classifyFsError(err, args.path as string, "open");
    return { content: { ...classified, path: args.path }, isError: true };
  }

  let probeBytes = 0;
  let windowBytes = 0;
  let probeBuffer = Buffer.alloc(0);
  let windowBuffer = Buffer.alloc(0);
  let isBinary = false;
  let readFailure: ClassifiedFsError | null = null;
  try {
    const probeSize = Math.min(4096, totalSize);
    if (probeSize > 0) {
      probeBuffer = Buffer.alloc(probeSize);
      const probeRead = await handle.read(probeBuffer, 0, probeSize, 0);
      probeBytes = probeRead.bytesRead;
      if (probeBuffer.subarray(0, probeBytes).includes(0)) {
        isBinary = true;
      }
    }

    if (!isBinary) {
      const effectiveLength = length ?? MAX_FILE_READ_BYTES;
      const remaining = totalSize - effectiveOffset;
      const toRead = Math.min(effectiveLength, remaining);
      if (toRead > 0) {
        if (effectiveOffset === 0 && toRead <= probeBytes) {
          windowBuffer = probeBuffer.subarray(0, toRead) as Buffer;
          windowBytes = toRead;
        } else {
          windowBuffer = Buffer.alloc(toRead);
          const winRead = await handle.read(windowBuffer, 0, toRead, effectiveOffset);
          windowBytes = winRead.bytesRead;
        }
      }
    }
  } catch (err) {
    readFailure = classifyFsError(err, args.path as string, "read");
  } finally {
    await handle.close();
  }

  if (isBinary) {
    return {
      content: {
        error:
          `BINARY_CONTENT: ${args.path} contains a NUL byte in its ` +
          `first ${probeBytes} bytes. Use run_command with file/xxd, ` +
          `or download_file if you need the raw bytes.`,
        code: "BINARY_CONTENT",
        path: args.path,
        size_bytes: totalSize,
      },
      isError: true,
    };
  }

  if (readFailure) {
    return { content: { ...readFailure, path: args.path }, isError: true };
  }

  const content = windowBuffer.subarray(0, windowBytes).toString("utf-8");
  const truncated = effectiveOffset + windowBytes < totalSize;
  return {
    content: {
      content,
      offset: effectiveOffset,
      length: windowBytes,
      size_bytes: totalSize,
      truncated,
    },
    isError: false,
  };
}
```

After editing, audit `node:fs/promises` imports per
[03-plan-r2.md §4 closing paragraph](03-plan-r2.md#L143-L153).
Confirm `stat`, `open` (and any G30-provided `readFile` if still
used elsewhere) remain imported. The classifier needs no new
imports beyond the existing `Buffer` global; the `FsErrorCode` /
`ClassifiedFsError` types are local.

## 6. Terminal verification (delta from r2)

Same as [03-plan-r2.md §5](03-plan-r2.md#L155-L184), plus the three
new codes:

```bash
for code in FILE_TOO_LARGE LENGTH_TOO_LARGE INVALID_RANGE \
            BINARY_CONTENT NOT_A_FILE INVALID_ARGUMENT \
            NOT_FOUND PERMISSION_DENIED IO_ERROR; do
  echo "$code: $(grep -c "code: \"$code\"" src/mcp/builtins.ts)"
done
```

Every code must print at least 1. `NOT_A_FILE` may print 2 (the
`!st.isFile()` branch and the `EISDIR` fold-in inside the
classifier). `IO_ERROR`, `NOT_FOUND`, `PERMISSION_DENIED` each
print 1 (only the classifier emits them).

Additional check:

```bash
grep -n "function classifyFsError" src/mcp/builtins.ts            # 1 line
grep -nE "classifyFsError\(.*,.*,.*\"(stat|open|read)\"\)" src/mcp/builtins.ts
                                                                   # 3 lines
```

The first grep confirms the classifier exists; the second confirms
it is invoked at all three failure sites.

G30 invariant remains:

```bash
grep -nE "(readFileSync|readSync|openSync|closeSync|statSync)" src/mcp/builtins.ts
# → empty
```

## 7. Add G31-specific regression tests

Begin from [03-plan-r2.md §7](03-plan-r2.md#L210-L340) cases 1–10
(unchanged). Append the three r3 cases below to the same
`describe("read_file size cap (G31)", ...)` block. Required imports
in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts):
add `chmodSync, unlinkSync` to the existing `node:fs` import, and
`vi` from `vitest` (it is not currently imported).

### 7.1 Case 11 — `NOT_FOUND` on a missing path

```ts
await expect(runtime.callTool("filesystem", "read_file",
  { path: "does-not-exist.txt" }))
  .rejects.toThrow(/NOT_FOUND/);
```

The structured `errno: "ENOENT"` field is captured in the runtime's
thrown-message JSON; matching on `NOT_FOUND` alone is sufficient.

### 7.2 Case 12 — `PERMISSION_DENIED` on a mode-`0o000` file

```ts
const denied = join(projectRoot, "no-read.txt");
writeFileSync(denied, "secret", "utf-8");
chmodSync(denied, 0o000);
try {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    // running as root bypasses POSIX permission bits — skip the
    // assertion and document the gap, as design r3 §8 risk 1 notes.
    return;
  }
  await expect(runtime.callTool("filesystem", "read_file",
    { path: "no-read.txt" }))
    .rejects.toThrow(/PERMISSION_DENIED/);
} finally {
  chmodSync(denied, 0o600);
}
```

The `try/finally` restores the mode so the `afterEach`
`rmSync(projectRoot, { recursive: true, force: true })` succeeds.

### 7.3 Case 13 — `IO_ERROR` via stubbed `open`

```ts
const fsPromises = await import("node:fs/promises");
const err = Object.assign(new Error("simulated I/O error"), { code: "EIO" });
const spy = vi.spyOn(fsPromises, "open").mockRejectedValueOnce(err);
try {
  writeFileSync(join(projectRoot, "io.txt"), "x", "utf-8");
  await expect(runtime.callTool("filesystem", "read_file",
    { path: "io.txt" }))
    .rejects.toThrow(/IO_ERROR/);
} finally {
  spy.mockRestore();
}
```

The stub fires on the next `open` invocation only. The classifier
returns `IO_ERROR` because `EIO` is not in the named list, and the
runtime serialises the `code` into the thrown message.

### 7.4 (Optional) Case 14 — `NOT_A_FILE` via `EISDIR` fold-in

The r2 plan already covers `NOT_A_FILE` for directories via the
`!st.isFile()` branch (case 10). The `EISDIR`-from-`open` branch
is hard to hit on POSIX because `stat` already classifies
directories. We do **not** add a separate test; the design
guarantees the fold-in by inspection and the classifier function
is exercised by the EIO stub in case 13.

## 8. Update the existing happy-path test (unchanged from r2)

[03-plan-r2.md §6](03-plan-r2.md#L186-L208). The pre-existing
"allows filesystem access inside the project root" assertion at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L69-L72)
switches to `toMatchObject` on the new success envelope.

## 9. Update config defaults test (unchanged from r2)

[03-plan-r2.md §8](03-plan-r2.md#L342-L360).

## 10. Update other inline `mcp` test literals (unchanged from r2)

[03-plan-r2.md §9](03-plan-r2.md#L362-L382).

## 11. Documentation crumbs (delta from r2)

The r2 docs crumbs in
[03-plan-r2.md §10](03-plan-r2.md#L384-L394) stand. r3 additions:

1. [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md): the
   `read_file` row's structured-error list grows by three: append
   `NOT_FOUND`, `PERMISSION_DENIED`, `IO_ERROR` to the codes
   enumerated in the r2 crumb.
2. [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md):
   no further additions (the config field crumb stays as r2 wrote
   it; the error codes do not appear in the runtime-config guide).

## 12. Build, lint, test, daemon validation (unchanged from r2)

[03-plan-r2.md §11](03-plan-r2.md#L396-L432). All gates pass.
Smoke-test the three bind-mount daemons (`saivage` 10.0.3.111,
`saivage-v3` 10.0.3.112, `diedrico` 10.0.3.113) via
`systemctl restart saivage.service && curl /health`. Drive one
agent turn each that exercises `read_file` on:

- An over-cap artefact (expect `FILE_TOO_LARGE`).
- A missing path (expect `NOT_FOUND`).

Both error envelopes must reach the agent inside the runtime's
thrown message, visible in the
[src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L194-L196)
log envelope.

## 13. Test gates summary (delta from r2)

All gates from [03-plan-r2.md §12](03-plan-r2.md#L434-L446) carry
forward. Additions:

- Case 11 (`NOT_FOUND`) passes.
- Case 12 (`PERMISSION_DENIED`) passes when not running as root;
  skips with a recorded log line otherwise.
- Case 13 (`IO_ERROR`) passes via the stubbed `open` rejection.
- Verification grep block in §6 prints non-zero counts for all
  nine documented codes.

## 14. Roll-back (unchanged from r2)

[03-plan-r2.md §13](03-plan-r2.md#L448-L457). Single-commit revert
still suffices. The classifier helper, the three new codes, and the
three new tests all drop together with the rest of G31.
