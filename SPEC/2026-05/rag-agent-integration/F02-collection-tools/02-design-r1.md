# F02 — Agent-Facing RAG Collection Tools: Design

This design crystallises module boundaries, the `RagService` shape,
and the handler organisation for the seven-tool `rag` surface
specified in
[01-analysis-r7.md](saivage/SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r7.md).

## A. Focused Proposal — single `rag` service, switch-based handler

### A.1 Modules

```
src/server/rag/
├── service.ts          // RagService type, isMutating, isRuntimeOperatorContext, RAG_TOOLS
├── handler.ts          // registerRagService(runtime, service) + single switch handler
├── envelope.ts         // ragOk(content) / ragErr(code, message, details?) helpers
├── errors.ts           // mapRagError(err) → { code, details } for known RAG error classes
└── persist.ts          // saveSaivageConfig(projectRoot, mutate) — moved to src/config.ts; persist.ts re-exports for handler use
```

The `RagService` interface (from analysis §6) is exported by
`service.ts`:

```ts
export interface RagService {
  manager: RagManager;
  datasets: RuntimeRagDatasetConfig[];     // shared array with manager
  watchStatus: Map<string, "off" | "armed">;
  controlMutex: Mutex;
  enabled: boolean;
  adminRoles: Set<AgentRole>;              // F03 adds "librarian"
}

export type RuntimeRagDatasetConfig = Omit<DatasetConfig, "projectId">;

export function isRuntimeOperatorContext(ctx: ToolCallContext): boolean {
  return ctx.operatorContext === true;
}

const MUTATING = new Set(["rag_register", "rag_ingest", "rag_drop", "rag_admin"]);
export const isMutating = (name: string) => MUTATING.has(name);
```

`registerRagService(runtime, service)` calls
`runtime.registerInProcess("rag", RAG_TOOLS, ragHandler.bind(null,
service), { available: true })` per
[runtime.ts](src/mcp/runtime.ts#L153-L184).

### A.2 Handler shape

A single async handler function dispatches by `toolName`. Pre-checks:

```ts
async function ragHandler(service, toolName, args, ctx) {
  log.info("rag.call", { tool: toolName, role: ctx.role, agentId: ctx.agentId });

  if (!service.enabled) return ragErr("RAG_DISABLED", "rag is disabled");

  if (isMutating(toolName)
      && !isRuntimeOperatorContext(ctx)
      && !service.adminRoles.has(ctx.role)) {
    return ragErr("RAG_UNAUTHORIZED_ROLE", `role=${ctx.role} cannot ${toolName}`);
  }

  const parsed = TOOL_SCHEMAS[toolName].safeParse(args);
  if (!parsed.success) return ragErr("RAG_INVALID_ARGS", parsed.error.message,
                                     { issues: parsed.error.issues });

  try {
    switch (toolName) {
      case "rag_list":      return ragOk(await tools.list(service));
      case "rag_stats":     return ragOk(await tools.stats(service, parsed.data));
      case "rag_query":     return ragOk(await tools.query(service, parsed.data));
      case "rag_register":  return ragOk(await tools.register(service, parsed.data, ctx));
      case "rag_ingest":    return ragOk(await tools.ingest(service, parsed.data));
      case "rag_drop":      return ragOk(await tools.drop(service, parsed.data));
      case "rag_admin":     return ragOk(await tools.admin(service, parsed.data));
    }
  } catch (err) {
    const mapped = mapRagError(err);
    return ragErr(mapped.code, mapped.message, mapped.details);
  }
}
```

Each tool function lives in `tools/<name>.ts` with a single export.

### A.3 Mutex strategy

`service.controlMutex` wraps `register`, `drop`, `admin`. `query` /
`list` / `stats` / `ingest` do not acquire it. Acquisition uses
`tryAcquire` and returns `RAG_CONTROL_BUSY` on contention.

### A.4 `mapRagError`

Switch on `err.constructor.name` for the 8 RAG error classes
([errors.ts](src/rag/errors.ts#L3-L116)) and on the
`message`-prefixed `"watch disabled"` plain `Error` from
`Dataset.watch()`. Default → `RAG_INTERNAL`.

### A.5 Walker hardening

Hardening lives entirely in `src/rag/walker.ts`:

```ts
// Inside the recursive walk, after fs.realpath(abs):
const rel = path.relative(rootReal, realAbs);
if (rel.startsWith("..") || path.isAbsolute(rel)) {
  log.warn("rag.walker.symlink-escape", JSON.stringify({ root: rootReal, path: realAbs }));
  continue;
}
```

The `log` import points at the existing `src/log.ts` which exposes
`info(msg: string)` and `warn(msg: string)`. The structured payload
is JSON-stringified into the message (the existing logger signature
is preserved; no public RAG export changes).

### A.6 Persistence

`saveSaivageConfig(projectRoot, mutate)` lives in
[src/config.ts](src/config.ts) (not a new module):

```ts
export async function saveSaivageConfig(
  projectRoot: string,
  mutate: (cfg: SaivageConfig) => SaivageConfig,
): Promise<void> {
  const path = configPath(projectRoot);
  const current = await loadConfig(projectRoot);
  const next = SaivageConfigSchema.parse(mutate(current));
  const tmp = path + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, path);
}
```

Atomic via temp+rename. Errors bubble to the handler →
`RAG_PERSIST_FAILED`.

## B. Level-up Alternative — per-tool service registration

Register each tool as its own MCP service (`rag.list`, `rag.query`,
…). Pros: smaller handlers; smaller mutex scope (per-service);
clearer per-tool authorization. Cons: seven service registrations
instead of one; `available` flips on `rag.enabled` would need to be
duplicated seven times; logging/correlation across `rag_register +
rag_ingest` operator workflows loses the shared service identity;
diverges from how `knowledge*` MCP services are currently organised
([builtins.ts](src/mcp/builtins.ts#L1912-L1966)). Rejected.

## C. Chosen Direction

A. Single `rag` service, switch-based handler with per-tool function
files. Matches the existing `builtins.ts` convention, keeps the
authorization predicate in one place, and lets the mutating-tool
mutex be a single object.

## D. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Walker realpath syscall on every entry slows large ingest | The walker already calls `fs.stat`; realpath is one additional `fs.realpath` per entry. Acceptable for the target dataset sizes (≤ 100k files). |
| Mutex contention on operator-script bursts | `RAG_CONTROL_BUSY` is documented as transient; F03 prompt guides the Librarian to retry once. |
| `saveSaivageConfig` race with parallel runtimes | Saivage runs at most one server per project; concurrent writers are out of scope. |
| Operator bypass leaks to a misconstructed runtime ctx | The only call site setting `operatorContext: true` is the CLI entry; covered by `src/server/rag/handler.test.ts`. |

## E. Test Strategy

- Unit: schema validation; envelope shape; per-error mapping;
  containment helper.
- Integration: walker symlink escape (fixture with symlink to
  `/tmp`); register persist rollback; mutex contention path; protected
  dataset rejection.
- E2E: in-process `RagManager` + temp dir; full `rag_register` →
  `rag_ingest` → `rag_query` → `rag_drop` flow under both
  operator and admin-role contexts.

## F. Out of Scope (FUPs)

- **FUP-WATCHER-LOG**: structured `RagManager` watcher logger seam.
- **FUP-RAG-SYMLINK**: native walker symlink containment (subsumed
  by §A.5; recorded as the canonical location).
- **FUP-INGEST-PATHS**: per-path secret-affected info on
  `IngestReport`.
