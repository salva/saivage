# G31 — Analysis r4

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Round 3**: [01-analysis-r3.md](01-analysis-r3.md),
[02-design-r3.md](02-design-r3.md), [03-plan-r3.md](03-plan-r3.md);
reviewer critique [04-review-r3.md](04-review-r3.md).

Round 4 is a targeted delta against the three blockers in
[04-review-r3.md](04-review-r3.md#L11-L23). The r3 substance
(classifier, exhaustive contract, structured envelopes for `stat` /
`open` / `read`) carries forward unchanged in spirit. Only the
testability story and the `handle.close()` rejection path move.

## 1. The three r3 blockers, restated

[04-review-r3.md §Blocking Findings](04-review-r3.md#L11-L23) lists:

1. The planned `IO_ERROR` test stubs `node:fs/promises.open` with
   `vi.spyOn(fsPromises, "open")`. In this native-ESM package
   ([package.json](../../../../package.json#L5)) Vitest cannot spy on
   the non-configurable `node:fs/promises` namespace export; the
   exact pattern fails with
   `Cannot spy on export "open". Module namespace is not configurable in ESM.`
2. The `EISDIR -> NOT_A_FILE` classifier branch is documented but
   left untested
   ([04-review-r3.md](04-review-r3.md#L13-L17),
   [03-plan-r3.md §7.4](03-plan-r3.md#L371-L377)).
3. The `try/finally` block still awaits `handle.close()` unguarded
   in [03-plan-r3.md §5 handler reference](03-plan-r3.md#L216-L220).
   A `close()` rejection escapes as a raw promise rejection from
   the handler, bypassing
   [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193)'s
   `isError: true` envelope serialiser, and can also mask a
   primary `readFailure` or `isBinary` observation captured before
   `finally` runs.

The architectural-consistency commitment from
[01-analysis-r3.md §3](01-analysis-r3.md#L70-L82) (exhaustive
contract, no raw rejections) still holds. r4 must close all three
gaps without bloating the classifier or the test surface.

## 2. Resolution direction

### 2.1 The IO_ERROR test (blocker 1)

The classifier in
[02-design-r3.md §3](02-design-r3.md#L40-L82) is a pure function of
`(err, path, context)`. The `IO_ERROR` branch is the `default:`
arm; it is entered for every errno not in the named list. The
agent-visible runtime behaviour for `IO_ERROR` is identical to the
`PERMISSION_DENIED` and `NOT_FOUND` cases — same envelope shape,
same `McpRuntime.callTool` serialisation
([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193)),
same `code` field — because all three flow through the same
`return { content: { ...classified, path }, isError: true }` site.

Two test strategies were considered and rejected:

- **Top-level `vi.mock("node:fs/promises", ...)`.** Works for ESM
  but pollutes every test in the file with a mocked filesystem.
  The remaining nine cases (success path, FILE_TOO_LARGE,
  BINARY_CONTENT, NOT_A_FILE on directory, …) all do real
  filesystem I/O against `mkdtempSync` roots. A factory wrapper
  with `importOriginal()` would partially restore the originals,
  but Vitest's module cache + the hoisting semantics make
  per-`it` overrides fragile in this file. Adds module-mock
  surface area for one branch.
- **`vi.doMock` plus dynamic re-import inside one `it`.** Avoids
  the global pollution, but requires re-importing
  `registerBuiltinServices` and a fresh `McpRuntime` per test —
  the existing `beforeEach` already builds the runtime against
  the live module, and reconciling two module copies is brittle.

The chosen strategy is **export `classifyFsError` from
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) and unit-test
it directly against synthetic `ErrnoException` objects**. The
classifier is already a pure, total function; testing it as such is
the natural shape. The runtime call site for `IO_ERROR` is
identical to the `PERMISSION_DENIED` / `NOT_FOUND` sites that
already get end-to-end coverage in
[03-plan-r3.md §7.1–7.2](03-plan-r3.md#L309-L342), so the absence
of a mock-driven end-to-end `IO_ERROR` case does not leave the
runtime wiring untested. This:

1. Removes the dependency on a Vitest ESM spy mechanism that
   does not work here.
2. Tests every classifier branch deterministically and in
   isolation, including branches that are unreachable in normal
   POSIX runtime (notably `EISDIR` from `open` — see §2.2).
3. Adds zero module-mock surface area and stays within the
   existing test file's style (real I/O against a real temp
   directory for end-to-end cases; pure unit tests for pure
   helpers).
4. Matches the "avoid over-engineering" rule from the workspace
   preferences.

The classifier export is the minimum change required to make the
function testable; no other API is widened. Test imports add
`classifyFsError` to the existing
`import { ... } from "./builtins.js"` line.

### 2.2 The EISDIR -> NOT_A_FILE branch (blocker 2)

The review asks for a directory-path test that exercises the
classifier's `EISDIR` branch
([02-design-r3.md §3](02-design-r3.md#L73-L82),
[02-design-r3.md §4.2](02-design-r3.md#L115-L128)). On POSIX,
running `stat(directory)` succeeds and the `!st.isFile()` branch
fires before `open` is called; the `EISDIR` arm of the classifier
is therefore **unreachable from the live handler in normal
operation** — it only fires on a `stat -> chmod/replace -> open`
race that cannot be deterministically constructed in a unit test
without timing primitives we do not want to add.

The honest, deterministic test for the `EISDIR` arm is the same
classifier unit test introduced in §2.1: invoke
`classifyFsError({ code: "EISDIR" }, "/x", "open")` and assert
the returned `{ code: "NOT_A_FILE", errno: "EISDIR", error: /.../ }`
shape. The runtime path is the same `return { content:
{ ...classified, path }, isError: true }` site as the other
classifier-emitted codes, so this also pins the
classifier-to-envelope wiring.

The existing directory-via-`!st.isFile()` end-to-end test
([03-plan-r2.md §7 case 10](03-plan-r2.md#L335-L340)) continues
to cover the `NOT_A_FILE` envelope shape end-to-end. r4 adds the
EISDIR classifier-arm unit test alongside, completing the
"every code has a dedicated test" contract from
[04-review-r2.md](04-review-r2.md#L13-L21).

### 2.3 The `handle.close()` failure path (blocker 3)

The r3 contract claims no error path escapes as a raw thrown
error ([02-design-r3.md §2](02-design-r3.md#L33-L41)). To make
that true for `close()` we wrap the `await handle.close()` call
inside the existing `finally` block in a focused `try/catch` that
routes the rejection through `classifyFsError(err, path,
"close")` and writes it into the existing `readFailure` slot
**only when no primary failure has been recorded** (no
`isBinary`, no prior `readFailure`). The ordering rationale:

- A primary `readFailure` from the body's `catch` already
  represents the first observable failure; the agent's recovery
  is based on that. Overwriting it with a `close()` failure
  would hide the cause.
- An `isBinary` observation is a successful detection of a
  pre-existing condition; the file is genuinely binary and the
  agent should see `BINARY_CONTENT` regardless of whether
  `close()` later rejects.
- When neither is set, `close()`-rejection is the only signal we
  have. Surfacing it as `IO_ERROR` (the classifier fallback for
  unfamiliar errnos; or `PERMISSION_DENIED` / `NOT_FOUND` if
  the kernel returns one of those — rare but possible) keeps
  the exhaustive-contract promise true.

The classifier's `context` parameter type widens from
`"stat" | "open" | "read"` to
`"stat" | "open" | "read" | "close"` so the operator-side
diagnostic string names the failing call. No new code is added;
the four contexts share the same classification rules.

Direct end-to-end testing of the close-failure path requires
mocking `node:fs/promises.open` to return a FileHandle whose
`close()` rejects — exactly the ESM-spy pattern blocker 1 forbids.
The deterministic test for this path is, again, the classifier
unit test (`classifyFsError({ code: "EIO" }, "/x", "close")`).
Combined with the design's static guarantee that every error
slot routes through `classifyFsError`, this is sufficient
coverage; the close-failure runtime wiring is mechanically
identical to the read-failure wiring already covered.

## 3. Why not a different approach for blocker 3

Two alternatives were considered:

- **Move `await handle.close()` outside `finally` into the main
  `try`.** Then a `close()` rejection would be caught by the
  outer `catch` and reach `classifyFsError` for free. Rejected:
  this loses the guarantee that the descriptor is closed when
  the body throws. We need both behaviours (always close,
  classify any rejection); the in-`finally` `try/catch` gives
  us both.
- **Swallow `close()` rejections silently.** Rejected: violates
  the exhaustive-contract promise from
  [02-design-r3.md §2](02-design-r3.md#L33-L41) and loses a
  legitimate operator diagnostic on disk failures during
  flush.

## 4. Coverage delta vs r3

| Code | r3 coverage | r4 coverage |
|------|-------------|-------------|
| `INVALID_ARGUMENT` | end-to-end (r2) | unchanged |
| `FILE_TOO_LARGE` | end-to-end (r2) | unchanged |
| `LENGTH_TOO_LARGE` | end-to-end (r2) | unchanged |
| `INVALID_RANGE` | end-to-end (r2) | unchanged |
| `BINARY_CONTENT` | end-to-end (r2) | unchanged |
| `NOT_A_FILE` (via `!st.isFile()`) | end-to-end (r2 case 10) | unchanged |
| `NOT_A_FILE` (via `EISDIR`) | none | classifier unit test (r4) |
| `NOT_FOUND` | end-to-end (r3 case 11) | unchanged + classifier unit test (r4) |
| `PERMISSION_DENIED` | end-to-end (r3 case 12, non-root) | unchanged + classifier unit test (r4) |
| `IO_ERROR` | planned spy (does not run) | classifier unit test (r4) |
| `close()` rejection -> classifier | none | classifier unit test (r4) |

The r3 end-to-end cases for `NOT_FOUND` / `PERMISSION_DENIED` /
the directory `NOT_A_FILE` stay; they prove the runtime serialises
classifier output correctly. r4 adds a single
`describe("classifyFsError (G31)", ...)` block that pins each
classifier branch on synthetic errors.

## 5. In/out of scope (unchanged from r3)

In scope, plus: export the classifier; widen the `context` union
to include `"close"`; guard `handle.close()` with a focused
`try/catch` in `finally`; add the classifier unit-test block. Out
of scope, unchanged from
[01-analysis-r2.md §5](01-analysis-r2.md#L85-L91): nothing new is
added to the production handler beyond the in-`finally` guard.

## 6. Sequencing constraints (unchanged from r3)

Same as [01-analysis-r3.md §7](01-analysis-r3.md#L182-L191). G30
must land first. The live source at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L16-L25)
still has sync imports and the sync handler body at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278).
r4 keeps the r3 re-anchor step.

## 7. Open questions resolved by r4

- **Export `classifyFsError`?** Yes. It is the only way to
  deterministically test the `IO_ERROR` and `EISDIR` arms
  without mocking `node:fs/promises`, and the function is pure
  / total / has no hidden dependencies.
- **What does `close()` failure surface as?** Whatever the
  classifier returns for the underlying errno, unless a primary
  failure (`readFailure` or `isBinary`) has already been
  recorded. Primary failures win.
- **Widen `context` for the operator message?** Yes, add
  `"close"`. No new branches; the operator log gets a precise
  failure-site label.
