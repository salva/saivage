# G31 — Design r2

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Round 1**: [02-design-r1.md](02-design-r1.md); reviewer critique
[04-review-r1.md](04-review-r1.md). All seven required changes in
[04-review-r1.md §Required Round-2 Changes](04-review-r1.md#L80) are
addressed below; cross-references in §6.

## 1. Two proposals (recommended remains Proposal A)

### Proposal A — Fail-fast cap with optional window (RECOMMENDED)

A single config field `mcp.maxFileReadBytes`, declared and wired
through `registerBuiltinServices` exactly like the existing
`maxOutputBytes` / `maxFetchChars` / `maxDownloadBytes`. Schema gains
optional `offset` and `length`. The handler:

1. Validates `offset` and `length` via a local `parseNonNegativeInt`
   helper; thrown helper errors are caught and translated into a
   structured `INVALID_ARGUMENT` envelope so all input failures share
   the documented error shape.
2. `stat`s the file once and stores `st.size` as the immutable
   snapshot of "the size we promised the agent we read against".
3. Rejects up-front with `FILE_TOO_LARGE` when no window was requested
   and `st.size > MAX_FILE_READ_BYTES`.
4. Rejects with `LENGTH_TOO_LARGE` when `length > MAX_FILE_READ_BYTES`.
5. Rejects with `INVALID_RANGE` when `offset > st.size`. Note:
   `offset === st.size` is **valid** and returns the empty-suffix
   success envelope; this is the documented semantics in §3.3.
6. Runs the **file-head NUL probe** (§3.4) on `[0, min(4 KiB,
   st.size))` independently of the requested window, before reading
   the window itself. This guarantees that binary files are rejected
   even when the agent asks for a non-zero-offset window over a
   region that happens to contain no NULs.
7. Opens a `FileHandle`, reads the requested window via
   `handle.read(buf, 0, toRead, effectiveOffset)`, captures the
   returned `bytesRead`, slices the buffer to that exact length, and
   reports the slice's `bytesRead` (not `toRead`) in the envelope.

Error envelopes mirror the existing `BLOCKED_PATH` shape on
`write_file` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L286-L296):
`{ content: { error, code, ...context }, isError: true }`. Per
[src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193), the
runtime then throws an `Error` whose message embeds the
JSON-serialised content, so the structured `code` reaches the agent
inside the thrown message.

**Pros** (unchanged from r1): single edit site; sibling-pattern
parity; no auto-stash coupling; minimal blast radius; the `offset` /
`length` escape hatch covers legitimate windowed-read use cases.

**Cons** (unchanged from r1): one extra round trip when an agent
needs the full content of a file that marginally exceeds the cap.

### Proposal B — Streaming length-prefixed reader with central policy

Identical to round 1; see [02-design-r1.md §1 Proposal B](02-design-r1.md#L45).
Rejected for the same reasons:

- Couples `read_file` to the stash subsystem before the dispatcher
  has a unified auto-stash policy.
- Adds a `readPolicy.ts` module and a second cap for stash size.
- Hides the failure signal from the agent.
- Speculative cross-reuse with G34 is not justified — `fetch_url`'s
  result shape (`truncated: boolean`, prompt-injection scan) is not
  the shape `read_file` wants.

## 2. Recommendation

**Proposal A** (recommendation unchanged). It matches the sibling
cap pattern already established in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L43) and
keeps G31 inside a single switch branch. The architecture-first
workspace rule is satisfied by following the existing canonical
pattern; the no-over-engineering rule is satisfied by adding no new
module.

## 3. Detailed shape (Proposal A)

### 3.1 New config field

In [src/config.ts](../../../../src/config.ts#L137-L147), inside the
`mcp` block (anchors valid for the live pre-G30 tree), alongside
`maxOutputBytes` / `maxFetchChars` / `maxDownloadBytes`:

```ts
maxFileReadBytes: z.number().default(200_000),
```

No new `superRefine` rule (independent of the shell-timeout
invariants).

### 3.2 Module-level let + register-time wiring

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L43),
adjacent to the existing caps:

```ts
let MAX_FILE_READ_BYTES = 200_000;
```

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1080),
inside `registerBuiltinServices`:

```ts
MAX_FILE_READ_BYTES = mcpConfig.maxFileReadBytes;
```

### 3.3 Schema

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L243-L246),
replace the `read_file` entry with:

```ts
{
  name: "read_file",
  description:
    "Read the contents of a project file. Refuses whole-file payloads " +
    "above mcp.maxFileReadBytes (default 200 KB). Pass 'offset' and " +
    "'length' to read a window; offset may equal file size (returns " +
    "empty content). For log triage prefer run_command with head/tail, " +
    "and for needle-in-haystack use search_files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: {
        type: "number",
        description:
          "Non-negative integer byte offset to start reading at (default 0). " +
          "Must be ≤ file size; equal-to-size returns an empty content window.",
      },
      length: {
        type: "number",
        description:
          "Non-negative integer maximum bytes to return (default mcp.maxFileReadBytes). " +
          "Must be ≤ mcp.maxFileReadBytes.",
      },
    },
    required: ["path"],
  },
},
```

### 3.4 Handler

Replace the `case "read_file":` body
([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278);
post-G30 this is `await readFile(fp, "utf-8")`) with the following.
Note the explicit `bytesRead` accounting (review concern 1), the
top-level argument validation `try/catch` (review concern 3), and
the file-head NUL probe (review concern 4):

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

  const st = await stat(fp);
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

  const totalSize = st.size; // stable snapshot used in envelope + truncated calc
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

  // Whole-file read with no window requested and file exceeds cap →
  // fail fast with explicit guidance.
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

  const handle = await open(fp, "r");
  let probeBytes = 0;
  let windowBytes = 0;
  let probeBuffer = Buffer.alloc(0);
  let windowBuffer = Buffer.alloc(0);
  try {
    // (1) File-head NUL probe: ALWAYS reads [0, min(4096, totalSize))
    //     from the file, independent of the requested window. This is
    //     the documented binary-content rule (see analysis §8 item 4).
    const probeSize = Math.min(4096, totalSize);
    if (probeSize > 0) {
      probeBuffer = Buffer.alloc(probeSize);
      const probeRead = await handle.read(probeBuffer, 0, probeSize, 0);
      probeBytes = probeRead.bytesRead;
      if (probeBuffer.subarray(0, probeBytes).includes(0)) {
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
    }

    // (2) Window read. effectiveLength is capped at MAX_FILE_READ_BYTES
    //     and at the remaining bytes from effectiveOffset. The actual
    //     bytes decoded come from { bytesRead }, never from the
    //     requested length, so a concurrent truncation cannot leak
    //     zero-fill bytes from Buffer.alloc into the decoded string
    //     or the binary probe.
    const effectiveLength = length ?? MAX_FILE_READ_BYTES;
    const remaining = totalSize - effectiveOffset;
    const toRead = Math.min(effectiveLength, remaining);
    if (toRead > 0) {
      // Reuse the probe buffer iff the requested window is exactly the
      // probe region; otherwise allocate a fresh one. Keeps the common
      // small-file case allocation-free beyond the probe.
      if (effectiveOffset === 0 && toRead <= probeBytes) {
        windowBuffer = probeBuffer.subarray(0, toRead) as Buffer;
        windowBytes = toRead;
      } else {
        windowBuffer = Buffer.alloc(toRead);
        const winRead = await handle.read(windowBuffer, 0, toRead, effectiveOffset);
        windowBytes = winRead.bytesRead;
      }
    }
  } finally {
    await handle.close();
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

`parseNonNegativeInt` (local helper, inserted immediately above
`parseOptionalTimeoutMs` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L375)):

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

Imports: after G30 lands, `node:fs/promises` already exports `stat`
and `open` for the rest of the filesystem handler. G31 needs no
additional top-level import. G31 does **not** itself call `readFile`;
whether `readFile` remains imported after G30 depends on which
sibling cases G30 rewrites to use `readFile` versus `open`/`handle`,
and is therefore G30's responsibility, not G31's. The plan's
pre-flight step explicitly confirms no unused symbols remain after
re-anchoring.

### 3.5 Error shape and policy source — explicit

- **Policy source:** single config field `mcp.maxFileReadBytes` at
  [src/config.ts](../../../../src/config.ts#L137-L147), threaded
  through `registerBuiltinServices` exactly like the existing caps.
  No hard-coded constant outside the 4 KiB probe size (an
  implementation detail of the probe heuristic, not a policy knob).
- **Error envelope shape:** `{ content: { error, code,
  ...context }, isError: true }`, same as the existing `BLOCKED_PATH`
  branch on `write_file` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L286-L296).
  Every error path carries a stable machine-readable `code`. The set
  is exhaustively: `FILE_TOO_LARGE`, `LENGTH_TOO_LARGE`,
  `INVALID_RANGE`, `BINARY_CONTENT`, `NOT_A_FILE`,
  `INVALID_ARGUMENT`. Every code is covered by at least one test in
  [03-plan-r2.md §7](03-plan-r2.md).
- **Runtime surface:** `McpRuntime.callTool`
  ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L193))
  unwraps `result.content` on success and throws
  `Error("Tool \"read_file\" on \"filesystem\" returned error: " +
  JSON.stringify(content))` on `isError: true`. The structured
  `code` is therefore a substring of the thrown message and is what
  every error-path test matches.
- **Success envelope shape:** `{ content, offset, length, size_bytes,
  truncated }`. `length === bytesRead` from the actual read, not from
  the requested `toRead`. The plain `{ content }` envelope is
  retired — acceptable under the no-backward-compat workspace rule.

### 3.6 NUL-probe semantics (review concern 4) — final rule

- The probe always reads the **file head** at offset 0 for
  `min(4096, totalSize)` bytes, regardless of the caller's `offset`.
- The probe uses `bytesRead` for its own slice — short reads at the
  4 KiB boundary cannot trigger false positives from
  `Buffer.alloc` zero-padding.
- A non-zero-offset request over a binary file still returns
  `BINARY_CONTENT`. The agent is instructed in the error message to
  use `run_command file/xxd` or `download_file`.
- Empty files (`totalSize === 0`) skip the probe entirely and return
  the empty success envelope.

### 3.7 EOF / offset semantics (review concern 5) — final rule

- `offset === totalSize`: valid; returns `content: "", length: 0,
  truncated: false`.
- `offset > totalSize`: rejected with `INVALID_RANGE`.
- The schema description and the regression tests in
  [03-plan-r2.md §7](03-plan-r2.md) match these rules exactly.

### 3.8 Public-API impact

- **Tool schema:** `read_file` gains optional `offset` and `length`.
  Required field stays `path`.
- **Tool result (success):** `{ content: string }` becomes
  `{ content: string, offset: number, length: number, size_bytes:
  number, truncated: boolean }`. Internal consumers
  ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L194-L196))
  forward the result verbatim, so nothing inside `src/` needs to
  change.
- **Tool result (failure):** the runtime throws; the agent receives
  the thrown message including the structured `code`. No new in-tree
  call site catches these throws specially.
- **Config:** new `mcp.maxFileReadBytes` (default 200_000). Existing
  per-project configs continue to load via Zod defaults.
- **Tests:** the existing assertion at
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L69-L72)
  switches from `toEqual({ content: "hello" })` to a `toMatchObject`
  on the new success envelope. The plan covers this in step 6.

## 4. Sequencing constraints (restated, refreshed)

- **Must land after G30.** Live source still imports
  `readFileSync`/`readSync`/`openSync`/`closeSync`/`statSync` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26).
  G30's `src/mcp/no-sync-fs.test.ts` regression guard
  ([../G30/APPROVED.md](../G30/APPROVED.md#L7)) will reject any G31
  edit that re-introduces sync calls. The line anchors in §3 are
  the live pre-G30 numbers and **will shift** when G30 lands; the
  plan's pre-flight re-anchors them by grep.
- **Same-file neighbours G32–G35:** disjoint ranges; either-order
  safe.
- **G06 / G36 / G37:** disjoint subsystems; no scanner-config change.

## 5. Risks

1. **Default cap too small for some agent prompts.** Mitigation: the
   error message names the config field and tells the agent how to
   re-issue. Operators can raise the cap project-wide without a code
   change. Daemon impact list per
   [../G30/APPROVED.md](../G30/APPROVED.md#L13).
2. **NUL-byte heuristic false positives.** Some legitimate UTF-8
   files contain NULs; in practice no source/log file does. Agents
   recover via `run_command file/xxd`.
3. **Race between `stat` and `read`.** `totalSize` is taken once
   from `stat`; subsequent `handle.read` may return
   `bytesRead < toRead`. The handler now reports `length: bytesRead`
   and computes `truncated` against `totalSize`, so the envelope is
   consistent and the binary probe never sees zero-padded tail.
4. **Buffer reuse between probe and window** is a deliberate
   micro-optimisation when `offset === 0 && toRead ≤ probeBytes`; if
   reuse causes any maintenance friction it can be dropped at the
   cost of one extra small allocation per call. The reuse path is
   covered by tests in [03-plan-r2.md §7](03-plan-r2.md) case 6.

## 6. Mapping of reviewer concerns to fixes

1. Byte accounting → §3.4 captures `bytesRead`, slices the buffer,
   reports `length = bytesRead`; §5 risk 3 explains the
   stat/read race.
2. Test contract vs `McpRuntime.callTool` → recorded in
   [01-analysis-r2.md §3](01-analysis-r2.md#L60); plan tests in
   [03-plan-r2.md §7](03-plan-r2.md) use `.rejects.toThrow(/CODE/)`.
3. Structured-error coverage → added `INVALID_ARGUMENT` envelope in
   §3.4; every code listed in §3.5 has a dedicated test in
   [03-plan-r2.md §7](03-plan-r2.md).
4. NUL-probe semantics → §3.6 picks "file-head probe at offset 0,
   independent of window"; [03-plan-r2.md §7](03-plan-r2.md) case 8
   exercises the non-zero-offset path.
5. Offset-at-EOF → §3.7 makes `offset === size` valid, `offset >
   size` `INVALID_RANGE`; tests cover both.
6. Anchors and G30 coordination → §1, §3, §4 re-anchored against
   live source; [03-plan-r2.md §0](03-plan-r2.md) re-anchors by grep
   after G30 lands.
7. Verification checklist correctness → [03-plan-r2.md §5](03-plan-r2.md)
   drops the bogus exact count, uses targeted symbol-presence greps.

## 7. Open questions (resolved)

- **Binary-probe size config-driven?** No. 4 KiB constant; not
  exposed.
- **`truncated: true` next-offset hint?** No.
- **Buffer reuse path complexity?** Acceptable; covered by a test.
