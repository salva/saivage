# G30 — APPROVED

**Chosen proposal**: Design A (per [02-design-r2.md](02-design-r2.md)) — in-place `fs/promises` migration in `src/mcp/builtins.ts`. Adds a `settled`/`closed` flag for `runShellCommand` to prevent post-close timer races. `await mkdir(...)` hoisted before the `Promise` constructor.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All 3 r1 changes addressed.

**Shared infrastructure produced**: `src/testing/noSyncFsScanner.ts` (dependency-free, accepts `roots`/`allowedNamedImports`/`skipPathContains`) — reused verbatim by G06, G36, G37.

**Audit table** in [02-design-r2.md](02-design-r2.md): every non-test `node:fs` user in `src/` classified as covered / F22 carve-out / still-unowned.

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount. `saivage-v3-getrich-v2` unaffected.
