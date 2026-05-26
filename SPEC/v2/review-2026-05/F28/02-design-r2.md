# F28 — Design r2 — two ways to retire the MCP registry

## Changes from r1

- Rewrote the Risk section of both proposals to reflect r2's analysis: the registry reader paths in `startService`, `getAllTools`, and `listAllToolsForApi` **are** live, and deletion intentionally removes the documented manual `.saivage/registry.json` configuration surface. The "nothing reads it" framing is gone.
- Made the behavioural-change statement explicit: any project that previously relied on a hand-edited registry file will lose its declared services after this change. `config.mcpServers` becomes the sole declaration path.
- Kept "Proposal B" as the recommendation, with the rationale unchanged: same deletion, additionally removes the misleading `registry.ts` filename and the stale TypeDoc surface.

## Proposal A — Focused fix: delete the persistence layer in place, keep the file as a type-only module

### Scope (files touched)

- [src/mcp/registry.ts](src/mcp/registry.ts) — gut: keep the `ServiceEntry` and `ToolEntry` interfaces (rewritten as plain TS interfaces, no Zod), drop every function and the `registrySchema`. Final file is ~25 lines.
- [src/mcp/runtime.ts](src/mcp/runtime.ts) — drop the `listRegisteredServices`, `updateServiceStatus`, `getService` imports ([src/mcp/runtime.ts](src/mcp/runtime.ts#L4-L7)); delete the registry-iteration branches in `getAllTools` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L237-L246)) and `listAllToolsForApi` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L292-L302)); reshape `startService` to look up only `this.services` (in-memory) and throw a clearer error when missing ([src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110)); remove the four `updateServiceStatus(...)` calls ([src/mcp/runtime.ts](src/mcp/runtime.ts#L129), [#L132](src/mcp/runtime.ts#L132), [#L345](src/mcp/runtime.ts#L345), [#L365](src/mcp/runtime.ts#L365)).
- [src/mcp/index.ts](src/mcp/index.ts) — drop the four function re-exports; keep only the `ServiceEntry` / `ToolEntry` type re-exports.
- [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20) — replace step 7 with the actual mechanism (declare under `config.mcpServers`).
- [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L410-L414), [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313), [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95) — strike registry-file references; replace the system-design diagram node.

### What gets added / removed

- **Removed:** `loadRegistry`, `saveRegistry`, `registryPath`, `listRegisteredServices`, `getService`, `registerService`, `unregisterService`, `updateServiceStatus`, `registrySchema`, `serviceEntrySchema`, `toolEntrySchema`, the `zod` import. The two registry-iteration branches in `runtime.ts` (`getAllTools` and `listAllToolsForApi`). The four `updateServiceStatus(...)` calls. The "not found in registry" error string. The `7. Register in ...` step in the SKILL.
- **Added:** Plain-interface re-statements of `ServiceEntry` and `ToolEntry` in [src/mcp/registry.ts](src/mcp/registry.ts) (renamed to a clearer filename in Proposal B). A new error string in `startService`'s missing-service branch along the lines of `MCP service "${name}" is not running; declare it under config.mcpServers with autostart: true`.

### Risk

- **Intentional behavioural change.** Three live read paths today consult `.saivage/registry.json`: lazy-start in `startService` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110)), catalog assembly in `getAllTools` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L237-L246)), and the API projection in `listAllToolsForApi` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L292-L302)). Those catalogs flow to [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L167), [src/agents/base.ts](src/agents/base.ts#L598), and [src/server/server.ts](src/server/server.ts#L243). After this change a hand-edited `.saivage/registry.json` is ignored; any service it previously declared must be re-declared under `config.mcpServers`. This is the no-backward-compatibility choice required by project guideline #1 — explicit removal of the stale documented manual path.
- **Producer side is genuinely dead.** `registerService` and `unregisterService` have zero callers in `src/`, `tests/`, or `web/`, and bootstrap creates `ServiceEntry` literals directly from `config.mcpServers` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L738)) without touching the registry helpers. Deleting them removes only unreferenced functions.
- **`updateServiceStatus` callers.** Today the four call sites mutate the file only when a hand-populated entry exists; with no producer they are normally no-ops. Removing the callers and the helper together is one self-consistent edit.
- **`startService` error message.** The throw changes from `Service "${name}" not found in registry` to one that names `config.mcpServers`. Grep on `src/`, `tests/`, `web/` for `not found in registry` shows only the throw itself, so no log scraper or test assertion is affected.

### What it enables

- Aligns with F12's direction of pushing MCP knobs into config rather than file-backed state ([SPEC/v2/review-2026-05/F12/APPROVED.md](SPEC/v2/review-2026-05/F12/APPROVED.md)). After F28-A, `config.mcpServers` is the sole declaration site for external MCP servers; F12 can freely add `runtime.shellTimeoutMs` without arbitration against a phantom registry.
- Closes [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95)'s "largely vestigial" note.

### What it forbids

- No new feature that re-introduces JSON-backed MCP discovery without a written spec.
- The `origin: "generated"` value ([src/mcp/registry.ts](src/mcp/registry.ts#L17)) — surviving remnant of a v1 MCP-generator feature that is not in v2 — is dropped from `ServiceEntry` (only `"builtin"` and `"external"` remain meaningful).

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
- **Updated** docs (same set as Proposal A): [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20), [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L410-L414), [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313), [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95).

### What gets added / removed

- **Removed:** Everything Proposal A removes, plus the file `registry.ts` itself, plus its TypeDoc page.
- **Added:** [src/mcp/types.ts](src/mcp/types.ts) — `ServiceEntry` and `ToolEntry` as interfaces (plain TS, no Zod). The `origin` union narrows from `"builtin" | "generated" | "external"` to `"builtin" | "external"` (the `"generated"` value has no producer in v2). `transport` keeps `"stdio" | "sse"`. `status` is dropped (no consumer remains after the `updateServiceStatus` deletion).

### Risk

- **Same intentional behavioural change as Proposal A.** Deleting [src/mcp/registry.ts](src/mcp/registry.ts) intentionally removes the documented manual `.saivage/registry.json` declaration path that the runtime currently consumes via `startService` / `getAllTools` / `listAllToolsForApi` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110), [src/mcp/runtime.ts](src/mcp/runtime.ts#L237-L246), [src/mcp/runtime.ts](src/mcp/runtime.ts#L292-L302)) and that the docs at [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20) and [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L410-L414) still steer authors towards. After the change, `config.mcpServers` is the only declaration surface; any project that previously relied on a hand-edited registry file must migrate its entries to the config. This is the architecture-first removal required by guideline #1.
- **Import-path churn.** Nine `import type` lines change. All are `import type` (verified) so there is no runtime impact and TS catches every stale path at compile time.
- **Filename collision.** The renamed `types.ts` collides conceptually with nothing else in `src/mcp/` ([src/mcp/toolContext.ts](src/mcp/toolContext.ts) is the call-context shape, not the service shape).
- **`status` field removal.** Breaking change to the in-memory `ServiceEntry` shape. The only constructor of `ServiceEntry` outside the now-deleted helpers is the literal in [src/server/bootstrap.ts](src/server/bootstrap.ts#L713-L731), which sets `status: "active"`. Drop that key in the same edit.

### What it enables

- Same as A, plus: the misleading file name goes away. A future contributor opening `src/mcp/` no longer sees a `registry.ts` that doesn't register anything; the `types.ts` name truthfully describes the file's purpose.
- The TypeDoc-generated docs no longer list the dead `registerService` / `unregisterService` / `listRegisteredServices` / `updateServiceStatus` / `getService` pages.

### What it forbids

- Same as A — no re-introduction of file-backed MCP discovery without spec.
- Additionally: forbids re-importing `from "./registry.js"`. The path is gone; any future code that tries to revive registry semantics has to start from a fresh spec.

### Recommendation note

This is the cleaner endpoint and the one that matches the project guideline "remove dead code, do not preserve it" (project guideline #2). The diff is a few extra path-rename hunks, all mechanical, all caught by `tsc`.

## Recommendation

**Proposal B.** Both proposals execute the same intentional removal of the documented manual registry path; B additionally removes the misleading filename and the stale TypeDoc entry. Per the architecture-first guideline, the cost of renaming a handful of `import type` paths is paid in this commit rather than left as latent confusion. F28's evidence is precisely that the name `registry.ts` implies a configuration surface v2 no longer wants to support; the cure is to remove both the configuration surface AND the name.

The diff is mechanical (`tsc` will flag every stale `from "./registry.js"` import path), so the additional surface relative to A carries no semantic risk.

Recommended ordering vs other Fxx:

- **No dependency on F11** ([SPEC/v2/review-2026-05/F11/APPROVED.md](SPEC/v2/review-2026-05/F11/APPROVED.md)). F11 hoists constants into `SaivageConfig`; it does not touch registry helpers. F28 and F11 can land in either order.
- **No dependency on F12** ([SPEC/v2/review-2026-05/F12/APPROVED.md](SPEC/v2/review-2026-05/F12/APPROVED.md)). F12 reshapes `registerBuiltinServices` and adds a closure-local shell-timeout cap; it does not import any registry helper. If F28 lands first, F12 rebases trivially. If F12 lands first, F28's runtime.ts deletions sit in different methods (`getAllTools` / `listAllToolsForApi` / `startService` / `startFromEntry` / `restartService`) than F12's edits (`callTool` shell-handler closure).
- **No interaction with F25** (prompt-injection cop) or other in-flight reviews surveyed.
