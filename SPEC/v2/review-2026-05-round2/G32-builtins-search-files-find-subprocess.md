# G32 — `search_files` shells out to the POSIX `find` binary

**Subsystem**: mcp
**Category**: bad-design
**Severity**: medium
**Transversality**: local

## Summary

The `search_files` builtin executes `execFile("find", ...)` to walk the
target tree. This introduces a hidden hard dependency on the host's
POSIX `find` (specific flag set, behaviour, and exit-code conventions)
inside an otherwise pure Node.js handler. On non-POSIX hosts (Windows,
restricted containers, Nix-style sandboxes) the tool fails opaquely;
even on Linux a missing or stub `find` reduces every search to an
error string with no fallback.

## Evidence (with line-linked refs)

- External `find` subprocess invocation:
  [src/mcp/builtins.ts](src/mcp/builtins.ts#L313-L327).

## Why this matters

MCP builtins are meant to give Saivage a portable, in-process tool
surface. Reaching for a system binary for what is effectively
`readdir` + glob undermines that promise, makes test setups depend on
the host's `find`, and creates an attack surface (any user-controlled
glob is now a shell arg). It is also slower than a JS walk for typical
repository sizes because of the process-fork cost on every call.

## Rough remediation direction (one bullet "one conceptual level up")

- Replace the subprocess with a small async walker built on
  `node:fs/promises.opendir` plus a battle-tested glob matcher (or
  reuse the project's existing file-search helper if one exists),
  keeping the same tool input contract and adding the file-count cap
  used elsewhere in the file.

## Cross-links

- G30 (sync fs same handler).
- G31 (read_file size cap).
