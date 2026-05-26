# F28 — Analysis r2 — MCP registry has no v2 producer, but is a live read path the docs still steer users to

## Changes from r1

- Reframed the deadness claim: the runtime reader paths in [src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110), [src/mcp/runtime.ts](src/mcp/runtime.ts#L216-L247), and [src/mcp/runtime.ts](src/mcp/runtime.ts#L249-L307) **are** live consumers of `.saivage/registry.json` if such a file exists. What is dead is the **producer side**: `registerService` / `unregisterService` have zero callers, configured external servers come from `config.mcpServers`, and v2 never writes the file itself. Rewrote "Actual behaviour" and the contract table to reflect this.
- Replaced the "Documentation drift" framing: the stale docs are not drifting away from a dead reader, they are pointing users to a manual path that v2 still implements but no longer wants to support. Deleting them is the intentional removal of that path.
- Tightened the "Constraints" section to spell out the behavioural change: existing on-disk `.saivage/registry.json` files (if any) stop being consumed by `startService` / `getAllTools` / `listAllToolsForApi` after this change.

## Problem restated

[src/mcp/registry.ts](src/mcp/registry.ts) defines a JSON-backed registry of MCP services with read/write helpers and a Zod schema for `.saivage/registry.json`. v2's runtime reads that file in three live paths — lazy-start in `startService`, tool-catalog assembly in `getAllTools`, and the API projection in `listAllToolsForApi` — and the resulting catalogs flow to the dispatcher, the agent loop, and the `/api/mcp/tools` endpoint. What is dead is the **producer side**: nothing in `src/` populates the file, the two mutating helpers have zero callers, and configured external servers go through `config.mcpServers` → `startFromEntry` instead. The only way an entry can reach the reader paths today is if a user follows the stale manual instructions in [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20) and [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L410-L414) and hand-edits the file.

The actual problem is therefore: a documented, manually-populated configuration surface that competes with `config.mcpServers`, persists `status` fields no producer maintains, and is not what v2's architecture intends to support. Under the no-backward-compatibility guideline the cure is to delete both the reader paths and the stale docs in the same change.

The original finding ([SPEC/v2/review-2026-05/F28-mcp-registry-unused.md](SPEC/v2/review-2026-05/F28-mcp-registry-unused.md)) claims the file "accumulates entries from every Saivage run." That overstates the writer side — in practice no v2 code path creates the file. The reader side, however, is wired up exactly as that finding describes.

## Actual behaviour

- File location is computed once: [src/mcp/registry.ts](src/mcp/registry.ts#L39-L41) — `join(saivageDir(), "registry.json")`. `saivageDir()` honours `SAIVAGE_ROOT` (set by bootstrap) so it is project-local.
- `loadRegistry()` returns `{ services: [] }` when the file is missing — [src/mcp/registry.ts](src/mcp/registry.ts#L43-L48). When the file is present it `JSON.parse`s and `registrySchema.parse`s it, so a hand-edited file with malformed entries throws at read time.
- `saveRegistry()` writes the full JSON — [src/mcp/registry.ts](src/mcp/registry.ts#L50-L53). Reachable only from `registerService`, `unregisterService`, and `updateServiceStatus` ([src/mcp/registry.ts](src/mcp/registry.ts#L63-L95)).
- **Producers (dead).** `registerService` and `unregisterService` have **zero callers** anywhere in `src/`, `tests/`, or `web/`. Verified by `grep -rn "registerService\b\|unregisterService\b" src/ tests/ web/`: only the definitions in `registry.ts` and a passive re-export in [src/mcp/index.ts](src/mcp/index.ts#L8-L9). No v2 path writes `.saivage/registry.json`.
- **Status updates (no-op in practice).** `updateServiceStatus` is called from the runtime ([src/mcp/runtime.ts](src/mcp/runtime.ts#L129), [src/mcp/runtime.ts](src/mcp/runtime.ts#L132), [src/mcp/runtime.ts](src/mcp/runtime.ts#L345), [src/mcp/runtime.ts](src/mcp/runtime.ts#L365)). Its body ([src/mcp/registry.ts](src/mcp/registry.ts#L89-L94)) does `const svc = data.services.find(...); if (svc) { ...; saveRegistry(...); }`. With no producer, `data.services` is normally empty and `saveRegistry` is never invoked. If a user hand-creates the file the branch fires and persists the new `status`, but no caller of `ServiceEntry` reads `entry.status` other than the catalog filters described below.
- **Lazy-start reader (live).** `startService(name)` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L96-L110)) first short-circuits when `this.services` already has a connected client. On miss it calls `getService(name)` ([src/mcp/registry.ts](src/mcp/registry.ts#L59-L61)) → `loadRegistry()` and, if an entry is found, hands it to `startFromEntry`. A hand-populated `.saivage/registry.json` therefore reaches subprocess startup verbatim. `getClient(name)` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L148-L150)) routes through `startService`, so any dispatcher call to `callTool(externalName, ...)` exercises this path when the service is not already running.
- **Tool-catalog reader (live).** `getAllTools()` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L216-L247)) merges in-process services, currently-running services, and registry entries with `status === "active"`. `listAllToolsForApi()` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L249-L307)) does the same projection for `/api/mcp/tools`. Both call `listRegisteredServices()` ([src/mcp/registry.ts](src/mcp/registry.ts#L55-L57)), which reads the file. With no producer the iteration is over an empty array, but with a hand-edited file every active entry contributes tools.
- **Consumers of those catalogs.** `getAllTools()` is consumed by the dispatcher's tool-schema assembly at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L167), the agent loop at [src/agents/base.ts](src/agents/base.ts#L598), and the built-in test at [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L76). `listAllToolsForApi()` is consumed by [src/server/server.ts](src/server/server.ts#L243) for the `/api/mcp/tools` HTTP endpoint and by [src/mcp/runtime.api.test.ts](src/mcp/runtime.api.test.ts#L19). Any registry entry would surface in all of those.
- **External servers go a different route.** [src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L738) iterates `config.mcpServers`, constructs a `ServiceEntry` literal, and calls `mcpRuntime.startFromEntry(entry)` directly. `startFromEntry` writes to `this.services` but never to the registry file. The default config wires only `playwright` ([src/config.ts](src/config.ts#L225-L234)). This is the only producer of `ServiceEntry` instances at runtime.

## Documented but stale manual path

The following docs currently instruct users (and skill authors) to populate `.saivage/registry.json` by hand:

- [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20): `7. Register in <project>/.saivage/registry.json — include name, command, args, tools list.`
- [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L410-L414): describes `.saivage/registry.json` as the persisted-state file for `origin: "generated"` entries.
- [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313): renders a `registry.json` node in the system-design Mermaid diagram.
- [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95): already flags the file as "largely vestigial since builtins are in-process".
- [typedoc.json](typedoc.json#L17) names `src/mcp/registry.ts` as a documented entry point; the generated API site exposes `registerService`, `unregisterService`, `listRegisteredServices`, and `updateServiceStatus` as public surface.

If a user follows those instructions today, the runtime will read the file, start the declared subprocess, and surface its tools in `getAllTools` / `listAllToolsForApi`. Deleting the registry under the no-backward-compatibility guideline therefore **does remove a working capability** — one that has no v2 producer and that competes with `config.mcpServers` for the same role. The intent of F28 is to delete that competing surface and make `config.mcpServers` the sole declaration site.

## Contract

What `registry.ts` exposes today and how each export is used:

| Export | Source | Production callers | Status |
|---|---|---|---|
| `ServiceEntry` (type) | [src/mcp/registry.ts](src/mcp/registry.ts#L28) | [src/mcp/client.ts](src/mcp/client.ts#L3), [src/mcp/runtime.ts](src/mcp/runtime.ts#L2), [src/server/bootstrap.ts](src/server/bootstrap.ts#L37), test files | **Live — must preserve.** |
| `ToolEntry` (type) | [src/mcp/registry.ts](src/mcp/registry.ts#L29) | [src/mcp/builtins.ts](src/mcp/builtins.ts#L11), [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L7), [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L17), [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L11), [src/mcp/runtime.ts](src/mcp/runtime.ts#L2), test files | **Live — must preserve.** |
| `serviceEntrySchema`, `toolEntrySchema`, `registrySchema` (Zod) | [src/mcp/registry.ts](src/mcp/registry.ts#L9-L33) | Only used internally by `loadRegistry`. | **Goes with the persistence layer.** |
| `listRegisteredServices` | [src/mcp/registry.ts](src/mcp/registry.ts#L55-L57) | [src/mcp/runtime.ts](src/mcp/runtime.ts#L239), [src/mcp/runtime.ts](src/mcp/runtime.ts#L294) — **live readers** of `.saivage/registry.json` when the file exists. | **Live reader, no v2 producer — to be deleted.** |
| `getService` | [src/mcp/registry.ts](src/mcp/registry.ts#L59-L61) | [src/mcp/runtime.ts](src/mcp/runtime.ts#L107) inside `startService` — **live reader** when a service is not in `this.services` and the file lists it. | **Live reader, no v2 producer — to be deleted.** |
| `registerService` | [src/mcp/registry.ts](src/mcp/registry.ts#L63-L72) | None. | **Dead.** |
| `unregisterService` | [src/mcp/registry.ts](src/mcp/registry.ts#L74-L83) | None. | **Dead.** |
| `updateServiceStatus` | [src/mcp/registry.ts](src/mcp/registry.ts#L85-L95) | [src/mcp/runtime.ts](src/mcp/runtime.ts#L129), [src/mcp/runtime.ts](src/mcp/runtime.ts#L132), [src/mcp/runtime.ts](src/mcp/runtime.ts#L345), [src/mcp/runtime.ts](src/mcp/runtime.ts#L365) — no-op unless a hand-edited file is present. | **Effectively dead, callers to be removed.** |

Error modes / lifecycle: every helper is synchronous filesystem I/O against a single project-local path; there is no caching and no concurrency control. With the persistence layer gone, this entire surface goes too.

## Call sites & dependencies

Live consumers of the **types** that must keep compiling after the change:

- [src/mcp/client.ts](src/mcp/client.ts#L3) — `import type { ServiceEntry, ToolEntry }`.
- [src/mcp/runtime.ts](src/mcp/runtime.ts#L2) — `import type { ServiceEntry, ToolEntry }`.
- [src/mcp/builtins.ts](src/mcp/builtins.ts#L11) — `import type { ToolEntry }`.
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L7) — `import type { ToolEntry }`.
- [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L17) — `import type { ToolEntry }`.
- [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L11) — `import type { ToolEntry }`.
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L37) — `import type { ServiceEntry }`.
- [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts#L3) — `import type { ServiceEntry }`.
- [src/mcp/toolContext.test.ts](src/mcp/toolContext.test.ts#L18) — `import type { ToolEntry }`.
- [src/mcp/index.ts](src/mcp/index.ts#L3-L11) — re-exports `ServiceEntry`, `ToolEntry`, and the four function helpers. The package is not published to npm; the only consumer of `saivage/dist` is this repo itself (verified by grep on all sibling projects under `/home/salva/g/ml`).

Live consumers of the catalogs that the registry-reader branches feed into:

- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L167) consumes `getAllTools()` to build the tool schema array passed to providers.
- [src/agents/base.ts](src/agents/base.ts#L598) consumes `getAllTools()` for agent-side tool resolution.
- [src/server/server.ts](src/server/server.ts#L243) consumes `listAllToolsForApi()` for the `/api/mcp/tools` HTTP endpoint.

Tests that touch the runtime registry paths today:
- [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts#L21-L60) exercises `startFromEntry` only — never the registry-lookup branch.
- [src/mcp/runtime.api.test.ts](src/mcp/runtime.api.test.ts) exercises `listAllToolsForApi` over in-process and running services — never the registry branch.
- No test calls `registerService` / `listRegisteredServices` / `getService` / `unregisterService` / `updateServiceStatus`.

## Constraints any solution must respect

1. **Architecture-first, no backward compat** (project guideline #1). `.saivage/registry.json` is currently a documented manual configuration surface. Deleting it is the architecturally-correct choice: there is exactly one MCP declaration site after the change (`config.mcpServers`), no migration shim, no `if (existsSync(registryPath))` guard, and the stale docs are rewritten in the same commit.
2. **Behavioural change must be acknowledged.** After this change, a project that previously relied on a hand-edited `.saivage/registry.json` will lose its declared services. There is no automated detection (no metric, no telemetry); the discovery surface is the new `startService` error message (which names `config.mcpServers`), the SKILL.md rewrite, and the SPEC update.
3. **Type continuity.** `ServiceEntry` and `ToolEntry` must remain importable from inside `src/mcp/*` and `src/server/bootstrap.ts`. The Zod schemas behind them (`serviceEntrySchema`, `toolEntrySchema`) currently `.default()` many fields ([src/mcp/registry.ts](src/mcp/registry.ts#L11-L26)). Bootstrap constructs `ServiceEntry` as a fully-populated literal ([src/server/bootstrap.ts](src/server/bootstrap.ts#L713-L731)) without ever calling Zod, so the schemas are not load-bearing for runtime safety and can be dropped along with the persistence layer.
4. **External-server path stays working.** `startConfiguredMcpServers` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L738)) must keep building a `ServiceEntry` and calling `mcpRuntime.startFromEntry` exactly as today — that is the surviving declaration path.
5. **Error messaging.** `startService("notFound")` currently throws `Service "${name}" not found in registry` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L108)). The new throw must point users to `config.mcpServers` (the actual source of truth) and must not mention a file that no longer exists in the codebase.
6. **Cross-link to F12.** F12's approved design ([SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md)) reshapes `registerBuiltinServices(runtime, mcpConfig, options)` and adds a closure-captured shell timeout. F28's changes are on the registry/runtime side and do not collide with that signature change; whichever lands first, the other rebases trivially. F12 does not depend on registry helpers, and F28 does not depend on the builtins factory signature.
7. **Cross-link to F11.** F11's approved hoist ([SPEC/v2/review-2026-05/F11/APPROVED.md](SPEC/v2/review-2026-05/F11/APPROVED.md)) introduces an `mcp` config block; registry helpers are not part of F11's scope. No interaction.
8. **Stale documentation.** [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20), [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L410-L414), [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313), and [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95) all reference the manual registry path. Per the project guideline these are SPEC-of-record and must be updated, not left to drift further.
9. **`typedoc.json` entry point.** [typedoc.json](typedoc.json#L17) lists `src/mcp/registry.ts`. If the file is deleted or renamed, this entry must be updated; otherwise the docs build fails.
10. **Out-of-scope.** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/`, and memory code are owned by another agent (per [_LOOP-CONVENTIONS.md](_LOOP-CONVENTIONS.md)). The change at hand touches `skills/builtin/mcp-authoring/SKILL.md` — that path is `skills/builtin/`, not `src/skills/` or `SPEC/v2/skills/`, so it is in scope; if the convention is interpreted more strictly, the skill update can be split into a follow-up commit without changing the runtime fix.
