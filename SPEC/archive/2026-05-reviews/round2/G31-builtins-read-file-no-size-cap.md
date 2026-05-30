# G31 — `read_file` builtin slurps entire files with no size or chunk cap

**Subsystem**: mcp
**Category**: short-sighted
**Severity**: medium
**Transversality**: local

## Summary

The MCP `read_file` tool reads the entire target file as a UTF-8 string
in one call, with no maximum-size guard, no streaming/tail support, and
no error path for binary content. Adjacent builtins (`fetch_url`,
`run_command`, shell log readers) all enforce caps via
`mcpConfig.maxFetchChars`, `MAX_DOWNLOAD_BYTES`, and `MAX_OUTPUT`, so
the absence on `read_file` is a glaring inconsistency rather than an
oversight elsewhere.

## Evidence (with line-linked refs)

- Unconditional `readFile(path, "utf-8")` in the filesystem handler:
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L257-L260).
- Comparable caps on neighbouring handlers:
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L764-L770) (fetch),
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L528-L533) (shell log tail).

## Why this matters

Agents routinely target generated logs, dependency lockfiles, or other
multi-megabyte artefacts. A single such call inflates Node's heap by
the full file size, blocks the event loop (G30), and returns a payload
the LLM cannot meaningfully consume. The result is wasted tokens,
occasional OOMs, and unpredictable latency on what should be a cheap
tool.

## Rough remediation direction (one bullet "one conceptual level up")

- Add a config-driven `mcp.maxFileReadBytes` cap mirroring
  `maxOutputBytes` and `maxFetchChars`; expose optional `offset` and
  `length` parameters in the tool schema and refuse to serve files
  beyond the cap, pointing the agent at the existing `search_files` or
  shell `head`/`tail` paths.

## Cross-links

- G30 (sync fs in same handler).
- Round 1: F09 (tool result size budget).
