# G31 — Analysis r1

**Finding**: [../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md)

**Subsystem**: mcp / filesystem builtin

## 1. What the code actually does today

The `filesystem.read_file` tool handler is the unconditional one-shot
slurp described in the finding, located at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278):

```ts
case "read_file": {
  const fp = resolvePath(args.path as string);
  const content = readFileSync(fp, "utf-8");
  return { content: { content }, isError: false };
}
```

The tool schema declared at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L243-L246)
accepts only `{ path: string }`. There is no `offset`, no `length`, no
encoding selector, no truncation flag, and no client-controlled cap.

The handler has three concrete failure modes today:

1. **Heap blow-up on large artefacts.** A 500 MB log or dependency
   lockfile is loaded as a single Node string. With a 2× transient
   factor for UTF-8 decoding plus the JSON-stringified envelope the
   dispatcher produces at
   [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L194-L196),
   one call can comfortably allocate >1 GiB. The MCP runtime has no
   per-call memory budget.
2. **Event-loop stall.** `readFileSync` is the same sync-fs pattern
   G30 has just removed from the rest of the filesystem handler
   (after-G30 the line becomes `await readFile(fp, "utf-8")`; see
   [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L46-L50)). Even on the
   async version the handler still buffers the whole file; the
   event-loop stall is replaced by an unbounded heap allocation. G30
   does **not** address the size cap on its own.
3. **Token waste / silent truncation downstream.** Even when the
   process survives the read, the model receives a payload it cannot
   meaningfully consume; the LLM provider then either rejects the
   request or truncates it client-side, costing one round trip per
   oversized read. The compaction pipeline at
   [src/runtime/compaction.ts](../../../../src/runtime/compaction.ts)
   only kicks in *after* the oversized tool result has already been
   pushed into the conversation transcript.

## 2. Pattern in sibling builtins

Every other builtin in this file enforces an explicit cap, and each
cap is declared at the module top, fed from `SaivageConfig.mcp` inside
`registerBuiltinServices`:

| Tool | Module cap | Config field | Reference |
|------|-----------|--------------|-----------|
| `run_command` (stdout/stderr tail) | `MAX_OUTPUT` (100 KiB default) | `mcp.maxOutputBytes` | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L528-L533) |
| `fetch_url` / `fetch_page_text` | `MAX_FETCH_CHARS` (200 000 default) | `mcp.maxFetchChars` | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L764-L770) |
| `download_file` / `download_with_fallbacks` | `MAX_DOWNLOAD_BYTES` (250 MiB default) | `mcp.maxDownloadBytes` | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L43), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1080) |
| `search_files` | shells out with `maxBuffer: MAX_OUTPUT` | reuses `mcp.maxOutputBytes` | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L321) |
| `read_file` | **none** | **none** | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L278) |

The `mcp` config schema lives at
[src/config.ts](../../../../src/config.ts#L137-L147) and is loaded
once at bootstrap. The constants are pushed into `let`-bound
module-level variables inside
`registerBuiltinServices`
([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1073-L1080)),
which is the canonical place to add a new cap.

## 3. Why a cap is the right fix (and not auto-stash by default)

The `runtime/stash` helper at
[src/runtime/stash.ts](../../../../src/runtime/stash.ts#L23-L30)
exists precisely to keep oversize tool output out of the context
window — but it is currently invoked manually by callers, not
auto-attached in the dispatcher
([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L138-L196)).
A `read_file` that silently auto-stashes on overflow would:

- Mask the real signal that the agent picked the wrong tool (it
  should be using `run_command` with `head`/`tail` for log triage or
  `search_files` for grep-style scans), and
- Couple `read_file` to the stash subsystem without addressing the
  underlying allocation problem (auto-stash still needs a cap on how
  much it is willing to stream into the stash file).

Rough remediation in the finding
([../G31-builtins-read-file-no-size-cap.md](../G31-builtins-read-file-no-size-cap.md))
points at the same place: a config-driven `mcp.maxFileReadBytes` plus
optional `offset` / `length`. That matches the sibling pattern and is
what this analysis recommends as the design baseline.

## 4. What is in scope vs out of scope for G31

In scope:

- `filesystem.read_file` only — schema, handler, error shape, config
  field, regression tests.
- Reuse of the existing `mcpConfig.*` plumbing in
  `registerBuiltinServices` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1073-L1080)).
- Documentation crumbs in [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
  and [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md) (only the
  table row for `read_file`).

Out of scope (explicitly):

- Auto-stash wiring (G31 leaves the stash subsystem untouched).
- Round-2 changes to `write_file`, `list_dir`, `search_files`,
  `fetch_url`, `download_file` — owned by G30 / G32 / G34.
- The repo-layout write-guard at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L281-L298)
  (G31 only touches reads).
- Binary-content auto-detection beyond a single fast null-byte head
  check; full mime detection is out of scope.

## 5. Sequencing constraints

- **G30 (APPROVED, not yet landed in `src/`):** G30 rewrites the
  `node:fs` import block at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L15-L26)
  and converts the `read_file` body to
  `await readFile(fp, "utf-8")` per
  [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L46-L50). G31 must land
  **after G30** so it edits the async handler and reuses the
  already-imported `readFile`, `stat`, and `open` from
  `node:fs/promises`. Otherwise G31 would either re-introduce
  `readFileSync` (banned by the G30 regression guard
  `src/testing/noSyncFsScanner.ts` and `src/mcp/no-sync-fs.test.ts`
  per [../G30/APPROVED.md](../G30/APPROVED.md)) or fight G30 on
  identical line ranges. No new shared helper is needed.
- **G06 / G36 / G37:** No shared module overlap. They consume the
  same `noSyncFsScanner` produced by G30 for *their own*
  subdirectories ([../G36/03-plan-r3.md](../G36/03-plan-r3.md#L293)),
  but G31 lives entirely inside `src/mcp/builtins.ts`, which G30 owns
  for the round-2 scanner allow-list. G31 needs no scanner-config
  change.
- **G32 (search_files subprocess) / G33 (web_search regex) / G34
  (fetch_url streaming cap) / G35 (env regex):** Same file, disjoint
  line ranges. G31 only edits lines around L243-L278 (schema +
  read_file case) and adds a `let MAX_FILE_READ_BYTES = ...` near the
  existing `let MAX_OUTPUT = ...` block at L39-L43 and the
  `mcpConfig.*` push at L1077-L1080. G34 will independently add a
  streaming reader, but the `mcp.maxDownloadBytes` cap it consumes
  already exists; G31 introduces a new config field that G34 does not
  use. Either order works; recommend G31 lands first because it is
  smaller and unblocks the same agent feedback loop on the most-used
  builtin.
- **F09 (round 1, landed):** F09 established the worker-side
  task-report size discipline; G31 is the tool-side analogue of the
  same principle (`do not let tool results exceed the bound the
  agent's context can absorb`). No code dependency — citation only.

## 6. Evidence the issue is reachable in practice

- Agents inside `saivage-v3-getrich-v2` regularly call `read_file` on
  multi-megabyte training logs and dependency lockfiles
  (`package-lock.json`, `getrich/results/*.json`,
  `getrich/data/**/*.csv`). With G30 landed the handler will no
  longer stall the event loop, but the heap allocation pattern
  remains.
- The shell-output truncation guard at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L528-L535)
  is the symmetric precedent for "return a tail and tell the agent
  where the full content lives"; agents already understand this
  shape, so introducing the same convention on `read_file` does not
  require a new agent contract.

## 7. Open questions resolved by the design round

- **Default cap value.** Section 2 of the design proposes 200_000
  bytes (parity with `mcp.maxFetchChars`) — same order of magnitude
  as a typical LLM tool-result budget; large enough to fit most
  hand-edited source files; small enough that an unconstrained read
  on a generated artefact fails fast and obviously.
- **Error vs truncated success.** Section 3 of the design selects
  *error*: returning a truncated body silently would let agents
  consume the prefix and miss the rest; the finding's "point the
  agent at search_files / head / tail" guidance is only effective if
  the agent gets an explicit failure with the suggested next step.
  An explicit `offset` + `length` lets the agent opt into a slice
  when it really does want a window.
