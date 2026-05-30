# F02 — Agent-Facing RAG Collection Tools: Design

This design crystallises module boundaries, the `RagService` shape,
the handler organisation, the control mutex, persistence ordering,
error mapping, and walker hardening for the seven-tool `rag`
surface specified in
[01-analysis-r7.md](saivage/SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r7.md).

## A. Focused Proposal — `rag` service registered by builtins, switch-based handler

### A.1 Modules

```
src/server/rag/
├── service.ts          // RagService, RAG_TOOLS, requiresAdminRole, requiresControlMutex, isRuntimeOperatorContext
├── handler.ts          // makeRagHandler(service) used by builtins.ts
├── envelope.ts         // ragOk(content) / ragErr(code, message, details?)
├── errors.ts           // mapRagError(err)
├── mutex.ts            // tryRunExclusive(state, fn)
├── persist.ts          // SaivagePersistError + saveSaivageConfig (raw JSON, atomic)
└── tools/
    ├── list.ts  stats.ts  query.ts
    ├── register.ts  ingest.ts  drop.ts  admin.ts
```

`saveSaivageConfig` and `SaivagePersistError` are exported from
[src/config.ts](src/config.ts) (implementation in
`src/server/rag/persist.ts`, re-exported from `config.ts`).

### A.2 `RagService` shape

```ts
export type RuntimeRagDatasetConfig = Omit<DatasetConfig, "projectId">;

export interface RagService {
  manager: RagManager;
  datasets: RuntimeRagDatasetConfig[];          // shared array
  watchStatus: Map<string, "off" | "armed">;
  adminRoles: Set<AgentRole>;                   // F03 adds "librarian"
  control: { busy: boolean };
  enabled: boolean;
  projectRoot: string;
}

export const RAG_TOOLS = [
  "rag_list","rag_stats","rag_query",
  "rag_register","rag_ingest","rag_drop","rag_admin",
] as const;

// Authorization scope — operator OR admin-role bypass needed.
const ADMIN_ROLE_TOOLS = new Set<string>(["rag_register","rag_ingest","rag_drop","rag_admin"]);
export const requiresAdminRole = (n: string) => ADMIN_ROLE_TOOLS.has(n);

// Control-mutex scope — single-flight serialisation.
// `rag_ingest` is NOT here: same-dataset concurrent ingest is already
// serialised by RagManager's per-dataset ingest lock and surfaces as
// RAG_INGEST_LOCKED; unrelated dataset ingests must run in parallel.
const CONTROL_TOOLS = new Set<string>(["rag_register","rag_drop","rag_admin"]);
export const requiresControlMutex = (n: string) => CONTROL_TOOLS.has(n);

export function isRuntimeOperatorContext(ctx: ToolCallContext): boolean {
  return ctx.operatorContext === true;
}
```

`ToolCallContext` in
[src/mcp/toolContext.ts](src/mcp/toolContext.ts#L17-L34) is
extended with `operatorContext?: boolean`, set only by the
CLI/server runtime construction path.

### A.3 Handler

```ts
export function makeRagHandler(service: RagService) {
  return async (toolName: string, args: unknown, ctx: ToolCallContext) => {
    log.info(`rag.call ${JSON.stringify({ tool: toolName, role: ctx.role, agentId: ctx.agentId })}`);

    if (!service.enabled) return ragErr("RAG_DISABLED", "rag is disabled");

    if (requiresAdminRole(toolName)
        && !isRuntimeOperatorContext(ctx)
        && !service.adminRoles.has(ctx.role)) {
      return ragErr("RAG_UNAUTHORIZED_ROLE", `role=${ctx.role} cannot ${toolName}`);
    }

    const schema = TOOL_SCHEMAS[toolName];
    if (!schema) return ragErr("RAG_INTERNAL", `unknown tool ${toolName}`);
    const parsed = schema.safeParse(args);
    if (!parsed.success) return ragErr("RAG_INVALID_ARGS", parsed.error.message,
                                       { issues: parsed.error.issues });

    const fn = TOOL_IMPL[toolName];
    try {
      if (requiresControlMutex(toolName)) {
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
classes from [src/rag/errors.ts](src/rag/errors.ts#L3-L116) to the
canonical codes from analysis §5:

| Source class | Envelope code |
|---|---|
| `DatasetNotFoundError` | `RAG_DATASET_NOT_FOUND` |
| `ProviderUnavailableError` | `RAG_PROVIDER_UNAVAILABLE` |
| `EmbeddingDriftError` | `RAG_EMBEDDING_DRIFT` |
| `ConfigDriftError` | `RAG_CONFIG_DRIFT` |
| `CorruptedStoreError` | `RAG_CORRUPTED_STORE` |
| `IngestLockedError` | `RAG_INGEST_LOCKED` |
| `WatcherUnavailableError` | `RAG_WATCHER_UNAVAILABLE` |
| `InvalidQueryFilterError` | `RAG_INVALID_QUERY_FILTER` |
| `SaivagePersistError` | `RAG_PERSIST_FAILED` (details carry `stage`) |
| anything else | `RAG_INTERNAL` |

`RAG_WATCH_DISABLED` is produced exclusively by the `rag_admin
watch_arm` pre-check (see §A.8), never via `mapRagError`.
`RAG_SECRET_DROPPED` is reserved.

### A.4 Control mutex

```ts
// src/server/rag/mutex.ts
export function tryRunExclusive<T>(
  state: { busy: boolean },
  fn: () => Promise<T>,
): { ok: true; value: Promise<T> } | { ok: false } {
  if (state.busy) return { ok: false };
  state.busy = true;
  // Wrap in Promise.resolve().then so a synchronous throw inside `fn`
  // still releases the busy flag via .finally.
  const value = Promise.resolve().then(fn).finally(() => { state.busy = false; });
  return { ok: true, value };
}
```

Tests in `mutex.test.ts` cover: two concurrent control calls →
second returns `{ ok: false }`; a sync throw inside `fn` still
releases `busy`; an async rejection inside `fn` still releases
`busy`. No new npm dependency.

### A.5 Persistence ordering (`rag_register` and `rag_drop`)

Both flows obey analysis §§4.4, 4.6, 7.3: **config first, no
manager side-effects if persistence fails; best-effort config
rollback if a later manager call fails.**

`rag_register`:

```ts
// 1. Acquire control mutex (handler).
// 2. Persist config FIRST:
const before = currentDatasetsSnapshot(service);
try {
  await saveSaivageConfig(service.projectRoot, (cfg) => ({
    ...cfg,
    rag: { ...cfg.rag, datasets: [...cfg.rag.datasets, serialiseDataset(input)] },
  }));
} catch (err) {
  throw err;   // RAG_PERSIST_FAILED via mapRagError; manager untouched.
}
// 3. Register with manager (writes registry + opens store).
let registered: Dataset;
try {
  registered = await service.manager.register(input);
} catch (err) {
  // best-effort config rollback
  await saveSaivageConfig(service.projectRoot, (cfg) => ({
    ...cfg, rag: { ...cfg.rag, datasets: before },
  })).catch((rb) => log.warn("rag.register.rollback-failed " + JSON.stringify({ err: (rb as Error).message })));
  throw err;
}
// 4. Reflect into in-memory service state.
service.datasets.push(input);
service.watchStatus.set(input.id, "off");
```

`rag_drop` mirrors the same order:
1. Snapshot current `cfg.rag.datasets`.
2. `saveSaivageConfig(..., (cfg) => ({ ...cfg, rag: { ...cfg.rag,
   datasets: cfg.rag.datasets.filter(d => d.id !== id) }}))`.
3. `await service.manager.drop(id)` — on failure, rollback config to the snapshot.
4. Remove from `service.datasets` and `service.watchStatus`.

`RagManager` exposes `register(config)` and `drop(id)` per
[src/rag/manager.ts](src/rag/manager.ts#L46-L50); the design names
those exact methods.

### A.6 Persistence helper

```ts
// src/server/rag/persist.ts
export class SaivagePersistError extends Error {
  constructor(msg: string, public details: { stage: "read"|"validate"|"write" }) {
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
  } catch (err) { throw new SaivagePersistError((err as Error).message, { stage: "read" }); }

  let current: SaivageConfig;
  try { current = SaivageConfigSchema.parse(JSON.parse(rawText)); }      // no env interpolation
  catch (err) { throw new SaivagePersistError((err as Error).message, { stage: "validate" }); }

  let next: SaivageConfig;
  try { next = SaivageConfigSchema.parse(mutate(current)); }
  catch (err) { throw new SaivagePersistError((err as Error).message, { stage: "validate" }); }

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

The helper never calls `loadConfig`, so the env-interpolation path
at [src/config.ts](src/config.ts#L308-L319) is bypassed.

### A.7 Walker hardening

In `src/rag/walker.ts` (private; exported `WalkedFile[]` signature
preserved):

```ts
const rootReal = await fs.realpath(root);            // once, at walk() entry
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

`log.warn(msg: string)` in [src/log.ts](src/log.ts) accepts a
single string; payload is appended to the message.

### A.8 Registration and `available` flag

```ts
// src/mcp/builtins.ts — registerBuiltinServices
if (options.rag) {
  runtime.registerInProcess(
    "rag",
    RAG_TOOL_DEFINITIONS,
    makeRagHandler(options.rag),
    { available: true },                              // ALWAYS true
  );
}
```

The service is registered as available regardless of
`options.rag.enabled`. `available: false` would short-circuit in
[src/mcp/runtime.ts](src/mcp/runtime.ts#L153-L193) before the
handler runs, preventing the handler's `service.enabled` pre-check
from returning the contracted `RAG_DISABLED` envelope.

Server bootstrap
([src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151))
constructs the `RagManager` + `RagService` and passes it through:

```ts
const manager = await createRagManager({
  projectRoot,
  projectId: config.project.id,
  enabled: config.rag.enabled,
  datasets: config.rag.datasets,
  providerOptions,
});
const ragService: RagService = {
  manager, datasets: [...config.rag.datasets], watchStatus: new Map(),
  adminRoles: new Set(), control: { busy: false },
  enabled: config.rag.enabled, projectRoot,
};
registerBuiltinServices(mcpRuntime, mcpConfig, securityConfig, { rag: ragService });
```

`createRagManager` requires the full options bag from
[src/rag/manager.ts](src/rag/manager.ts#L34-L40): `projectId`,
`enabled`, `datasets`, and `providerOptions` in addition to
`projectRoot`. Calling it without `enabled` would silently return
the no-op manager.

### A.9 `rag_admin watch_arm` flow

```ts
let dataset: Dataset;
try {
  dataset = await service.manager.get(input.id);    // throws DatasetNotFoundError on miss
} catch (err) {
  if (err instanceof DatasetNotFoundError)
    return ragErr("RAG_DATASET_NOT_FOUND", input.id);
  throw err;
}
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

`manager.get(id)` is async and throws `DatasetNotFoundError` on
miss per
[src/rag/manager.ts](src/rag/manager.ts#L45). The same pattern is
used in `register`/`drop` flows; not-found is the only path that
produces `RAG_DATASET_NOT_FOUND`.

## B. Level-up Alternative — `RagController` class owning all state

Wrap service state + tool functions in a `RagController` class and
have builtins consume `controller.toolDefs` / `controller.dispatch`.
Pros: easier mutex/rollback unit testing in one object. Cons: more
structure than the seven-tool adapter needs. Rejected.

## C. Chosen Direction

A. Single `rag` service registered through `registerBuiltinServices`
with `available: true` and a focused options field; switch-based
handler with split admin-role / control-mutex scopes; mutex
implemented via `Promise.resolve().then(fn)` to catch sync throws;
config-first persist ordering with best-effort rollback;
canonical RAG_* error codes; walker hardening in
`src/rag/walker.ts` with a single log call.

## D. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Walker realpath syscall overhead | One `realpath` per traversal entry; acceptable for ≤ 100k files. |
| Rollback after manager failure also fails | Logged, not retried; subsequent register/drop with the same id surfaces `ConfigDriftError` from the manager. |
| Mutex never releases on synchronous throw | `Promise.resolve().then(fn).finally(...)` ensures release; tested. |
| `RAG_DISABLED` short-circuits via `available:false` | Service is registered with `available: true`; tested. |

## E. Test Strategy

- Unit: schema validation; envelope shape; error mapping (every
  class + `SaivagePersistError.stage`); containment helper; mutex
  release on sync and async throws.
- Integration: walker symlink-escape fixture; `rag_register`
  persist-then-manager rollback; `rag_register` manager-fail
  rollback; mutex contention; watch pre-check vs
  `WatcherUnavailableError`; `RAG_DISABLED` envelope when
  `config.rag.enabled === false`.
- E2E: in-process `RagManager` + temp project; full
  `rag_register → rag_ingest → rag_query → rag_drop` under both
  operator and admin-role contexts.

## F. Out of Scope (FUPs)

- **FUP-WATCHER-LOG**: structured logger seam.
- **FUP-RAG-SYMLINK**: canonical home for walker symlink containment
  is §A.7.
- **FUP-INGEST-PATHS**: per-path secret info on `IngestReport`.
