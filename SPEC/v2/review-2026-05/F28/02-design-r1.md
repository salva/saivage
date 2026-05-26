# F28 — Design r1 — two ways to retire the dead MCP registry

## Proposal A — Focused fix: delete the persistence layer in place, keep the file as a type-only module

### Scope (files touched)

- [src/mcp/registry.ts](src/mcp/registry.ts) — gut: keep the `ServiceEntry` and `ToolEntry` interfaces (rewritten as plain TS interfaces, no Zod), drop every function and the `registrySchema`. Final file is ~25 lines.
- [src/mcp/runtime.ts](src/mcp/runtime.ts) — drop the `listRegisteredServices`, `updateServiceStatus`, `getService` imports ([src/mcp/runtime.ts](src/mcp/runtime.ts#L4-L7)); delete the file-backed-registry branches in `getAllTools` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L237-L246)) and `listAllToolsForApi` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L292-L302)); reshape `startService` to look up only `this.services` (in-memory) and throw a clearer error when missing ([src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110)); remove the four `updateServiceStatus(...)` calls ([src/mcp/runtime.ts](src/mcp/runtime.ts#L129), [#L132](src/mcp/runtime.ts#L132), [#L345](src/mcp/runtime.ts#L345), [#L365](src/mcp/runtime.ts#L365)).
- [src/mcp/index.ts](src/mcp/index.ts) — drop the four function re-exports; keep only the `ServiceEntry` / `ToolEntry` type re-exports.
- [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20) — replace step 7 with the actual mechanism (declare under `config.mcpServers`).
- [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L412), [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313), [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95) — strike registry-file references; replace the system-design diagram node.

### What gets added / removed

- **Removed:** `loadRegistry`, `saveRegistry`, `registryPath`, `listRegisteredServices`, `getService`, `registerService`, `unregisterService`, `updateServiceStatus`, `registrySchema`, `serviceEntrySchema`, `toolEntrySchema`, the `zod` import. The four registry-iteration branches in `runtime.ts`. The four `updateServiceStatus(...)` calls. The "not found in registry" error string. The `7. Register in ...` step in the SKILL.
- **Added:** Plain-interface re-statements of `ServiceEntry` and `ToolEntry` in [src/mcp/registry.ts](src/mcp/registry.ts) (renamed for clarity, see Proposal B for the level-up). A new error string in [src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110) along the lines of `Service "${name}" is not running; declare it under config.mcpServers with autostart: true`.

### Risk

- Low. The deleted exports have zero non-self callers. The runtime branches iterate an empty array today; removing them only changes behaviour if a user had populated `.saivage/registry.json` by hand — but there is no documented way to do so and the file is not created automatically.
- One subtle behaviour change: `startService` previously threw `not found in registry` when an external server name was unknown ([src/mcp/runtime.ts](src/mcp/runtime.ts#L108)). With this change the same throw fires from the `this.services` lookup miss. The error message changes; any test or log scraper matching the old phrasing must be updated. Grep on `src/`, `tests/`, `web/` for `not found in registry` shows only the throw itself, so no consumer is affected.
- Schema removal: nothing reads `.saivage/registry.json`, so removing the Zod parse cannot break a live read path. Existing `.saivage/registry.json` files on disk (none in the in-tree fixtures; not created by the tool) are simply ignored.

### What it enables

- Aligns with F12's approved direction of pushing MCP-related knobs into config rather than file-backed state ([SPEC/v2/review-2026-05/F12/APPROVED.md](SPEC/v2/review-2026-05/F12/APPROVED.md)). After F28-A, `config.mcpServers` is the sole declaration site for external MCP servers; F12 can freely add `runtime.shellTimeoutMs` without arbitration against a phantom registry.
- Closes [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95)'s "largely vestigial" note.

### What it forbids

- No new feature that re-introduces JSON-backed MCP discovery without a written spec. The "generated" `origin` value ([src/mcp/registry.ts](src/mcp/registry.ts#L17)) is the surviving remnant of a v1 MCP-generator feature that is not present in v2; this proposal also drops the `origin: "generated"` literal from `ServiceEntry` (only `"builtin"` and `"external"` remain meaningful).

### Recommendation note

Smallest possible diff. Leaves the file name `registry.ts` mildly misleading (it no longer registers anything) and keeps the import paths everywhere unchanged. Suitable if reviewer concern is minimising diff surface.

## Proposal B — Level up: delete `registry.ts`, move the surviving types to `src/mcp/types.ts`

### Scope (files touched)

Everything in Proposal A's scope, plus:

- **New file** [src/mcp/types.ts](src/mcp/types.ts) (new) — holds the `ServiceEntry` and `ToolEntry` interfaces. Plain TypeScript, no Zod.
- **Deleted file** [src/mcp/registry.ts](src/mcp/registry.ts).
- **Updated imports** in every live consumer of the types:
  - [src/mcp/client.ts](src/mcp/client.ts#L3): `from "./registry.js"` → `from "./types.js"`.
  - [src/mcp/runtime.ts](src/mcp/runtime.ts#L2): same.
  - [src/mcp/builtins.ts](src/mcp/builtins.ts#L11): same.
  - [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L7): same.
  - [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L17): same.
  - [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L11): same.
  - [src/server/bootstrap.ts](src/server/bootstrap.ts#L37): same.
  - [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts#L3): same.
  - [src/mcp/toolContext.test.ts](src/mcp/toolContext.test.ts#L18): same.
- **Updated** [src/mcp/index.ts](src/mcp/index.ts#L3-L11): re-export `ServiceEntry`, `ToolEntry` from `./types.js`; remove the four function re-exports outright.
- **Updated** [typedoc.json](typedoc.json#L17): replace `src/mcp/registry.ts` with `src/mcp/types.ts`.
- **Updated** docs (same set as Proposal A): [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20), [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L412), [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313), [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95).

### What gets added / removed

- **Removed:** Everything Proposal A removes, plus the file `registry.ts` itself, plus its TypeDoc page.
- **Added:** [src/mcp/types.ts](src/mcp/types.ts) — `ServiceEntry` and `ToolEntry` as interfaces (plain TS, no Zod). The `origin` union narrows from `"builtin" | "generated" | "external"` to `"builtin" | "external"` (the `"generated"` value has no producer in v2 — see [src/mcp/registry.ts](src/mcp/registry.ts#L17) for the existing literal). `transport` keeps `"stdio" | "sse"`. `status` is dropped (no consumer remains after the `updateServiceStatus` deletion).

### Risk

- Marginally higher than A because nine `import type` lines change. All are `import type` (verified above) so there is no runtime impact and TS catches every stale path at compile time.
- The renamed `types.ts` collides conceptually with nothing else in `src/mcp/` (the existing [src/mcp/toolContext.ts](src/mcp/toolContext.ts) is the call-context shape, not the service shape).
- Removing the `status` field is a breaking change to the in-memory `ServiceEntry` shape. The only constructor of `ServiceEntry` outside the now-deleted helpers is the literal in [src/server/bootstrap.ts](src/server/bootstrap.ts#L713-L731), which sets `status: "active"`. Drop that key in the same edit.

### What it enables

- Same as A, plus: the misleading file name goes away. A future contributor opening `src/mcp/` no longer sees a `registry.ts` that doesn't register anything; the `types.ts` name truthfully describes the file's purpose.
- The TypeDoc-generated docs no longer list the dead `registerService` / `unregisterService` / `listRegisteredServices` / `updateServiceStatus` / `getService` pages.

### What it forbids

- Same as A — no re-introduction of file-backed MCP discovery without spec.
- Additionally: forbids re-importing `from "./registry.js"`. The path is gone; any future code that tries to revive registry semantics has to start from a fresh spec.

### Recommendation note

This is the cleaner endpoint and the one that matches the project guideline "remove dead code, do not preserve it" (project guideline #2). The diff is a few extra path-rename hunks, all mechanical, all caught by `tsc`.

## Recommendation

**Proposal B.** Both proposals delete the same dead code; B additionally removes the misleading filename and the stale TypeDoc entry points. Per the architecture-first guideline, the cost of renaming a handful of `import type` paths is paid in this commit rather than left as latent confusion. F28's evidence is precisely that a name implies a contract that does not exist; the cure is to remove both the contract AND the name.

The diff is mechanical (`tsc` will flag every stale `from "./registry.js"` import path), so the additional surface relative to A carries no semantic risk.

Recommended ordering vs other Fxx:

- **No dependency on F11** ([SPEC/v2/review-2026-05/F11/APPROVED.md](SPEC/v2/review-2026-05/F11/APPROVED.md)). F11 hoists constants into `SaivageConfig`; it does not touch registry helpers. F28 and F11 can land in either order.
- **No dependency on F12** ([SPEC/v2/review-2026-05/F12/APPROVED.md](SPEC/v2/review-2026-05/F12/APPROVED.md)). F12 reshapes `registerBuiltinServices` and adds a closure-local shell-timeout cap; it does not import any registry helper. If F28 lands first, F12 rebases trivially. If F12 lands first, F28's runtime.ts deletions sit in different methods (`getAllTools` / `listAllToolsForApi` / `startService`) than F12's edits (`callTool` shell-handler closure).
- **No interaction with F25** (prompt-injection cop) or other in-flight reviews surveyed.
