# G31 — Design r3

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)

**Round 2 baseline**: [02-design-r2.md](02-design-r2.md); reviewer
critique [04-review-r2.md](04-review-r2.md).

Round 3 keeps Proposal A as recommended. The only design delta is
the addition of filesystem-error classification so that every error
path from `read_file` returns a structured envelope. Every section
not listed below is unchanged from r2 and is not re-stated here.

## 1. Recommendation (unchanged)

**Proposal A** from
[02-design-r2.md §1](02-design-r2.md#L7-L73). Proposal B remains
rejected for the same reasons recorded in
[02-design-r2.md §1](02-design-r2.md#L60-L73).

## 2. Exhaustive structured-error contract

`filesystem.read_file` returns one of these `code` values on the
`isError: true` envelope; every error path in the handler is wired
to exactly one of them:

| `code` | Origin | Recovery hint embedded in `error` |
|--------|--------|-----------------------------------|
| `INVALID_ARGUMENT` | argument-parse `try/catch` from r2 | "offset/length must be non-negative integer" |
| `FILE_TOO_LARGE` | whole-file read above cap (r2) | "re-issue with explicit offset/length or use run_command head/tail/grep, or use search_files" |
| `LENGTH_TOO_LARGE` | requested `length > MAX_FILE_READ_BYTES` (r2) | "issue multiple windowed reads or use run_command head/tail" |
| `INVALID_RANGE` | `offset > size` (r2) | "offset N exceeds file size M" |
| `BINARY_CONTENT` | file-head NUL probe (r2) | "use run_command file/xxd, or download_file" |
| `NOT_A_FILE` | `!st.isFile()` (r2) **or** `EISDIR` from `open` (r3) | "path is not a regular file; use list_dir" |
| `NOT_FOUND` | `ENOENT` / `ENOTDIR` from `stat` or `open` (r3) | "path does not exist; check spelling or use list_dir on the parent directory" |
| `PERMISSION_DENIED` | `EACCES` / `EPERM` from `stat`, `open`, or `handle.read` (r3) | "filesystem denied access; verify permissions on the path and its parents" |
| `IO_ERROR` | every other errno from `stat`, `open`, or `handle.read` (r3) | "low-level I/O error; the operator log records the underlying errno" |

The list is the full contract. No other code is emitted; no error
path escapes as a raw thrown error.

## 3. Filesystem-error classifier

Inserted next to the existing helpers in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) immediately
above `parseNonNegativeInt`
([02-design-r2.md §3.4 helper block](02-design-r2.md#L317-L329)):

```ts
type FsErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "NOT_A_FILE" | "IO_ERROR";

interface ClassifiedFsError {
  code: FsErrorCode;
  error: string;
  errno?: string;
}

function classifyFsError(
  err: unknown,
  path: string,
  context: "stat" | "open" | "read",
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

The function is total: any thrown value (including non-`Error`
rejections) falls through to `IO_ERROR`. The `errno` field is
operator-facing diagnostic context; agents continue to branch on
`code` only.

## 4. Handler revisions

The r2 handler sketch in
[02-design-r2.md §3.4](02-design-r2.md#L194-L310) wraps three
filesystem calls:

1. `await stat(fp)` (single call after argument validation).
2. `await open(fp, "r")` (single call after the whole-file-size
   gate).
3. Two `await handle.read(...)` calls inside the existing
   `try { ... } finally { await handle.close(); }` block.

r3 replaces those three sites with the snippets below; everything
else in the r2 handler is unchanged.

### 4.1 Wrap `stat`

```ts
let st: Awaited<ReturnType<typeof stat>>;
try {
  st = await stat(fp);
} catch (err) {
  const classified = classifyFsError(err, args.path as string, "stat");
  return {
    content: { ...classified, path: args.path },
    isError: true,
  };
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
```

Both branches return the same envelope shape: `{ error, code,
path, [errno?] }`. The `!st.isFile()` branch is unchanged from r2
and remains the canonical `NOT_A_FILE` site for directories.

### 4.2 Wrap `open`

```ts
let handle: Awaited<ReturnType<typeof open>>;
try {
  handle = await open(fp, "r");
} catch (err) {
  const classified = classifyFsError(err, args.path as string, "open");
  return {
    content: { ...classified, path: args.path },
    isError: true,
  };
}
```

`open` is the only site that can legitimately return `EISDIR` after
a successful `stat`; the classifier folds that into `NOT_A_FILE` so
the contract stays exhaustive.

### 4.3 Wrap `handle.read`

The two `handle.read` calls inside the existing
`try { ... } finally { await handle.close(); }` block now share a
single rejection handler. The shape is:

```ts
let probeBytes = 0;
let windowBytes = 0;
let probeBuffer = Buffer.alloc(0);
let windowBuffer = Buffer.alloc(0);
let readFailure: ClassifiedFsError | null = null;
try {
  // (1) NUL probe — unchanged from r2 except the read call now lives
  //     inside this try block.
  const probeSize = Math.min(4096, totalSize);
  if (probeSize > 0) {
    probeBuffer = Buffer.alloc(probeSize);
    const probeRead = await handle.read(probeBuffer, 0, probeSize, 0);
    probeBytes = probeRead.bytesRead;
    if (probeBuffer.subarray(0, probeBytes).includes(0)) {
      // BINARY_CONTENT — return below, after finally closes the handle.
      readFailure = {
        code: "IO_ERROR", // placeholder, overwritten before return
        error: "",
      };
      // signal via a dedicated boolean instead — see note below.
    }
  }

  // (2) Window read — unchanged from r2.
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
} catch (err) {
  readFailure = classifyFsError(err, args.path as string, "read");
} finally {
  await handle.close();
}

if (readFailure) {
  return {
    content: { ...readFailure, path: args.path },
    isError: true,
  };
}
```

Two clarifications, because the snippet above is condensed:

- **BINARY_CONTENT short-circuit:** to keep the existing r2 behaviour
  (return `BINARY_CONTENT` after the probe, without doing the
  window read) the implementation uses an explicit boolean
  `isBinary` set inside the `try` and tested after the `finally`,
  rather than reusing `readFailure`. The plan
  ([03-plan-r3.md §3](03-plan-r3.md#L40)) spells this out in full.
- **No double-classify:** the `catch` only runs when one of the
  `handle.read` awaits rejects. Pre-existing structured returns
  (the probe's binary detection) do not flow through `catch`; they
  flow through the post-`finally` branch and emit the same shape
  the r2 design specified.

### 4.4 Net handler error map

Every `return { isError: true, ... }` in the final handler now
falls under exactly one of these top-level branches, in source
order:

1. Argument parse `try/catch` → `INVALID_ARGUMENT` (r2).
2. `length > MAX_FILE_READ_BYTES` → `LENGTH_TOO_LARGE` (r2).
3. `stat` rejection → classifier (`NOT_FOUND` |
   `PERMISSION_DENIED` | `IO_ERROR`) (r3).
4. `!st.isFile()` → `NOT_A_FILE` (r2).
5. `offset > totalSize` → `INVALID_RANGE` (r2).
6. Whole-file read above cap → `FILE_TOO_LARGE` (r2).
7. `open` rejection → classifier (`NOT_FOUND` |
   `PERMISSION_DENIED` | `NOT_A_FILE` (EISDIR) | `IO_ERROR`) (r3).
8. NUL probe positive → `BINARY_CONTENT` (r2).
9. `handle.read` rejection → classifier (`NOT_FOUND` is impossible
   here in practice, but the classifier still defends against
   pathological reopens; the realistic codes are
   `PERMISSION_DENIED` and `IO_ERROR`) (r3).

The success envelope and its fields are unchanged from
[02-design-r2.md §3.4 success path](02-design-r2.md#L302-L310).

## 5. Error envelope shape — refined

The envelope shape from [02-design-r2.md §3.5](02-design-r2.md#L341-L361)
is updated to admit an optional `errno` field on filesystem-error
envelopes:

```ts
// Schema-error envelopes (unchanged from r2):
{ content: { error, code, path, ...context }, isError: true }

// Filesystem-error envelopes (r3 addition):
{ content: { error, code, path, errno? }, isError: true }
```

`errno` is the raw `err.code` from Node's `ErrnoException` (e.g.
`"ENOENT"`, `"EACCES"`), included only when the classifier produced
a known value. The runtime serialises the whole `content` into the
thrown message
([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193)), so
the operator log surface
([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L194-L196))
keeps the diagnostic context. Agents continue to branch on `code`.

## 6. Public-API impact (delta from r2)

- **Tool result (failure):** unchanged outer shape; new codes
  `NOT_FOUND`, `PERMISSION_DENIED`, `IO_ERROR`; new optional
  `errno` field on filesystem-error envelopes.
- **Tool schema:** unchanged from
  [02-design-r2.md §3.3](02-design-r2.md#L75-L107). The
  description text in r2 already mentions "structured error codes";
  r3 adds nothing schema-facing.
- **Documentation:**
  [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md) needs the
  three new codes listed alongside the r2 set. The plan
  ([03-plan-r3.md §11](03-plan-r3.md#L274)) handles this crumb.
- **Tests:** the r2 plan's ten cases stand; three new cases cover
  `NOT_FOUND`, `PERMISSION_DENIED`, `IO_ERROR`. Two failure
  paths from r2 (`NOT_A_FILE` on directory, `BINARY_CONTENT`) are
  unchanged.

## 7. Sequencing constraints (unchanged from r2)

Identical to [02-design-r2.md §4](02-design-r2.md#L417-L432). G30
must land first. r3 does not move any anchors; it adds the
classifier helper and wraps three call sites.

## 8. Risks (delta from r2)

The risks in [02-design-r2.md §5](02-design-r2.md#L434-L452) all
carry forward. New risks introduced by r3:

1. **`PERMISSION_DENIED` test is environment-sensitive.** Running
   the suite as root (some CI containers) silently bypasses the
   `chmod 0o000` denial. The plan
   ([03-plan-r3.md §7](03-plan-r3.md#L141)) gates the assertion on
   `process.getuid() !== 0` and explicitly notes the skip.
2. **`IO_ERROR` test stubs `fs/promises.open`.** This adds module
   mocking surface area that the rest of `builtins.test.ts` does
   not use. We accept it because the user prompt mandates a
   dedicated test for each new code; without the stub there is no
   reliable way to exercise the generic-IO branch on a healthy
   filesystem. The stub is scoped to a single `it()` block via
   Vitest's `vi.spyOn`.
3. **Classifier drift if Node renames errno codes.** Node's
   `error.code` strings are documented stable
   ([nodejs.org/api/errors](https://nodejs.org/api/errors.html#errorcode));
   the `IO_ERROR` fallback contains any breakage.

## 9. Open questions (resolved)

All round-2 open questions remain resolved as recorded in
[02-design-r2.md §7](02-design-r2.md#L478-L488). r3 adds and
resolves:

- **Expose `errno` to the agent or operator only?** Operator only.
  The structured `code` is the agent's contract; `errno` is a
  diagnostic affordance for log triage.
- **Add a dedicated code for `EISDIR` from `open`?** No. Collapsed
  into `NOT_A_FILE`.
- **Try to test the `stat → unlink → open` race directly?** No.
  Timing-dependent, no architectural value beyond the ENOENT case
  the classifier already covers.

## 10. Mapping of reviewer concerns to fixes

| [04-review-r2.md](04-review-r2.md) requirement | r3 location |
|------------------------------------------------|-------------|
| Wrap `stat` / `open` failures in structured envelopes | §3, §4.1, §4.2 |
| Add dedicated codes (e.g. `NOT_FOUND`, `PERMISSION_DENIED`, `IO_ERROR`) | §2, §3 |
| Keep `NOT_A_FILE` semantics from r2 | §2 (table), §4.1, §4.2 (EISDIR fold-in) |
| Tests must cover each new code | [03-plan-r3.md §7](03-plan-r3.md#L100) |
| Architecture-first; avoid over-engineering | §3 classifier is ~15 lines; no new module |
