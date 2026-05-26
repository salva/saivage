# G31 — Design r1

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

## 1. Two proposals

### Proposal A — Fail-fast cap with optional window (RECOMMENDED)

Add a single new config field `mcp.maxFileReadBytes`, follow the
existing module-let-then-assign-in-registerBuiltinServices pattern
already used by `MAX_OUTPUT`, `MAX_FETCH_CHARS`, and
`MAX_DOWNLOAD_BYTES`. Extend the `read_file` schema with optional
`offset` and `length` parameters. The handler:

1. `stat`s the file once and rejects up-front with a structured
   `FILE_TOO_LARGE` error when `size > cap` and no `length` was
   provided.
2. When `offset` and/or `length` are provided, opens an `fd`, reads
   exactly the requested window via `fileHandle.read`, and validates
   that `length <= cap`.
3. Performs a fast binary-content check on the first 4 KiB
   (null-byte scan); returns `BINARY_CONTENT` if present, instructing
   the agent to fall back to `run_command` (`xxd`, `file`, etc.) or
   `download_file`.

No new helper module, no new public types, no auto-stash. The error
envelope reuses the same shape `write_file` uses today for
`BLOCKED_PATH` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L286-L296)).

**Pros**

- Same shape as every other capped builtin (Section 2 of the analysis).
- Single edit site; minimal blast radius; no new module.
- Agents already understand the `error + suggestion` envelope.
- The optional `offset` / `length` is the standard escape hatch for
  legitimate "read the last 50 lines of a 10 MB log" use cases without
  re-implementing `tail` inside the builtin.
- Honours the project rule "no over-engineering": no streaming reader,
  no stash coupling, no centralised policy module.

**Cons**

- Two config fields (`maxFileReadBytes`, plus the hard-coded 4-KiB
  binary-probe constant) instead of one. The probe constant is a
  local implementation detail, not config-exposed.
- If an agent legitimately needs the full content of a file that
  marginally exceeds the cap, it must take one extra round trip to
  re-issue with `offset: 0, length: <cap>` and accept the truncation.

### Proposal B — Streaming length-prefixed reader with central policy

Introduce `src/mcp/readPolicy.ts` exporting a `FileReadPolicy`
interface plus a `streamReadCapped(absPath, cap)` helper that opens
the file as a `ReadStream`, accumulates chunks against a running byte
counter, aborts at the cap, and either (a) returns the buffered
content if the cap was not hit, or (b) auto-stashes the partial via
`stashResult` ([src/runtime/stash.ts](../../../../src/runtime/stash.ts#L23-L30))
and returns `{ stash_path, total_bytes, returned_bytes }` mirroring
the dispatcher's existing `read_stash` shape
([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L144-L153)).

**Pros**

- Never allocates more than one chunk at a time; safe even if the
  agent intentionally targets a 50 GB file.
- "Same policy" object can be reused by G34 (streaming `fetch_url`)
  once it lands.
- No extra round trip for the agent: it always gets *something* back
  (either the content or a stash handle).

**Cons**

- Couples `read_file` to the stash subsystem before G31 needs to.
  Auto-stash on overflow is a separate concern that should be driven
  by the dispatcher, not by individual builtins — picking it up here
  hard-codes a policy that future tools may want to override.
- Adds a new module (`readPolicy.ts`), new tests, new contract
  surface, and a second cap (one for the in-band response, one for
  the maximum stash size) — clearly over-engineering for the stated
  finding.
- Hides the failure signal: an agent that habitually slurps lockfiles
  never sees the error and never learns to use `search_files` /
  `run_command head` / `tail`.
- The "shared policy with G34" argument is speculative — G34's
  cross-link explicitly defers the streaming-reader work to its own
  finding ([../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)),
  and `fetch_url` already returns a `truncated: boolean` flag plus
  prompt-injection scan — a different shape than `read_file` would
  want. Premature unification.

## 2. Recommendation

**Proposal A.** Rationale:

- Matches the architecture-first rule in the workspace memory
  ("clean code and proper architecture are the top priority, even if
  it means more upfront work … never apply minimal-change defaults").
  Here, the *proper* architecture is the pattern already established
  by `fetch_url` and `run_command`, not a new policy module.
- Matches "no over-engineering" — a single config field, a single
  schema change, and a single switch branch rewrite. Proposal B would
  add a module the codebase does not yet need.
- The two main agent failure modes (heap blow-up on multi-MB logs,
  silent token waste) are both fully addressed by failing fast and
  pointing at the existing `search_files` / `run_command head|tail`
  alternatives. Auto-stash is a separate, larger redesign that should
  not be slipped in under this finding.
- G34 will independently decide whether `fetch_url` wants streaming
  semantics. There is no real shared infrastructure between a local
  file read and an HTTP body read; pretending there is creates
  coupling.

## 3. Detailed shape (Proposal A)

### 3.1 New config field

In [src/config.ts](../../../../src/config.ts#L137-L147), inside the
`mcp` block, alongside `maxOutputBytes`, `maxFetchChars`,
`maxDownloadBytes`, add:

```ts
maxFileReadBytes: z.number().default(200_000),
```

Default chosen to mirror `maxFetchChars` (Section 7 of the analysis).
The `superRefine` block already on `mcp` does not need to know about
this field — it is independent of the shell-timeout invariants.

### 3.2 Module-level let and registerBuiltinServices wire-up

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L43),
next to the existing caps:

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
replace the `read_file` tool entry with:

```ts
{
  name: "read_file",
  description:
    "Read the contents of a project file. Refuses payloads above " +
    "mcp.maxFileReadBytes (default 200 KB). Pass 'offset' and " +
    "'length' to read a window; for log triage prefer run_command " +
    "with head/tail, and for needle-in-haystack use search_files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: {
        type: "number",
        description:
          "Byte offset to start reading at (default 0). Must be < file size.",
      },
      length: {
        type: "number",
        description:
          "Maximum bytes to return (default mcp.maxFileReadBytes). " +
          "Must be ≤ mcp.maxFileReadBytes.",
      },
    },
    required: ["path"],
  },
},
```

The description carries the policy the agent should learn — same
style as the `run_command` description today
([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L335-L336)).

### 3.4 Handler

Replace the `case "read_file":` body
([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278),
post-G30 it will be the `await readFile(fp, "utf-8")` form) with:

```ts
case "read_file": {
  const fp = resolvePath(args.path as string);
  const offset = parseNonNegativeInt(args.offset, "offset");
  const length = parseNonNegativeInt(args.length, "length");

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

  const effectiveOffset = offset ?? 0;
  if (effectiveOffset > st.size) {
    return {
      content: {
        error:
          `INVALID_RANGE: offset=${effectiveOffset} exceeds ` +
          `file size=${st.size}`,
        code: "INVALID_RANGE",
        path: args.path,
        offset: effectiveOffset,
        size_bytes: st.size,
      },
      isError: true,
    };
  }

  const effectiveLength = length ?? MAX_FILE_READ_BYTES;
  const remaining = st.size - effectiveOffset;

  // Whole-file read with no window requested and file exceeds cap →
  // fail fast with explicit guidance. Agents that really want the
  // whole file must re-issue with explicit length.
  if (offset === undefined && length === undefined && st.size > MAX_FILE_READ_BYTES) {
    return {
      content: {
        error:
          `FILE_TOO_LARGE: size=${st.size} bytes exceeds ` +
          `mcp.maxFileReadBytes=${MAX_FILE_READ_BYTES}. ` +
          `Re-issue with explicit offset/length (each ≤ ${MAX_FILE_READ_BYTES}), ` +
          `or use run_command with head/tail/grep, or use search_files.`,
        code: "FILE_TOO_LARGE",
        path: args.path,
        size_bytes: st.size,
        max_bytes: MAX_FILE_READ_BYTES,
      },
      isError: true,
    };
  }

  const toRead = Math.min(effectiveLength, remaining);

  const handle = await open(fp, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(toRead);
    await handle.read(buffer, 0, toRead, effectiveOffset);
  } finally {
    await handle.close();
  }

  // Fast binary-content probe: first 4 KiB only.
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (probe.includes(0)) {
    return {
      content: {
        error:
          `BINARY_CONTENT: ${args.path} contains a NUL byte in its ` +
          `first 4 KiB. Use run_command with file/xxd, or download_file ` +
          `if you need the raw bytes.`,
        code: "BINARY_CONTENT",
        path: args.path,
        size_bytes: st.size,
      },
      isError: true,
    };
  }

  const content = buffer.toString("utf-8");
  const truncated = effectiveOffset + toRead < st.size;
  return {
    content: {
      content,
      offset: effectiveOffset,
      length: toRead,
      size_bytes: st.size,
      truncated,
    },
    isError: false,
  };
}
```

The `parseNonNegativeInt` helper is local to this file and mirrors
the `parseOptionalTimeoutMs` style already used at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L385-L398):

```ts
function parseNonNegativeInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return raw;
}
```

Imports added inside the existing `node:fs/promises` block (G30 has
already added `readFile`, `stat`, `open`): no new top-level imports
needed beyond what G30 lands.

### 3.5 Error shape and policy source — explicit

- **Policy source.** Single config field `mcp.maxFileReadBytes` in
  [src/config.ts](../../../../src/config.ts#L137-L147), threaded
  through `registerBuiltinServices` exactly like
  `mcp.maxFetchChars`/`maxOutputBytes`/`maxDownloadBytes`. **No
  hard-coded constant** beyond the 4-KiB binary probe size, which is
  an implementation detail of the probe heuristic, not a policy.
- **Error envelope shape.** Same as the existing `BLOCKED_PATH`
  branch on `write_file` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L286-L296):
  `{ content: { error, code, ...context }, isError: true }`. Every
  error path returns a stable machine-readable `code`
  (`FILE_TOO_LARGE`, `LENGTH_TOO_LARGE`, `INVALID_RANGE`,
  `BINARY_CONTENT`, `NOT_A_FILE`), the original `path`, and the
  numeric inputs that produced the failure so the agent can compose
  the next call without re-statting the file.
- **Success envelope shape.** `{ content, offset, length, size_bytes,
  truncated }` — new fields are additive but documented. The plain
  `{ content }` envelope used today is retired; this is acceptable
  under the no-backward-compat rule and matches the project memory
  guideline ("actively remove code supporting old features/structures
  rather than keeping migration shims").

### 3.6 Public-API impact

- **Tool schema:** `read_file` gains optional `offset` and `length`
  properties. The required field stays `path`.
- **Tool result:** `{ content: string }` becomes
  `{ content: string, offset: number, length: number, size_bytes:
  number, truncated: boolean }` on success, or a structured error
  envelope on failure. Every consumer of `read_file` results inside
  `src/` already treats the result as opaque JSON
  ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L194-L196))
  and forwards it to the LLM verbatim. No internal call sites need
  to change.
- **Config:** new `mcp.maxFileReadBytes` (default 200_000). Existing
  per-project `.saivage/saivage.json` files continue to load — Zod
  defaults fill the field in transparently.
- **Tests:** the assertion in
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L71-L72)
  that compares against `{ content: "hello" }` becomes a partial-match
  on the new envelope (covered by the plan).

## 4. Sequencing constraints (restated for the design)

- **Must land after G30** — G31 edits the post-G30 async handler and
  reuses `readFile` / `stat` / `open` from `node:fs/promises` already
  imported by G30 ([../G30/03-plan-r2.md](../G30/03-plan-r2.md#L41-L50)).
  Re-introducing any `*Sync` symbol would trip the G30 regression
  guard `src/mcp/no-sync-fs.test.ts` ([../G30/APPROVED.md](../G30/APPROVED.md)).
- **Independent of G06 / G36 / G37** — they own different
  subdirectories. They share only the
  `src/testing/noSyncFsScanner.ts` helper, which G31 does not modify.
- **Same-file neighbours G32 / G33 / G34 / G35** — disjoint line
  ranges; either-order safe. Suggested commit order is G30 → G31 →
  G32 / G33 / G34 / G35 in any internal order.
- **F09 (round 1)** — cited as the policy precedent for "tool
  results must fit the agent's context budget". No code dependency.

## 5. Risks

1. **Default cap too small for current agent prompts.** Mitigation:
   the new error message names the config field and tells the agent
   exactly how to re-issue. Operators can raise the cap project-wide
   without code changes. The G30 daemon-impact list
   ([../G30/APPROVED.md](../G30/APPROVED.md)) — `saivage`
   (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112)
   — applies here too; after deploy, sample one agent turn that
   reads a big artefact (e.g. `getrich/results/*.json`) and verify
   the error message lands instead of an OOM.
2. **NUL-byte heuristic false positives.** Some legitimate UTF-8
   text contains NUL only after deliberate corruption; in practice
   no source/log file does. False positives are recoverable by the
   agent (use `run_command file` / `xxd`).
3. **Race between `stat` and `read`.** A concurrent truncation
   between the two calls would yield a short read, returned with
   `length < requested`. The handler already reports
   `length: toRead` from the actual `handle.read` return value, so
   the agent sees the true byte count. Acceptable.

## 6. Open questions for the reviewer

- Should the binary-probe size be config-driven? Recommendation: no
  (the 4 KiB constant is an implementation detail; exposing it as
  config invites bikeshedding without operational benefit).
- Should the `truncated: true` success path also emit a hint
  pointing at the next `offset`? Recommendation: no — the agent has
  `offset + length` and `size_bytes` and can compute the next call
  itself; adding a hint duplicates information.
