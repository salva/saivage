# F28 — Analysis r1 — MCP registry persists nothing and is consulted by no live path

## Problem restated

[src/mcp/registry.ts](src/mcp/registry.ts) defines a JSON-backed registry of MCP services with read/write helpers and a Zod schema for `.saivage/registry.json`. In the running system the file is never read for any consequential decision, never written (because nothing ever calls the only mutating exports), and the runtime branches that look it up always iterate an empty list. The original finding ([SPEC/v2/review-2026-05/F28-mcp-registry-unused.md](SPEC/v2/review-2026-05/F28-mcp-registry-unused.md)) claims the file "accumulates entries from every Saivage run" — that claim is too strong: in practice the file is never created by any v2 code path. The actual problem is the opposite: it is dead weight that pretends to be authoritative.

The `ServiceEntry` / `ToolEntry` Zod schemas, however, ARE in active use as the in-memory shape for external server start-up and for tool-catalog entries on the in-process side. Any clean-up must preserve those types.

## Actual behaviour

- File location is computed once: [src/mcp/registry.ts](src/mcp/registry.ts#L39-L41) — `join(saivageDir(), "registry.json")`. `saivageDir()` honours `SAIVAGE_ROOT` (set by bootstrap) so it is project-local.
- `loadRegistry()` returns `{ services: [] }` when the file is missing — [src/mcp/registry.ts](src/mcp/registry.ts#L43-L48).
- `saveRegistry()` writes the full JSON — [src/mcp/registry.ts](src/mcp/registry.ts#L50-L53). It is reachable only from `registerService`, `unregisterService`, and `updateServiceStatus` ([src/mcp/registry.ts](src/mcp/registry.ts#L63-L95)).
- `registerService` and `unregisterService` have **zero callers** anywhere in `src/`, `tests/`, or `web/`. Verified by `grep -rn "registerService\b" src/ tests/`: only the definition in `registry.ts` and a passive re-export in [src/mcp/index.ts](src/mcp/index.ts#L8-L9).
- `updateServiceStatus` IS called from the runtime ([src/mcp/runtime.ts](src/mcp/runtime.ts#L129), [src/mcp/runtime.ts](src/mcp/runtime.ts#L132), [src/mcp/runtime.ts](src/mcp/runtime.ts#L345), [src/mcp/runtime.ts](src/mcp/runtime.ts#L365)). However its body short-circuits when the service is not found ([src/mcp/registry.ts](src/mcp/registry.ts#L89-L94)): `const svc = data.services.find(...); if (svc) { ...; saveRegistry(...); }`. Since `registerService` is never called, `data.services` is always empty, `svc` is always undefined, and `saveRegistry` is never invoked. Net effect: a hot path that does I/O (parse `.saivage/registry.json` if it exists, otherwise return empty) and then no-ops.
- `listRegisteredServices` is called twice from [src/mcp/runtime.ts](src/mcp/runtime.ts#L239) and [src/mcp/runtime.ts](src/mcp/runtime.ts#L294) inside `getAllTools()` and `listAllToolsForApi()`. Both call sites iterate an always-empty array and add nothing to the tool catalog.
- `getService` is called once from [src/mcp/runtime.ts](src/mcp/runtime.ts#L107) inside `startService(name)`. `startService` itself short-circuits at [src/mcp/runtime.ts](src/mcp/runtime.ts#L100-L103) when the service is already in `this.services` (the in-memory map). Every realistic call to `callTool(externalName, ...)` reaches `getClient` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L150)) → `startService(externalName)` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L97)), but the bootstrap path has already populated `this.services` via `startFromEntry` for every configured `mcpServers` entry (see [src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L738)), so the `getService(name)` lookup is unreachable in the happy path. If an external server failed to start at boot, the lookup returns undefined and the error message [src/mcp/runtime.ts](src/mcp/runtime.ts#L108) advertises a registry the caller cannot populate from any documented surface.
- The actual entry path for external MCP servers is [src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L738): iterate `config.mcpServers`, construct a `ServiceEntry` literal, call `mcpRuntime.startFromEntry(entry)`. The default config wires only `playwright` ([src/config.ts](src/config.ts#L225-L234)). The registry file is bypassed entirely.

## Documentation drift

- [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20) tells skill authors: `7. Register in <project>/.saivage/registry.json — include name, command, args, tools list.` There is no mechanism that would consume such an entry; the instruction is stale.
- [SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L412) repeats the same claim for `origin: "generated"` entries — also stale.
- [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313) renders a `registry.json` box in the system-design diagram — stale.
- [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L95) already flags the file as "largely vestigial since builtins are in-process". F28 makes that explicit.
- [typedoc.json](typedoc.json#L17) names `src/mcp/registry.ts` as a documented entry point; the generated API site contains pages for the dead exports.

## Contract

What `registry.ts` exposes today and how each export is used (or not):

| Export | Source | Production callers | Status |
|---|---|---|---|
| `ServiceEntry` (type) | [src/mcp/registry.ts](src/mcp/registry.ts#L28) | [src/mcp/client.ts](src/mcp/client.ts#L3), [src/mcp/runtime.ts](src/mcp/runtime.ts#L2), [src/server/bootstrap.ts](src/server/bootstrap.ts#L37), test files | **Live — must preserve.** |
| `ToolEntry` (type) | [src/mcp/registry.ts](src/mcp/registry.ts#L29) | [src/mcp/builtins.ts](src/mcp/builtins.ts#L11), [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L7), [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L17), [src/mcp/knowledgeMemory.ts](src/mcp/knowledgeMemory.ts#L11), [src/mcp/runtime.ts](src/mcp/runtime.ts#L2), test files | **Live — must preserve.** |
| `serviceEntrySchema`, `toolEntrySchema`, `registrySchema` (Zod) | [src/mcp/registry.ts](src/mcp/registry.ts#L9-L33) | Not exported; only used internally by `loadRegistry`. | **Dead — only feeds the dead persistence layer.** |
| `listRegisteredServices` | [src/mcp/registry.ts](src/mcp/registry.ts#L55-L57) | [src/mcp/runtime.ts](src/mcp/runtime.ts#L239), [src/mcp/runtime.ts](src/mcp/runtime.ts#L294) — both iterate an always-empty result. | **Effectively dead.** |
| `getService` | [src/mcp/registry.ts](src/mcp/registry.ts#L59-L61) | [src/mcp/runtime.ts](src/mcp/runtime.ts#L107) — unreachable in happy path; returns undefined otherwise. | **Effectively dead.** |
| `registerService` | [src/mcp/registry.ts](src/mcp/registry.ts#L63-L72) | None. | **Dead.** |
| `unregisterService` | [src/mcp/registry.ts](src/mcp/registry.ts#L74-L83) | None. | **Dead.** |
| `updateServiceStatus` | [src/mcp/registry.ts](src/mcp/registry.ts#L85-L95) | [src/mcp/runtime.ts](src/mcp/runtime.ts#L129), [src/mcp/runtime.ts](src/mcp/runtime.ts#L132), [src/mcp/runtime.ts](src/mcp/runtime.ts#L345), [src/mcp/runtime.ts](src/mcp/runtime.ts#L365) — always a no-op because no service was ever registered. | **Effectively dead.** |

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
- [src/mcp/index.ts](src/mcp/index.ts#L3-L11) — re-exports `ServiceEntry`, `ToolEntry`, and the four function helpers. Any external embedder importing from `saivage/dist` could in principle depend on these; the package is not published to npm and the only consumer is this repo (verified by grep on all sibling projects under `/home/salva/g/ml`).

Tests that touch the runtime registry paths today:
- [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts#L1-L60) exercises `startFromEntry` only — never the registry-lookup branch.
- No test calls `registerService` / `listRegisteredServices` / `getService` / `unregisterService` / `updateServiceStatus`.

## Constraints any solution must respect

1. **Architecture-first, no backward compat** (project guideline #1). The `.saivage/registry.json` filename has never been a stable user contract — the file isn't created by any code path — so there is no on-disk migration to perform. Delete the persistence layer in the same change; do not leave shims, `@deprecated` aliases, or transitional `if (existsSync(...))` guards.
2. **Type continuity.** `ServiceEntry` and `ToolEntry` must remain importable from inside `src/mcp/*` and `src/server/bootstrap.ts`. The Zod schemas behind them (`serviceEntrySchema`, `toolEntrySchema`) currently `.default()` many fields ([src/mcp/registry.ts](src/mcp/registry.ts#L11-L26)) — if anything still validates external input, the defaults must survive; if not, the schemas can be dropped in favour of plain TypeScript interfaces. Per the bootstrap callsite ([src/server/bootstrap.ts](src/server/bootstrap.ts#L713-L731)) every `ServiceEntry` is constructed as a fully-populated literal — no Zod parse — so the schemas are not load-bearing for runtime safety.
3. **External-server path stays working.** `startConfiguredMcpServers` ([src/server/bootstrap.ts](src/server/bootstrap.ts#L708-L738)) builds a `ServiceEntry` and calls `mcpRuntime.startFromEntry`. After the change, that call must succeed identically — no calls into the removed registry helpers.
4. **Error messaging.** `startService("notFound")` currently throws `Service "${name}" not found in registry` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L108)). With the registry gone, the message must point users to the actual source of truth: `config.mcpServers`. Avoid mentioning a file that does not exist.
5. **Cross-link to F12.** F12's approved design ([SPEC/v2/review-2026-05/F12/02-design-r3.md](SPEC/v2/review-2026-05/F12/02-design-r3.md)) reshapes `registerBuiltinServices(runtime, mcpConfig, options)` and adds a closure-captured shell timeout. F28's changes are entirely on the registry/runtime side and do not collide with that signature change; whichever lands first, the other rebases trivially. F12 does not depend on registry helpers, and F28 does not depend on the builtins factory signature.
6. **Cross-link to F11.** F11's approved hoist ([SPEC/v2/review-2026-05/F11/APPROVED.md](SPEC/v2/review-2026-05/F11/APPROVED.md)) introduces an `mcp` config block; registry helpers are not part of F11's scope. No interaction.
7. **Documentation drift.** The stale step in [skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L20) must be rewritten or deleted in the same commit. The SPEC v2 pages ([SPEC/v2/05-MCP-SERVICES.md](SPEC/v2/05-MCP-SERVICES.md#L412), [SPEC/v2/06-SYSTEM-DESIGN.md](SPEC/v2/06-SYSTEM-DESIGN.md#L313)) also reference the registry file; per the convention these are SPEC-of-record and should be updated, not left to drift further.
8. **`typedoc.json` entry point.** [typedoc.json](typedoc.json#L17) lists `src/mcp/registry.ts`. If the file is deleted or renamed, this entry must be updated; otherwise the docs build fails.
9. **Out-of-scope.** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/`, and memory code are owned by another agent (per [_LOOP-CONVENTIONS.md](_LOOP-CONVENTIONS.md)). The change at hand only touches `skills/builtin/mcp-authoring/SKILL.md` — that path is `skills/builtin/`, not `src/skills/` or `SPEC/v2/skills/`, so it is in scope; if the convention is interpreted more strictly, the skill update can be split into a follow-up commit without changing the runtime fix.
