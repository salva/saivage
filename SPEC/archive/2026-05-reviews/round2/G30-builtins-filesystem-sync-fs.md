# G30 — MCP `filesystem` builtin still uses blocking sync fs (regression class of F22)

**Subsystem**: mcp
**Category**: bad-design
**Severity**: high
**Transversality**: module

## Summary

`src/mcp/builtins.ts` imports `readFileSync`, `writeFileSync`,
`readdirSync`, and `statSync` from `node:fs` and uses them inside the
in-process MCP filesystem handler. Every `read_file`, `write_file`, and
`list_files` tool call therefore blocks the Node event loop for the
duration of the disk operation. F22 already migrated `store/documents.ts`
to `fs/promises`; the same audit was never applied to the builtin
filesystem handler, leaving the most-frequently-invoked tool surface
synchronous.

## Evidence (with line-linked refs)

- Sync imports at the top of the file:
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L18-L26).
- Sync `readFileSync`/`statSync`/`readdirSync` inside the handler:
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L255-L320).

## Why this matters

The filesystem handler runs in the same Node process as the chat
server, the planner, the supervisor, and the MCP runtime. A long
`read_file` on a large repository stalls health-checks, idle-shutdown
timers, and any concurrent tool calls. Because the same kind of bug
already shipped a fix once (F22), letting a sibling subsystem keep the
old pattern is the textbook definition of a regression class.

## Rough remediation direction (one bullet "one conceptual level up")

- Replace the sync calls with their `node:fs/promises` equivalents and
  add a lint or unit-test guard that fails the build if any file under
  `src/mcp/` imports from `node:fs` (rather than `node:fs/promises`),
  so future drift is caught at CI time.

## Cross-links

- Round 1: F22 (store/documents async migration).
- G35 (auth store sync fs), G36 (config sync fs) — same class.
- G31, G32, G33 (other builtin handler issues).
