# G31 — Implementation Plan r4

**Chosen design**: Proposal A from
[02-design-r4.md](02-design-r4.md), which inherits everything from
[02-design-r3.md](02-design-r3.md) and adds (a) an export of
`classifyFsError`, (b) a wider `context` union, and (c) an
in-`finally` guard around `handle.close()`.

**Round 3 baseline**: [03-plan-r3.md](03-plan-r3.md); reviewer
critique [04-review-r3.md](04-review-r3.md).

r4 is a delta plan. Steps identical to
[03-plan-r3.md](03-plan-r3.md) are referenced, not duplicated.
Steps that change are spelled out in full.

## 0. Pre-flight (unchanged)

[03-plan-r3.md §0](03-plan-r3.md#L18-L21). Confirm G30 has landed,
re-anchor the live line numbers in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) (still
pre-G30 today at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L16-L25) and
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278)),
confirm `git status` is clean, baseline `npm run build`.

## 1. Add the config field (unchanged)

[03-plan-r3.md §1](03-plan-r3.md#L23-L26).

## 2. Module-level let + register-time wiring (unchanged)

[03-plan-r3.md §2](03-plan-r3.md#L28-L30).

## 3. Add helpers

### 3.1 `parseNonNegativeInt` (unchanged)

[03-plan-r3.md §3.1](03-plan-r3.md#L34-L37).

### 3.2 `classifyFsError` — exported, with `"close"` context

Insert the function body from
[02-design-r4.md §3](02-design-r4.md#L43-L82) between
`parseNonNegativeInt` and `parseOptionalTimeoutMs` in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts). Three
deltas vs r3:

- Prefix the function declaration with `export`.
- Also export the `FsErrorCode` type alias and the
  `ClassifiedFsError` interface (both declared immediately
  above the function).
- Widen the `context` parameter to include `"close"`.

A one-line comment immediately above the export reads:

```ts
// Exported for unit testing only. classify*FsError* is intentionally
// scoped to read_file's contract; other filesystem tools should add
// their own classifier if they need one.
```

This addresses
[02-design-r4.md §8 new risk](02-design-r4.md#L139-L145) without
adding mechanism.

## 4. Replace the `read_file` schema (unchanged)

[03-plan-r3.md §4](03-plan-r3.md#L46-L48).

## 5. Replace the `read_file` handler

Assembly order is identical to
[03-plan-r3.md §5](03-plan-r3.md#L50-L223). The only change is
the `finally` body, which now wraps `await handle.close()` in
its own `try/catch` and conditionally writes the classified
result into `readFailure` when no primary failure is recorded.

Replace the r3 `finally { await handle.close(); }` block with:

```ts
} finally {
  try {
    await handle.close();
  } catch (closeErr) {
    if (!readFailure && !isBinary) {
      readFailure = classifyFsError(closeErr, args.path as string, "close");
    }
  }
}
```

The rest of the handler (probe loop, window read, post-`finally`
`isBinary` / `readFailure` / success branches) is unchanged from
the reference assembly in
[03-plan-r3.md §5](03-plan-r3.md#L73-L218).

For the implementer: replicate the full handler body from
[02-design-r4.md §4](02-design-r4.md#L84-L168), which is the
authoritative reference for r4 and includes both the close-guard
and all r3 wrapping. Audit `node:fs/promises` imports per
[03-plan-r2.md §4 closing paragraph](03-plan-r2.md#L143-L153);
no new imports are needed beyond what r3 already required.

## 6. Terminal verification (delta from r3)

Same as [03-plan-r3.md §6](03-plan-r3.md#L225-L245), plus three
additional checks:

```bash
# classifyFsError is exported (single export line).
grep -nE "^export function classifyFsError" src/mcp/builtins.ts
# → 1 line

# All four classifier contexts appear as call-site strings.
grep -nE "classifyFsError\(.*,.*,.*\"(stat|open|read|close)\"\)" src/mcp/builtins.ts
# → 4 lines

# The close-failure try/catch lives inside the finally block.
grep -n -A4 "} finally {" src/mcp/builtins.ts | grep -c "handle.close"
# → 1
```

The r3 grep block for the nine `code: "..."` literals is
unchanged.

G30 invariant remains:

```bash
grep -nE "(readFileSync|readSync|openSync|closeSync|statSync)" src/mcp/builtins.ts
# → empty
```

## 7. Add G31-specific regression tests

Begin from [03-plan-r2.md §7](03-plan-r2.md#L210-L340) cases 1–10
(unchanged) and the r3 cases 11 and 12 from
[03-plan-r3.md §7.1–7.2](03-plan-r3.md#L309-L342) (unchanged
end-to-end coverage for `NOT_FOUND` and `PERMISSION_DENIED`).
**Drop r3 case 13** (the failing `vi.spyOn(fsPromises, "open")`
plan from
[03-plan-r3.md §7.3](03-plan-r3.md#L344-L362)).

Replace it with a dedicated classifier unit-test block. Imports
in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts):

- Existing `node:fs` import gains `chmodSync` (already added in
  r3 plan).
- The existing
  `import { registerBuiltinServices } from "./builtins.js"`
  line gains `classifyFsError`:
  `import { registerBuiltinServices, classifyFsError } from "./builtins.js";`.
- No `vi` import is needed (the unit tests do not mock).

### 7.1 Helper: synthesise an `ErrnoException`

Inline the helper at the top of the new `describe` block:

```ts
function fsErr(code: string, message = `simulated ${code}`): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}
```

### 7.2 Classifier unit tests — all four branches

Add a sibling `describe` block alongside
`describe("built-in MCP services", ...)`:

```ts
describe("classifyFsError (G31)", () => {
  it("maps ENOENT to NOT_FOUND with errno", () => {
    const result = classifyFsError(fsErr("ENOENT"), "/x/y.txt", "stat");
    expect(result).toEqual({
      code: "NOT_FOUND",
      errno: "ENOENT",
      error: expect.stringMatching(/^NOT_FOUND: \/x\/y\.txt does not exist \(during stat\)\./),
    });
  });

  it("maps ENOTDIR to NOT_FOUND", () => {
    expect(classifyFsError(fsErr("ENOTDIR"), "/x", "stat").code).toBe("NOT_FOUND");
  });

  it("maps EACCES to PERMISSION_DENIED with errno", () => {
    const result = classifyFsError(fsErr("EACCES"), "/x", "open");
    expect(result.code).toBe("PERMISSION_DENIED");
    expect(result.errno).toBe("EACCES");
  });

  it("maps EPERM to PERMISSION_DENIED", () => {
    expect(classifyFsError(fsErr("EPERM"), "/x", "open").code).toBe("PERMISSION_DENIED");
  });

  it("maps EISDIR from open to NOT_A_FILE (covers the open-race branch)", () => {
    const result = classifyFsError(fsErr("EISDIR"), "/x", "open");
    expect(result).toMatchObject({
      code: "NOT_A_FILE",
      errno: "EISDIR",
      error: expect.stringMatching(/NOT_A_FILE: \/x is a directory/),
    });
  });

  it("maps unknown errno (EIO) to IO_ERROR with errno preserved", () => {
    const result = classifyFsError(fsErr("EIO"), "/x", "read");
    expect(result).toMatchObject({
      code: "IO_ERROR",
      errno: "EIO",
      error: expect.stringMatching(/IO_ERROR: low-level I\/O error on \/x \(during read\)/),
    });
  });

  it("maps a close() rejection through the close context", () => {
    const result = classifyFsError(fsErr("EIO", "disk flush"), "/x", "close");
    expect(result.code).toBe("IO_ERROR");
    expect(result.error).toMatch(/\(during close\)/);
  });

  it("falls through to IO_ERROR without errno on a non-Error rejection", () => {
    const result = classifyFsError("string-rejection", "/x", "read");
    expect(result.code).toBe("IO_ERROR");
    expect(result.errno).toBeUndefined();
  });
});
```

These eight tests are deterministic, do no I/O, and require no
mocking. Together with the existing end-to-end cases they pin
every branch of the classifier:

- ENOENT and ENOTDIR -> NOT_FOUND (the latter is r4's added
  coverage; the live `stat` path already exercises ENOENT
  end-to-end).
- EACCES and EPERM -> PERMISSION_DENIED.
- EISDIR -> NOT_A_FILE (this is the directory-branch test
  required by
  [04-review-r3.md §2](04-review-r3.md#L13-L17); the
  classifier-arm is unreachable from the live handler on POSIX
  because `stat` succeeds first, so the unit test is the only
  honest place to exercise it).
- EIO -> IO_ERROR (the `default:` arm; replaces the failed
  Vitest spy plan from
  [04-review-r3.md §1](04-review-r3.md#L11-L13)).
- `"close"` context -> classifier returns the same `IO_ERROR`
  envelope, with the operator-facing message labelled `during
  close` (covers blocker 3 from
  [04-review-r3.md §3](04-review-r3.md#L19-L23)).
- Non-Error rejections (e.g. a thrown string) -> IO_ERROR
  with no `errno` field; documents the total-function
  guarantee.

### 7.3 Why no end-to-end IO_ERROR or close-failure test

Both would require mocking `node:fs/promises.open` to return a
FileHandle whose `read` or `close` rejects, which is precisely
the ESM-spy pattern
[04-review-r3.md §1](04-review-r3.md#L11-L13) ruled out. The
runtime-wiring path for `IO_ERROR` is identical to
`PERMISSION_DENIED`'s wiring (same call site, same
`{ content: { ...classified, path }, isError: true }` shape,
same `McpRuntime.callTool` serialisation at
[src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193)),
which is already covered end-to-end by case 12. Combined with
the classifier unit tests, every code is reachable from a
deterministic test; no branch is left to inference.

## 8. Update the existing happy-path test (unchanged)

[03-plan-r3.md §8](03-plan-r3.md#L258-L262).

## 9. Update config defaults test (unchanged)

[03-plan-r3.md §9](03-plan-r3.md#L264-L266).

## 10. Update other inline `mcp` test literals (unchanged)

[03-plan-r3.md §10](03-plan-r3.md#L268-L270).

## 11. Documentation crumbs (delta from r3)

[03-plan-r3.md §11](03-plan-r3.md#L272-L283) stands. r4 has no
additional doc surface — the structured-code list is unchanged
and the new export is internal-by-convention.

## 12. Build, lint, test, daemon validation (unchanged)

[03-plan-r3.md §12](03-plan-r3.md#L285-L296). Plus: the
classifier unit-test block runs as part of the existing
`builtins.test.ts` Vitest invocation; no new command.

Daemon smoke remains: `saivage` 10.0.3.111, `saivage-v3`
10.0.3.112, `diedrico` 10.0.3.113. Drive one
`read_file` invocation per daemon for FILE_TOO_LARGE and
NOT_FOUND; both error envelopes must reach the agent through
the runtime's thrown-message JSON, visible in the dispatcher
log envelope at
[src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L194-L196).

## 13. Test gates summary (delta from r3)

All r2 + r3 gates from
[03-plan-r3.md §13](03-plan-r3.md#L298-L308) carry forward.
Changes:

- r3 case 13 (`IO_ERROR` via spy) is removed.
- New `describe("classifyFsError (G31)", ...)` block adds eight
  passing tests; every classifier branch (NOT_FOUND via ENOENT,
  NOT_FOUND via ENOTDIR, PERMISSION_DENIED via EACCES,
  PERMISSION_DENIED via EPERM, NOT_A_FILE via EISDIR, IO_ERROR
  via EIO, IO_ERROR via close context, IO_ERROR fallback on
  non-Error rejection) is exercised.
- Verification grep block in §6 prints non-zero counts for all
  nine documented codes, lists four classifier call-site
  contexts (stat/open/read/close), and the close-guard grep
  prints exactly 1.

## 14. Roll-back (unchanged)

[03-plan-r3.md §14](03-plan-r3.md#L310-L313). Single-commit
revert still suffices. The new export, the close-guard, and the
classifier unit-test block all drop together.
