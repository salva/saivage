# G31 — Design r4

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Analysis**: [01-analysis-r4.md](01-analysis-r4.md)

**Round 3 baseline**: [02-design-r3.md](02-design-r3.md); reviewer
critique [04-review-r3.md](04-review-r3.md).

Round 4 keeps Proposal A as recommended. The design deltas vs r3
are all driven by
[04-review-r3.md §Blocking Findings](04-review-r3.md#L11-L23):

1. Export `classifyFsError` and widen its `context` parameter.
2. Guard `await handle.close()` in `finally` so its rejection is
   classified, not raw.
3. Add a `close` context plus an ordering rule (primary failures
   win) so the exhaustive contract stays true.

Every section not listed below is unchanged from r3 and is not
re-stated here.

## 1. Recommendation (unchanged)

**Proposal A** from
[02-design-r3.md §1](02-design-r3.md#L18-L21).

## 2. Exhaustive structured-error contract (unchanged from r3)

[02-design-r3.md §2](02-design-r3.md#L23-L41). The code list and
their origins are identical. The `IO_ERROR`, `PERMISSION_DENIED`,
and `NOT_FOUND` origins now additionally include `close` (the
classifier site is the same; only the `context` label differs).

## 3. Filesystem-error classifier — exported, with `"close"` context

The classifier from
[02-design-r3.md §3](02-design-r3.md#L43-L82) is unchanged in
substance. Two edits relative to r3:

1. The function becomes a module export (named export
   `classifyFsError` alongside the existing exports in
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L36-L37)).
   The type alias `FsErrorCode` and the interface
   `ClassifiedFsError` are exported alongside it.
2. The `context` parameter widens from
   `"stat" | "open" | "read"` to
   `"stat" | "open" | "read" | "close"`.

Final shape:

```ts
export type FsErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "NOT_A_FILE" | "IO_ERROR";

export interface ClassifiedFsError {
  code: FsErrorCode;
  error: string;
  errno?: string;
}

export function classifyFsError(
  err: unknown,
  path: string,
  context: "stat" | "open" | "read" | "close",
): ClassifiedFsError {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  const msg = (err as Error | undefined)?.message ?? String(err);
  switch (errno) {
    case "ENOENT":
    case "ENOTDIR":
      return {
        code: "NOT_FOUND",
        error:
          `NOT_FOUND: ${path} does not exist (during ${context}). ` +
          `Check the spelling or use list_dir on the parent directory.`,
        errno,
      };
    case "EACCES":
    case "EPERM":
      return {
        code: "PERMISSION_DENIED",
        error:
          `PERMISSION_DENIED: filesystem denied access to ${path} ` +
          `(during ${context}). Verify permissions on the path and its parents.`,
        errno,
      };
    case "EISDIR":
      return {
        code: "NOT_A_FILE",
        error:
          `NOT_A_FILE: ${path} is a directory (open returned EISDIR). ` +
          `Use list_dir.`,
        errno,
      };
    default:
      return {
        code: "IO_ERROR",
        error:
          `IO_ERROR: low-level I/O error on ${path} (during ${context}): ${msg}`,
        ...(errno ? { errno } : {}),
      };
  }
}
```

Exporting the helper does not widen the public surface
meaningfully — the function is pure, has no hidden state, and is
already documented as part of the `read_file` contract. The export
exists for the analysis and design reason in
[01-analysis-r4.md §2.1](01-analysis-r4.md#L42-L80): it is the
testability boundary that makes the `IO_ERROR` and `EISDIR`
classifier arms deterministically reachable in this ESM repo. No
other module imports it; the export is testing-only by intent and
that is fine — the function is a legitimate utility and the
project rules permit minimum-surface helpers.

## 4. Handler revisions — `finally` guards `handle.close()`

§4.1 (`stat`) and §4.2 (`open`) from
[02-design-r3.md §4.1](02-design-r3.md#L86-L113) and
[02-design-r3.md §4.2](02-design-r3.md#L115-L128) are unchanged.

The `try { ... } finally { await handle.close(); }` block from
[02-design-r3.md §4.3](02-design-r3.md#L130-L182) gains a focused
`try/catch` around `handle.close()`. The complete replacement is:

```ts
let probeBytes = 0;
let windowBytes = 0;
let probeBuffer = Buffer.alloc(0);
let windowBuffer = Buffer.alloc(0);
let isBinary = false;
let readFailure: ClassifiedFsError | null = null;
try {
  // (1) NUL probe — unchanged from r3.
  const probeSize = Math.min(4096, totalSize);
  if (probeSize > 0) {
    probeBuffer = Buffer.alloc(probeSize);
    const probeRead = await handle.read(probeBuffer, 0, probeSize, 0);
    probeBytes = probeRead.bytesRead;
    if (probeBuffer.subarray(0, probeBytes).includes(0)) {
      isBinary = true;
    }
  }

  // (2) Window read — unchanged from r3.
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
  try {
    await handle.close();
  } catch (closeErr) {
    // A close() rejection surfaces only when no primary failure
    // (read rejection or binary detection) has been recorded;
    // the primary observation always wins because it is the
    // earlier, root-cause signal. See 01-analysis-r4.md §2.3.
    if (!readFailure && !isBinary) {
      readFailure = classifyFsError(closeErr, args.path as string, "close");
    }
  }
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
```

The `finally` is now total: either `handle.close()` resolves and
nothing happens, or it rejects and the rejection is classified
into `readFailure` without overriding a prior primary failure.
The post-`finally` branches are unchanged from
[02-design-r3.md §4.3](02-design-r3.md#L156-L181); `isBinary`
still short-circuits ahead of `readFailure`, and the success
envelope is unchanged.

### 4.1 Net handler error map (delta from r3)

[02-design-r3.md §4.4](02-design-r3.md#L184-L206) lists nine
top-level error branches. r4 adds a tenth, embedded inside
branch 9's source region:

10. `handle.close()` rejection (caught inside the `finally`'s
    own `try/catch`) → classifier with `context: "close"`.
    Subject to the "primary failure wins" ordering rule; written
    into the existing `readFailure` slot and surfaced through
    the same envelope.

The complete sequence is identical to r3 in source order; the
new branch shares the `readFailure` return site at
`if (readFailure) { return { ...} }`.

## 5. Error envelope shape (unchanged from r3)

[02-design-r3.md §5](02-design-r3.md#L208-L228). The optional
`errno` field is now also set on close-failure envelopes.

## 6. Public-API impact (delta from r3)

- **Tool result (failure):** unchanged outer shape; the same nine
  codes from
  [02-design-r3.md §2](02-design-r3.md#L23-L41); a new operator-
  facing diagnostic context value `"close"` may appear inside
  the `error` string when a `close()` rejection wins (when the
  body succeeded and the file is not binary).
- **Tool schema:** unchanged.
- **Module exports:** [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)
  gains three named exports — `classifyFsError`, the type alias
  `FsErrorCode`, and the interface `ClassifiedFsError`. Nothing
  else changes.
- **Documentation:** crumb from
  [02-design-r3.md §6](02-design-r3.md#L230-L242) stands.

## 7. Sequencing constraints (unchanged from r3)

[02-design-r3.md §7](02-design-r3.md#L244-L250). G30 must land
first.

## 8. Risks (delta from r3)

[02-design-r3.md §8](02-design-r3.md#L252-L274) risks carry
forward, with these revisions:

- Risk 2 (`IO_ERROR` test stubs `fs/promises.open`) is dropped.
  Replaced by: classifier unit tests against synthetic errno
  objects. No module mocking required.
- New risk: **An over-eager future reader might import
  `classifyFsError` from another module.** The function is
  fine to reuse, but reusing it widens the de-facto contract
  beyond `read_file`. Mitigation: a one-line comment above the
  export notes that it is `read_file`-specific and that other
  filesystem tools should add their own classifier if they need
  one. Low cost; keeps the export honest.
- New risk: **A `close()` rejection that was actually caused by
  a still-in-flight read could be classified as `"close"`
  instead of `"read"`.** In practice the body's `catch` runs
  before `finally`, so the body's rejection lands in
  `readFailure` first and the `close()` classifier is skipped.
  The "primary wins" ordering preserves the correct attribution.

## 9. Open questions (resolved)

[02-design-r3.md §9](02-design-r3.md#L276-L289) resolutions
stand. r4 additionally resolves:

- **Export the classifier?** Yes — only to support its
  unit tests. Documented intent: testing-only consumer; the
  classifier is otherwise `read_file`-specific.
- **Order between `close()` failure and primary observation?**
  Primary wins (`readFailure` or `isBinary` set inside the body
  blocks the close-failure write). Rationale in
  [01-analysis-r4.md §2.3](01-analysis-r4.md#L106-L132).
- **Widen the `context` union to `"close"`?** Yes; one new
  string literal, no new branches.

## 10. Mapping of r3 reviewer concerns to fixes

| [04-review-r3.md](04-review-r3.md) requirement | r4 location |
|------------------------------------------------|-------------|
| Replace the failing `vi.spyOn(fsPromises, "open")` strategy | §3 (export), [03-plan-r4.md §7.3](03-plan-r4.md#L120) |
| Add a real test for `EISDIR -> NOT_A_FILE` | §3, [03-plan-r4.md §7.2](03-plan-r4.md#L96) |
| Classify `handle.close()` failures or narrow the contract | §4 (in-`finally` `try/catch`), [03-plan-r4.md §5](03-plan-r4.md#L60) |
| Architecture-first; avoid over-engineering | §3 keeps the classifier ~16 lines; the only new code is the in-`finally` `try/catch` and the export |
