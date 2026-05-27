# F02 — Agent-Facing RAG Collection Tools: Design

This design crystallises module boundaries, the `RagService` shape,
the handler organisation, the control mutex, persistence, error
mapping, and walker hardening for the seven-tool `rag` surface
specified in
[01-analysis-r7.md](saivage/SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r7.md).

## A. Focused Proposal — `rag` service registered by builtins, switch-based handler

### A.1 Modules

```
src/server/rag/
├── service.ts          // RagService type, RAG_TOOLS, isMutating, isRuntimeOperatorContext, MUTATING set
├── handler.ts          // makeRagHandler(service): switch dispatcher used by builtins.ts
├── envelope.ts         // ragOk(content) / ragErr(code, message, details?)
├── errors.ts           // mapRagError(err) for the eight non-base RAG error classes
├── mutex.ts            // tryRunExclusive<T>(state, fn): { ok: true, value: T } | { ok: false }
├── persist.ts          // saveSaivageConfig: raw JSON read/validate/write (atomic)
└── tools/
    ├── list.ts
    ├── stats.ts
    ├── query.ts
    ├── register.ts
    ├── ingest.ts
    ├── drop.ts
    └── admin.ts
```

[src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966) is the
registration site (see §A.7). [src/config.ts](src/config.ts) gains
the exported `saveSaivageConfig` symbol; the implementation lives
in `src/server/rag/persist.ts` and is re-exported from `config.ts`
to keep all config IO co-located in the public config module.

### A.2 `RagService` shape

```ts
// src/server/rag/service.ts
export type RuntimeRagDatasetConfig = Omit<DatasetConfig, "projectId">;

export interface RagService {
  manager: RagManager;
  datasets: RuntimeRagDatasetConfig[];          // shared array (manager + service)
  watchStatus: Map<string, "off" | "armed">;
  adminRoles: Set<AgentRole>;                   // F03 mutates: .add("librarian")
  control: { busy: boolean };                   // mutex state (see A.4)
  enabled: boolean;                             // config.rag.enabled snapshot
  projectRoot: string;
}

export const RAG_TOOLS = [
  "rag_list", "rag_stats", "rag_query",
  "rag_register", "rag_ingest", "rag_drop", "rag_admin",
] as const;

const MUTATING = new Set<string>(["rag_register", "rag_ingest", "rag_drop", "rag_admin"]);
export const isMutating = (n: string) => MUTATING.has(n);

export function isRuntimeOperatorContext(ctx: ToolCallContext): boolean {
  return ctx.operatorContext === true;
}
```

`ToolCallContext` is extended in
[src/mcp/toolContext.ts](src/mcp/toolContext.ts#L17-L34) with
`operatorContext?: boolean`, settable only by the CLI/server
runtime construction path. Tool argument schemas never accept it.

### A.3 Handler

```ts
// src/server/rag/handler.ts
export function makeRagHandler(service: RagService) {
  return async (toolName: string, args: unknown, ctx: ToolCallContext) => {
    log.info(`rag.call ${JSON.stringify({ tool: toolName, role: ctx.role, agentId: ctx.agentId })}`);

    if (!service.enabled) return ragErr("RAG_DISABLED", "rag is disabled");

    if (isMutating(toolName)
        && !isRuntimeOperatorContext(ctx)
        && !service.adminRoles.has(ctx.role)) {
      return ragErr("RAG_UNAUTHORIZED_ROLE", `role=${ctx.role} cannot ${toolName}`);
    }

    const schema = TOOL_SCHEMAS[toolName];
    if (!schema) return ragErr("RAG_INTERNAL", `unknown tool ${toolName}`);
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return ragErr("RAG_INVALID_ARGS", parsed.error.message, { issues: parsed.error.issues });
    }

    const fn = TOOL_IMPL[toolName];
    try {
      if (isMutating(toolName)) {
        const slot = tryRunExclusive(service.control, () => fn(service, parsed.data, ctx));
        if (!slot.ok) return ragErr("RAG_CONTROL_BUSY", "another control operation is in progress");
        return ragOk(await slot.value);
      }
      return ragOk(await fn(service, parsed.data, ctx));
    } catch (err) {
      const m = mapRagError(err);
      return ragErr(m.code, m.message, m.details);
    }
  };
}
```

`mapRagError` (`src/server/rag/errors.ts`) switches on
`err.constructor.name` and maps the eight non-base RAG error
classes from [src/rag/errors.ts](src/rag/errors.ts#L3-L116):

| Source class | Envelope code |
|---|---|
| `DatasetNotFoundError` | `RAG_NOT_FOUND` |
| `ProviderUnavailableError` | `RAG_PROVIDER_UNAVAILABLE` |
| `EmbeddingDriftError` | `RAG_EMBEDDING_DRIFT` |
| `ConfigDriftError` | `RAG_CONFIG_DRIFT` |
| `CorruptedStoreError` | `RAG_STORE_CORRUPTED` |
| `IngestLockedError` | `RAG_INGEST_LOCKED` |
| `WatcherUnavailableError` | `RAG_WATCHER_UNAVAILABLE` |
| `InvalidQueryFilterError` | `RAG_INVALID_FILTER` |
| `SaivagePersistError` (new, from `persist.ts`) | `RAG_PERSIST_FAILED` |
| anything else | `RAG_INTERNAL` |

`SaivagePersistError extends Error { details: { stage: "read" | "validate" | "write" | "rollback" } }`.

`RAG_WATCH_DISABLED` is **not** produced from a thrown error.
`rag_admin watch_arm` pre-checks `dataset.config.watch === false`
and short-circuits with that code before calling `dataset.watch()`,
matching analysis §4.7. `RAG_SECRET_DROPPED` is reserved for a
future emitter; F02 never produces it.

### A.4 Control mutex

```ts
// src/server/rag/mutex.ts
export function tryRunExclusive<T>(
  state: { busy: boolean },
  fn: () => Promise<T>,
): { ok: true; value: Promise<T> } | { ok: false } {
  if (state.busy) return { ok: false };
  state.busy = true;
  const value = fn().finally(() => { state.busy = false; });
  return { ok: true, value };
}
```

Non-queueing. Tests in `mutex.test.ts` cover: two concurrent
mutating calls → second returns `{ ok: false }`; a thrown error
inside `fn` still releases `busy`. No new npm dependency.

### A.5 Persistence

```ts
// src/server/rag/persist.ts (re-exported from src/config.ts)
export class SaivagePersistError extends Error {
  constructor(msg: string, public details: { stage: "read"|"validate"|"write"|"rollback" }) {
    super(msg);
  }
}

export async function saveSaivageConfig(
  projectRoot: string,
  mutate: (cfg: SaivageConfig) => SaivageConfig,
): Promise<void> {
  const fp = configPath(projectRoot);
  let rawText = "{}";
  try {
    if (await pathExists(fp)) rawText = await fs.readFile(fp, "utf-8");
  } catch (err) {
    throw new SaivagePersistError((err as Error).message, { stage: "read" });
  }
  let current: SaivageConfig;
  try {
    current = SaivageConfigSchema.parse(JSON.parse(rawText));   // no env interpolation
  } catch (err) {
    throw new SaivagePersistError((err as Error).message, { stage: "validate" });
  }
  let next: SaivageConfig;
  try {
    next = SaivageConfigSchema.parse(mutate(current));
  } catch (err) {
    throw new SaivagePersistError((err as Error).message, { stage: "validate" });
  }
  const tmp = fp + "." + process.pid + ".tmp";
  try {
    await fs.writeFile(tmp, JSON.stringify(next, null, 2));
    await fs.rename(tmp, fp);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw new SaivagePersistError((err as Error).message, { stage: "write" });
  }
}
```

Reads raw JSON, **never** calls `loadConfig` (which interpolates
env vars via `deepInterpolate` at
[src/config.ts](src/config.ts#L308-L319)). Writes via temp+rename
in the same directory to keep the operation atomic on the same
filesystem.

`rag_register` and `rag_drop` follow this flow:

1. acquire mutex,
2. mutate `service.datasets` in memory and call `service.manager.register(cfg)` / `unregister(id)`,
3. `await saveSaivageConfig(projectRoot, (cfg) => ({ ...cfg, rag: { ...cfg.rag, datasets: serialiseDatasets(service.datasets) }}))`,
4. on `SaivagePersistError`, roll back the in-memory mutation and
   rethrow — `mapRagError` produces `RAG_PERSIST_FAILED` with the
   `stage` in `details`.

### A.6 Walker hardening

`src/rag/walker.ts` change (private, no public export drift; the
exported `WalkedFile[]` shape is preserved):

```ts
// at the top of walk():
const rootReal = await fs.realpath(root);
// inside recursion, after stat(abs):
const realAbs = await fs.realpath(abs);
const rel = path.relative(rootReal, realAbs);
if (rel.startsWith("..") || path.isAbsolute(rel)) {
  log.warn(
    "rag.walker.symlink-escape " +
      JSON.stringify({ root: rootReal, path: realAbs }),
  );
  continue;
}
```

[src/log.ts](src/log.ts) only accepts a single string, so the
structured payload is appended to the log message. `realAbs` is the
canonical path used for containment; the existing `WalkedFile`
records continue to carry the original `path` to preserve caller
semantics.

### A.7 Registration boundary (builtins-mediated)

[src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966)
`BuiltinServicesOptions` gains a `rag?: RagService` field. Inside
`registerBuiltinServices`:

```ts
if (options.rag) {
  runtime.registerInProcess(
    "rag",
    RAG_TOOL_DEFINITIONS,             // exported by src/server/rag/handler.ts
    makeRagHandler(options.rag),
    { available: options.rag.enabled },
  );
}
```

Server bootstrap
([src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151))
constructs the `RagManager` + `RagService` and passes it through
the existing options bag:

```ts
const manager = await createRagManager({ projectRoot, datasets, providerOptions });
const ragService: RagService = {
  manager, datasets, watchStatus: new Map(), adminRoles: new Set(),
  control: { busy: false }, enabled: config.rag.enabled, projectRoot,
};
registerBuiltinServices(mcpRuntime, mcpConfig, securityConfig, { rag: ragService });
```

`registerBuiltinServices` keeps owning every in-process service
registration; no other module calls `runtime.registerInProcess` for
the `rag` service.

### A.8 `rag_admin watch_arm` flow

```ts
const dataset = service.manager.get(input.id);
if (!dataset) return ragErr("RAG_NOT_FOUND", input.id);
if (dataset.config.watch === false)
  return ragErr("RAG_WATCH_DISABLED", `dataset ${input.id} has watch=false`);
try {
  await dataset.watch();
  service.watchStatus.set(input.id, "armed");
} catch (err) {
  if (err instanceof WatcherUnavailableError)
    return ragErr("RAG_WATCHER_UNAVAILABLE", err.message);
  throw err;
}
```

## B. Level-up Alternative — `RagController` class owning all state

Wrap service state + tool functions in `class RagController` and
have builtins consume `controller.toolDefs` / `controller.dispatch`.
Pros: easier mutex/rollback unit testing in one object. Cons: more
structure than the seven-tool adapter needs; obscures the
straight-line builtins flow. Rejected.

## C. Chosen Direction

A. Single `rag` service registered through `registerBuiltinServices`
with a focused options field; switch-based handler; non-queueing
mutex; raw-JSON `saveSaivageConfig` with classified persist
failures; walker hardening in `src/rag/walker.ts` with a single
log call.

## D. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Concurrent persistence writes from a misconfigured second runtime | Saivage runs at most one server per project; out of scope. |
| Walker realpath syscall overhead | One `realpath` per traversal entry; acceptable for ≤ 100k files. |
| `RAG_PERSIST_FAILED` on rollback leaves in-memory state mutated | Rollback path explicitly reverses the in-memory mutation before rethrow. |
| Mutex never releases on synchronous throw | `tryRunExclusive` uses `Promise.resolve().then(fn)` semantics via `.finally`; tested. |

## E. Test Strategy

- Unit: schema validation; envelope shape; error mapping (every
  class + `SaivagePersistError`); containment helper; mutex
  release on throw.
- Integration: walker symlink-escape fixture; register persist
  rollback (writeFile fails on tmp path); mutex contention; watch
  pre-check vs `WatcherUnavailableError`.
- E2E: in-process `RagManager` + temp project; full
  `rag_register → rag_ingest → rag_query → rag_drop` under
  operator and admin-role contexts.

## F. Out of Scope (FUPs)

- **FUP-WATCHER-LOG**: structured logger seam.
- **FUP-RAG-SYMLINK**: canonical home for walker symlink containment
  is §A.6.
- **FUP-INGEST-PATHS**: per-path secret info on `IngestReport`.
