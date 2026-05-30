# G31 — Analysis r2

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Round 1**: [01-analysis-r1.md](01-analysis-r1.md), reviewer critique
[04-review-r1.md](04-review-r1.md).

**Subsystem**: mcp / filesystem builtin.

## 1. What the code actually does today (re-anchored)

The live `filesystem.read_file` handler is still the synchronous slurp
described in the finding, located at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278):

```ts
case "read_file": {
  const fp = resolvePath(args.path as string);
  const content = readFileSync(fp, "utf-8");
  return { content: { content }, isError: false };
}
```

The schema is at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L243-L246) and
accepts only `{ path: string }`. The `node:fs` import block at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26) still
imports `readFileSync`/`readSync`/`openSync`/`closeSync`/`statSync` —
G30 is approved but has not landed in `src/` yet
([../G30/APPROVED.md](../G30/APPROVED.md#L1-L13)).

There is no `offset`, no `length`, no encoding selector, no truncation
flag, and no client-controlled cap. Concrete failure modes (unchanged
from r1):

1. Heap blow-up on multi-MB artefacts read as one Node string, then
   re-encoded inside the dispatcher envelope at
   [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L194-L196).
2. Event-loop stall via `readFileSync`. G30 removes the sync call but
   leaves the unbounded heap allocation in place — G31 is needed even
   after G30.
3. Token waste and silent client-side truncation downstream of the
   compaction pipeline at
   [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts).

## 2. Pattern in sibling builtins (unchanged)

| Tool | Module cap | Config field | Reference |
|------|-----------|--------------|-----------|
| `run_command` tail | `MAX_OUTPUT` (100 KiB) | `mcp.maxOutputBytes` | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077) |
| `fetch_url` / `fetch_page_text` | `MAX_FETCH_CHARS` (200 000) | `mcp.maxFetchChars` | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078) |
| `download_file` | `MAX_DOWNLOAD_BYTES` (250 MiB) | `mcp.maxDownloadBytes` | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L43), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1079) |
| `read_file` | none | none | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278) |

The `mcp` config schema lives at
[src/config.ts](../../../../src/config.ts#L137-L147). The `let`-binding
+ `registerBuiltinServices` push pattern is the canonical extension
point at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L43) and
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1080).

## 3. The McpRuntime.callTool error contract (new in r2)

The reviewer correctly observed that the round-1 plan misrepresented
how errors surface. Confirmed against the live runtime:

- Success path returns `result.content` **unwrapped** —
  [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L189).
- Error path throws `Error("Tool \"<name>\" on \"<svc>\" returned
  error: " + JSON.stringify(result.content))` —
  [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L190-L193).

Hence the existing happy-path assertion `.resolves.toEqual({ content:
"hello" })` at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L71-L72)
compares directly against `result.content` (the inner object), not
against the `{ content, isError }` envelope.

Implication for G31:

- Success envelopes: assert via `.resolves.toMatchObject({...})` on the
  inner-content shape.
- Error envelopes: assert via `.rejects.toThrow(/CODE/)` against the
  serialised `code` string embedded in the runtime's thrown error
  message. The structured `code` field is therefore visible to the
  agent even though the runtime throws — exactly the design intent.

## 4. Why a cap is still the right fix

Unchanged from r1 (see [01-analysis-r1.md §3](01-analysis-r1.md#L70)).
Auto-stashing or a new policy module is deferred to a future
dispatcher-level redesign, not slipped into a single builtin under
G31.

## 5. In/out of scope (unchanged)

In: `filesystem.read_file` schema, handler, error shape, config field,
regression tests, doc crumbs.

Out: auto-stash, other builtins (`write_file`, `list_dir`,
`search_files`, `fetch_url`, `download_file`), the repo-layout write
guard at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L281-L298), full
mime detection.

## 6. Sequencing constraints (refreshed)

- **G30 must land first.** Live source still has the sync imports at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26) and
  the sync `readFile` call at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278);
  G30 will rewrite both. G31 must edit the post-G30 async handler and
  reuse the `node:fs/promises` symbols G30 introduces, otherwise it
  would either re-introduce a sync call (G30 regression-guard ships
  `src/mcp/no-sync-fs.test.ts` per
  [../G30/APPROVED.md](../G30/APPROVED.md#L7)) or collide with G30 on
  identical line ranges. Anchors in this round-2 design and plan are
  the live pre-G30 line numbers; the plan's pre-flight step explicitly
  re-anchors after G30 lands.
- **G06 / G36 / G37**: disjoint subsystems; G31 needs no
  `noSyncFsScanner` config change.
- **G32 / G33 / G34 / G35**: same file, disjoint line ranges; any
  internal order is safe. Recommended commit order remains
  G30 → G31 → others.
- **F09 (landed)**: policy precedent only, no code coupling.

## 7. Issue reachability in practice (unchanged)

Agents running on the bind-mount daemons (`saivage` 10.0.3.111,
`diedrico` 10.0.3.113, `saivage-v3` 10.0.3.112 per
[../G30/APPROVED.md](../G30/APPROVED.md#L13)) routinely target
multi-MB lockfiles and result JSON under
`getrich/results/`. After G30 the event loop survives; after G31 the
heap survives too and the agent learns to use `run_command`
head/tail/grep or `search_files`.

## 8. Reviewer-driven design refinements that the design adopts

The round-1 reviewer
([04-review-r1.md](04-review-r1.md#L1-L80)) raised seven concrete
defects. The round-2 design and plan address each one; this section
records the analytic conclusion behind each adjustment.

1. **Byte-accounting.** `fileHandle.read(buffer, 0, toRead,
   effectiveOffset)` returns `{ bytesRead }` which can legitimately
   be smaller than `toRead` (concurrent truncation, short reads near
   EOF). Treating `toRead` as the result lies in the envelope and —
   more importantly — feeds zero-fill bytes from `Buffer.alloc` into
   the NUL probe, which would misclassify a perfectly normal text
   file as `BINARY_CONTENT` whenever the file was truncated mid-read.
   The correct envelope reports `length = bytesRead` and
   `truncated = (effectiveOffset + bytesRead) < (size at read time)`
   based on a stable `st.size` snapshot taken before the read.
2. **Test contract.** Per §3 above, error cases must assert
   `.rejects.toThrow(/CODE/)` against the serialised content, not
   `.resolves.toMatchObject`. The plan rewrites all error tests
   accordingly.
3. **Structured-error coverage.** Round-1's `parseNonNegativeInt`
   threw raw `Error`s outside the envelope. Round-2 keeps the helper
   throwing but wraps the schema-parameter parse in a `try/catch` at
   the top of the handler and converts thrown helper errors into a
   structured `INVALID_ARGUMENT` envelope. Every documented code
   (`FILE_TOO_LARGE`, `LENGTH_TOO_LARGE`, `INVALID_RANGE`,
   `BINARY_CONTENT`, `NOT_A_FILE`, `INVALID_ARGUMENT`) is then
   covered by at least one regression test.
4. **NUL-probe semantics.** The design now picks one rule
   unambiguously: **the probe always reads the file head at offset
   0** for `min(4 KiB, st.size)` bytes via a dedicated
   `fileHandle.read` call, independent of the requested window. A
   non-zero-offset window over a binary file therefore still returns
   `BINARY_CONTENT`. A regression test exercises that path.
5. **Offset-at-EOF.** Decision: `offset === st.size` is valid and
   returns an empty success envelope (`content: ""`, `length: 0`,
   `truncated: false`). Only `offset > st.size` returns
   `INVALID_RANGE`. The schema description and tests are aligned.
6. **Refreshed anchors.** Live anchors restated in §1 and §2 of this
   analysis: handler at L274-278, schema at L243-246, helper
   insertion target at L375 (`parseOptionalTimeoutMs`), register-time
   wiring at L1077, config schema at L137-147. The plan's pre-flight
   step requires re-anchoring after G30 lands because G30 will shift
   line numbers in the same regions.
7. **Verification checks.** Bogus exact-count grep dropped; replaced
   with targeted symbol-presence checks per code path.

## 9. Open questions resolved by the design round

- **Default cap.** 200 000 bytes (parity with `mcp.maxFetchChars`).
- **Error vs truncated success when no window is requested.** Hard
  error (`FILE_TOO_LARGE`) — re-issuing with an explicit window is
  the way to opt in to slicing. This keeps the agent's signal clean.
- **Binary-probe size.** Hard-coded 4 KiB; not config-exposed.
- **`truncated: true` next-offset hint.** Not added; the agent has
  `offset + length + size_bytes` and can compute it.
