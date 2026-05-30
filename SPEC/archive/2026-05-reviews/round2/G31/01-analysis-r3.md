# G31 — Analysis r3

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Round 2**: [01-analysis-r2.md](01-analysis-r2.md),
[02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md);
reviewer critique [04-review-r2.md](04-review-r2.md).

Round 3 is a targeted delta. Sections that were not contested by the
round-2 reviewer are not re-derived; this file only records the new
analysis needed to resolve the single blocking finding.

## 1. The round-2 blocker, restated

[04-review-r2.md §Blocking Finding](04-review-r2.md#L8-L10) records
exactly one outstanding issue:

> The structured-error contract is still overstated and can be
> violated by `stat` / `open` failures.

The r2 design promises that every `read_file` error path returns a
structured `{ content: { error, code, ... }, isError: true }`
envelope with one of the codes
`FILE_TOO_LARGE | LENGTH_TOO_LARGE | INVALID_RANGE | BINARY_CONTENT |
NOT_A_FILE | INVALID_ARGUMENT`
([02-design-r2.md §3.5](02-design-r2.md#L357-L361)). But the handler
sketch in [02-design-r2.md §3.4](02-design-r2.md#L194-L310) calls
`await stat(fp)` and later `await open(fp, "r")` outside any
`try/catch`. Both are real failure paths that an agent will hit:

- Missing file (ENOENT) is the single most common operator error.
- Permission errors (EACCES / EPERM) are routine on bind-mount
  layouts (`saivage` 10.0.3.111, `diedrico` 10.0.3.113, `saivage-v3`
  10.0.3.112 per [../G30/APPROVED.md](../G30/APPROVED.md#L13)).
- A deletion race between `stat` and `open` returns ENOENT from
  `open` even though `stat` succeeded.
- A path component that is not a directory (ENOTDIR) when resolving
  through a regular file returns from `stat`, not from the
  `st.isFile()` branch.

In all four cases the round-2 handler would propagate a raw Node
`Error` through the `await`. `McpRuntime.callTool`
([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193))
only serialises structured content when the handler returns
`isError: true`; a thrown error from the handler escapes that
serialisation entirely and reaches the agent with an unstructured
message like `ENOENT: no such file or directory, stat '/...'`. The
agent has no stable code to branch on.

## 2. Resolution direction

The user-provided instructions force option (a) (full structured
coverage) for architectural consistency with the rest of the design
and with the no-backward-compat workspace rule. The contract becomes:

> Every error path from `filesystem.read_file` returns a structured
> envelope with one of the codes in §1 of [02-design-r3.md](02-design-r3.md#L33).

To make that promise true we add three filesystem-error codes:
`NOT_FOUND`, `PERMISSION_DENIED`, `IO_ERROR`. `NOT_A_FILE` is kept
unchanged; it remains the dedicated code for the `!st.isFile()`
branch (directories, symlinks-to-dirs, sockets, FIFOs, block/char
devices).

The classification is mechanical and uses Node's documented errno
strings on the rejection (see
[Node errors `error.code`](https://nodejs.org/api/errors.html#errorcode)):

| `err.code` (from rejected `stat`/`open`) | Structured code | Rationale |
|------------------------------------------|-----------------|-----------|
| `ENOENT`                                 | `NOT_FOUND`     | The path does not exist (or was deleted between `stat` and `open`). |
| `ENOTDIR`                                | `NOT_FOUND`     | A path component is not a directory; from the agent's perspective, the requested path does not name a file. |
| `EACCES`, `EPERM`                        | `PERMISSION_DENIED` | The filesystem refused the operation. |
| `EISDIR`                                 | `NOT_A_FILE`    | `stat` succeeded but `open` complained because the path is a directory; surface the same code the `st.isFile()` branch uses. |
| everything else                          | `IO_ERROR`      | Catch-all for unexpected errno values (EMFILE, ENFILE, EIO, ELOOP, ENAMETOOLONG, ENOSPC on metadata, etc.). |

The classifier lives next to the handler. It does not consult Node
internals beyond `err.code`, which is documented stable; falling
back to `IO_ERROR` on missing or unknown codes makes the function
total.

## 3. Why not option (b) (narrow the contract)

The round-2 reviewer offered option (b) (drop the "exhaustive"
promise) as an alternative. We reject it because:

1. The agent-side contract is what makes the codes valuable. If the
   agent has to special-case "but stat/open errors are raw thrown
   strings", every downstream consumer (skill author, dispatcher
   debug surface, future automated retries) has to re-implement the
   classification ad hoc.
2. The classifier is ~15 lines. The bookkeeping required to
   document, test, and explain a partial contract is more code than
   the classifier itself.
3. Workspace rule: architecture-first, no over-engineering. A
   complete contract with a tiny classifier is architecturally
   cleaner than a partial contract with a documentation carve-out.

## 4. Mapping in detail

### 4.1 The `stat` call

The round-2 handler reads `st = await stat(fp)` unconditionally in
[02-design-r2.md §3.4](02-design-r2.md#L194). Failure modes:

- `ENOENT`, `ENOTDIR`: the requested path does not exist or
  resolves through a non-directory. Return `NOT_FOUND`.
- `EACCES`, `EPERM`: directory traversal on the parent denied
  metadata access. Return `PERMISSION_DENIED`.
- anything else: `IO_ERROR`.

The success path then keeps the existing `!st.isFile()` check, which
covers directories (the common case) and unusual node types. That
branch already returns the structured `NOT_A_FILE` envelope and is
unchanged.

### 4.2 The `open` call

The round-2 handler opens the file via `await open(fp, "r")` in
[02-design-r2.md §3.4](02-design-r2.md#L247). Failure modes that can
fire even after a successful `stat`:

- `ENOENT`: the file was deleted between `stat` and `open`. Return
  `NOT_FOUND`. The envelope notes the race so the agent can retry
  or diagnose.
- `EACCES`, `EPERM`: read permission denied on the file itself.
  Return `PERMISSION_DENIED`.
- `EISDIR`: `stat` returned a `Stats` flagged as file but the entry
  is in fact a directory after symlink resolution / inode race.
  Return `NOT_A_FILE` (keeps the existing semantics; consistent
  with the `!st.isFile()` branch).
- `EMFILE`, `ENFILE`, `ENOSPC`, etc.: return `IO_ERROR`.

### 4.3 Read-time failures (`handle.read`)

The two `handle.read` calls in
[02-design-r2.md §3.4](02-design-r2.md#L266-L300) can also reject
(low-level I/O errors during the read itself, e.g. EIO on a failing
disk, or EBADF after an unexpected close). These are rare but real.
The handler wraps them in the same classifier and returns
`IO_ERROR`. The `try { ... } finally { await handle.close(); }`
block in the round-2 sketch already guarantees the descriptor is
closed; r3 keeps that contract by routing the rejection through the
classifier between the `try` body and the `finally`.

### 4.4 The classifier function

A single function `classifyFsError(err: unknown, path: string,
fallback: "IO_ERROR" | ...): { code, error, errno? }` returns the
envelope `content` object. It does not depend on the call site, so
the same helper is reused by the `stat`, `open`, and `handle.read`
sites. It also records the raw `err.code` string under `errno` for
operator-side diagnosis (helpful in the
[src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L194-L196)
log envelope) without leaking it as the agent-visible `code`.

## 5. Test coverage delta

[04-review-r2.md §R1 Change Verification](04-review-r2.md#L13-L21)
requires every documented code to have a dedicated test, asserted
through `McpRuntime.callTool`'s thrown-error message contract
([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193)).
r3 adds four new cases on top of the ten in
[03-plan-r2.md §7](03-plan-r2.md#L210-L340):

1. `NOT_FOUND` on a path that does not exist (covers ENOENT from
   `stat`).
2. `NOT_FOUND` via `stat`/`open` race — practical surrogate: chmod a
   parent directory to remove `+x`, attempt the read, restore. This
   exercises the `EACCES`-on-traversal path and is documented as
   such; on POSIX it lands in `PERMISSION_DENIED` and is therefore
   actually the next case. We do not try to fabricate a real
   `stat → unlink → open` race in unit tests because that is timing
   dependent and adds no architectural value; the design records
   the path and the classifier is exercised by the ENOENT case.
3. `PERMISSION_DENIED` on a file with mode `0o000` (skipped when
   the test runs as root — both daemon and dev users should hit
   the unprivileged path; the test logs a skip and asserts only the
   non-skipped branch).
4. `IO_ERROR` is the catch-all: rather than synthesising a real
   EIO we forge a `FileHandle.read` rejection via a focused
   spy/stub on `fs.promises.open` (see plan §7.4). Optional under
   "avoid over-engineering" — the implementation test is included
   because the user prompt mandates a dedicated test for each new
   code.

## 6. In/out of scope (unchanged from r2)

In scope, plus: classification of `stat` / `open` / `handle.read`
failures inside the same handler. Out of scope, unchanged from
[01-analysis-r2.md §5](01-analysis-r2.md#L85-L91).

## 7. Sequencing constraints (unchanged from r2)

Same as [01-analysis-r2.md §6](01-analysis-r2.md#L93-L113). G30
must land first; the live source still has the pre-G30 sync imports
at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L16-L25)
and the sync handler body at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278).
r3 keeps the round-2 re-anchor step in
[03-plan-r3.md §0](03-plan-r3.md#L10).

## 8. Open questions resolved by r3

- **Should the classifier surface the raw errno to the agent?** No.
  Stable codes are the contract; raw errno is operator-side only,
  emitted under the `errno` field for log triage. This keeps the
  agent contract minimal and the operator diagnostics complete.
- **Is `EISDIR` from `open` worth a distinct code?** No. It
  collapses to `NOT_A_FILE` because the agent's recovery is
  identical to the `st.isFile() === false` case (use `list_dir`).
- **What about `ELOOP` (symlink cycle)?** Returns `IO_ERROR` via
  the fallback. We do not add a dedicated code because the agent
  recovery is the same as any other unexpected failure and the
  rate is negligible.
