# F28 — Plan r2 — implementation steps for Proposal B

For the recommended proposal only (delete `src/mcp/registry.ts`, move types to `src/mcp/types.ts`).

## Changes from r1

- The pinned `startService` error test (previously listed as optional) is now **required**, per reviewer point 3. The deletion removes a live read path, so the replacement error message gets a focused assertion rather than relying only on `tsc`.
- Replaced the non-executable `grep` over `tests/` with one that matches this repo's co-located test layout and covers the docs that F28 plans to update (reviewer point 4).
- No edit-step changes: the surgery on [src/mcp/runtime.ts](src/mcp/runtime.ts), [src/mcp/index.ts](src/mcp/index.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), [typedoc.json](typedoc.json), and the four doc files is identical to r1.

## Ordered edit steps

1. **Create** [src/mcp/types.ts](src/mcp/types.ts) with two interfaces, no Zod:
   ```ts
   export interface ToolEntry {
     name: string;
     description: string;
     inputSchema: Record<string, unknown>;
   }

   export interface ServiceEntry {
     name: string;
     version: string;
     origin: "builtin" | "external";
     command: string;
     args: string[];
     env: Record<string, string>;
     transport: "stdio" | "sse";
     tools: ToolEntry[];
     capabilities: string[];
     createdAt: string;
   }
   ```
   Note: the `status` field and the `"generated"` origin variant are dropped (no remaining producer or consumer — see [SPEC/v2/review-2026-05/F28/01-analysis-r2.md](SPEC/v2/review-2026-05/F28/01-analysis-r2.md)).

2. **Rewrite imports** in nine files (one mechanical substitution: `from "./registry.js"` → `from "./types.js"`; for `src/server/bootstrap.ts` it is `from "../mcp/registry.js"` → `from "../mcp/types.js"`):
   - [src/mcp/client.ts](src/mcp/client.ts#L3)
   - [src/mcp/runtime.ts](src/mcp/runtime.ts#L2) — keep the `import type { ServiceEntry, ToolEntry }` line; **delete** the second import (`listRegisteredServices, updateServiceStatus, getService` at [src/mcp/runtime.ts](src/mcp/runtime.ts#L4-L7)) entirely.
   - [src/mcp/builtins.ts](src/mcp/builtins.ts#L11)
   - [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L7)
   - [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L17)
   - [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L11)
   - [src/server/bootstrap.ts](src/server/bootstrap.ts#L37)
   - [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts#L3)
   - [src/mcp/toolContext.test.ts](src/mcp/toolContext.test.ts#L18)

3. **Surgery on [src/mcp/runtime.ts](src/mcp/runtime.ts):**
   1. **`startService(name)` body** ([src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110)): remove the `getService(name)` lookup and the `this.startFromEntry(entry)` fallback. Replace with a throw that names the actual configuration surface. The full new body:
      ```ts
      async startService(name: string): Promise<McpClient> {
        this.assertNotCoolingDown(name);
        const existing = this.services.get(name);
        if (existing?.client.connected) {
          existing.idleSince = null;
          return existing.client;
        }
        throw new Error(
          `MCP service "${name}" is not running; declare it under config.mcpServers with autostart: true`,
        );
      }
      ```
   2. **`startFromEntry`** ([src/mcp/runtime.ts](src/mcp/runtime.ts#L113-L135)): remove the two `updateServiceStatus(entry.name, "active" | "error")` calls ([src/mcp/runtime.ts](src/mcp/runtime.ts#L129), [#L132](src/mcp/runtime.ts#L132)). The surrounding `try` / `catch` keeps recording crashes via `recordExternalFailure`.
   3. **`restartService`** ([src/mcp/runtime.ts](src/mcp/runtime.ts#L334-L370)): remove both `updateServiceStatus(name, "error")` calls ([src/mcp/runtime.ts](src/mcp/runtime.ts#L345), [#L365](src/mcp/runtime.ts#L365)).
   4. **`getAllTools`** ([src/mcp/runtime.ts](src/mcp/runtime.ts#L216-L247)): delete the `// Second: tools from registry for services not yet started` block ([src/mcp/runtime.ts](src/mcp/runtime.ts#L237-L246)) — both the comment and the `for (const entry of listRegisteredServices())` loop. Update the surviving doc comment at [src/mcp/runtime.ts](src/mcp/runtime.ts#L216) from `(in-process + running + registry)` to `(in-process + running)`.
   5. **`listAllToolsForApi`** ([src/mcp/runtime.ts](src/mcp/runtime.ts#L249-L307)): delete the trailing `for (const entry of listRegisteredServices())` block ([src/mcp/runtime.ts](src/mcp/runtime.ts#L292-L302)).
4. **Update [src/mcp/index.ts](src/mcp/index.ts):**
   ```ts
   export { McpClient, type McpToolCallResult } from "./client.js";
   export { McpRuntime } from "./runtime.js";
   export type { ServiceEntry, ToolEntry } from "./types.js";
   export { registerBuiltinServices } from "./builtins.js";
   ```
   The four function exports (`listRegisteredServices`, `getService`, `registerService`, `unregisterService`, `updateServiceStatus`) are removed.
5. **Update [src/server/bootstrap.ts](src/server/bootstrap.ts#L713-L731):** in the literal that constructs the `ServiceEntry` for each `config.mcpServers` entry, drop the `status: "active"` line. The field no longer exists on `ServiceEntry`.
6. **Delete the file** `src/mcp/registry.ts`.
7. **Update [typedoc.json](typedoc.json#L17):** replace `"src/mcp/registry.ts"` with `"src/mcp/types.ts"`.
8. **Update [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20):** rewrite step 7 to read:
   `7. Declare the service in your project's .saivage/saivage.json under "mcpServers" with command, args, env, and autostart: true.`
9. **Update SPEC of record:**
   - [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L410-L414): strike the paragraph that references `.saivage/registry.json` as a persisted-state file for `origin: "generated"` entries; the v1 MCP-generator feature is not present in v2.
   - [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313): remove the `REG["registry.json"]` node from the Mermaid block and any edges into it.
   - [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95): replace the `src/mcp/registry.ts — ...` row with a row pointing to `src/mcp/types.ts — service & tool entry shapes (no persistence)`.

## Test strategy

### Existing tests that must keep passing

- [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts#L21-L60) — exercises `startFromEntry` cooldown behaviour. After the edit, the `ServiceEntry` literal at [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts#L6-L19) must drop the `status` field. No other change. The import path changes per step 2.
- [src/mcp/runtime.api.test.ts](src/mcp/runtime.api.test.ts) — covers `listAllToolsForApi`. With the registry-iteration branch removed, the only remaining contributors are in-process and running services; existing assertions about in-process/legacy stubs should still hold because they never exercised the registry branch. Re-run to confirm.
- [src/mcp/toolContext.test.ts](src/mcp/toolContext.test.ts) — imports only the `ToolEntry` type; the rename in step 2 is the only change.
- [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) — does not touch registry symbols; no edit.
- The whole `src/mcp/` test suite must pass.

### Required new test

The deletion replaces the live `startService` registry-lookup branch with a config-pointing throw. That replacement behaviour is pinned by an explicit assertion in [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts):

```ts
it("throws a config-pointing error when a service is not registered or running", async () => {
  const runtime = new McpRuntime({
    restartOnCrash: false,
    continuousImprovement: false,
    healthCheckIntervalMs: 0,
    idleShutdownMs: 0,
    maxServices: 50,
  });
  await expect(runtime.startService("ghost")).rejects.toThrow(/config\.mcpServers/);
});
```

Rationale: the previous behaviour (read `.saivage/registry.json` via `getService`) is a deliberate removal; the replacement error string is the user-visible discovery surface for the deletion and must be regression-tested.

### Validation commands

Run from the `saivage` repo root (`/home/salva/g/ml/saivage`), in order:

1. `npm run typecheck` — catches every stale `from "./registry.js"` and every stale `status:` field on `ServiceEntry` literals.
2. `npm run build` — confirms the `tsup` bundle reflects the deletion (the generated `dist/cli.js` no longer contains `registryPath` or `loadRegistry`).
3. `npx vitest run src/mcp` — runs the entire MCP test directory.
4. `npx vitest run` — full suite, single pass.
5. Manual sanity (covers code, web, builtin skills, and the SPEC pages F28 plans to update; expect zero matches outside of intentionally historical review files under `SPEC/v2/review-2026-05/F28/`):
   ```bash
   rg -n "registry\.json|registerService|unregisterService|listRegisteredServices|updateServiceStatus|\bgetService\b" \
      src web skills SPEC/v2/05-MCP-SERVICES.md SPEC/v2/06-SYSTEM-DESIGN.md \
      SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md typedoc.json
   ```
6. Manual sanity: `ls .saivage/registry.json 2>/dev/null` in any active project (e.g. on the `saivage-v3` container) must return nothing — the file was never created automatically, and after this change no v2 code path reads it even if it is present.

## Rollback strategy

Single squash-merged commit. Revert via `git revert <sha>`. No on-disk state is created or migrated by this change; reverting restores the dead code without any data recovery step. Projects that had hand-edited `.saivage/registry.json` files will need to re-declare those services under `config.mcpServers` going forward — revert does not re-enable the file as a configuration surface unless the commit is fully reverted.

## Cross-issue ordering

- **Independent of F11** ([SPEC/v2/review-2026-05/F11/APPROVED.md](SPEC/v2/review-2026-05/F11/APPROVED.md)). F11 adds an `mcp` config block; F28 does not touch `SaivageConfig`. Either order is safe; rebase is trivial (no shared lines).
- **Independent of F12** ([SPEC/v2/review-2026-05/F12/APPROVED.md](SPEC/v2/review-2026-05/F12/APPROVED.md)). F12 reshapes `registerBuiltinServices(runtime, mcpConfig, options)` and adds a closure-captured shell timeout. F12 edits in [src/mcp/builtins.ts](src/mcp/builtins.ts) and [src/server/bootstrap.ts](src/server/bootstrap.ts) on the call site for `registerBuiltinServices`; F28 edits `src/mcp/runtime.ts`'s `startService`/`startFromEntry`/`restartService`/`getAllTools`/`listAllToolsForApi` and `src/server/bootstrap.ts`'s `ServiceEntry` literal. The only shared file is `src/server/bootstrap.ts` and the line ranges do not overlap (F12 hits the `registerBuiltinServices(...)` call at [src/server/bootstrap.ts](src/server/bootstrap.ts#L141-L143); F28 hits the `ServiceEntry` literal at [src/server/bootstrap.ts](src/server/bootstrap.ts#L713-L731) and the type import at [#L37](src/server/bootstrap.ts#L37)). Whichever lands first, the other rebases without conflict.
- **No interaction with F20** (per-model token windows), **F25** (prompt-injection cop), or any other reviewed Fxx surveyed.

If F12 lands first, this plan needs no edit. If F28 lands first, F12's plan also needs no edit (the registry helpers it removes are not referenced by F12's design).
