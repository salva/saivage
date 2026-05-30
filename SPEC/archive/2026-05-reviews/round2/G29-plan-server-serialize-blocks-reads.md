# G29 — `serializeOp` queues read-only tool calls behind every writer

**Subsystem**: mcp
**Category**: bad-design
**Severity**: low
**Transversality**: module

## Summary

The plan-server funnels every plan tool call through a single
`serializeOp` chain so that writes are mutually exclusive. The same
queue, however, is used for read-only tools (`plan_get`,
`plan_history_get`, `plan_get_current_stage`). A long write therefore
blocks every concurrent read on the same in-process server, which
defeats the purpose of the in-memory cache added in F34.

## Evidence (with line-linked refs)

- `serializeOp` chain used for all handlers, including reads:
  [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L347-L357).
- Read tool registrations going through the same chain:
  [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L380-L460).

## Why this matters

When the supervisor or chat triggers a read during a slow write (e.g.
the cross-document completion path above) the read times out at the
MCP layer even though the cached value is immediately available. The
serial queue is also an unnecessary correctness crutch — JS is
single-threaded, so reads against the in-memory cache need no locking
at all.

## Rough remediation direction (one bullet "one conceptual level up")

- Split the gate into a single-writer / many-reader pattern: keep
  `serializeOp` for tools tagged as mutating, and have read tools
  return directly from the cache without joining the write queue.

## Cross-links

- G27, G28 (same file).
- Round 1: F34 (plan-server cache).
