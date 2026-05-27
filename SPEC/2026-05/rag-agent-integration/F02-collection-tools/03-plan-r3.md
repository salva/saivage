# F02 — Implementation Plan

Implementation order honours `F02 → F01 → F03`. Each batch ends
with a validation step run from `/home/salva/g/ml/saivage` with
`export PATH=~/.local/node-24/bin:$PATH`. Refers to the approved
design at
[02-design-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F02-collection-tools/02-design-r6.md).

## Batches

### B01 — Persistence helper

Scope:
- Create `src/server/rag/persist.ts` exporting `SaivagePersistError` and `saveSaivageConfig(projectRoot, mutate)` (raw-JSON read/validate/write; no env interpolation; atomic temp+rename; stage-classified errors).
- Re-export both symbols from `src/config.ts`.
- Unit tests in `src/server/rag/persist.test.ts`: missing-file create; validate-fail (read/write stage classification); concurrent temp-file cleanup on write failure.

Validation:
```bash
npm run typecheck \
  && npx eslint src/server/rag/persist.ts src/server/rag/persist.test.ts src/config.ts \
  && npm test -- server/rag/persist
```

Commit: `F02(B01): saveSaivageConfig + SaivagePersistError in src/server/rag/persist.ts`.

### B02 — Walker hardening

Scope:
- Compute `rootReal = await fs.realpath(root)` once at `walk()` entry in [src/rag/walker.ts](src/rag/walker.ts#L55-L69).
- Per-entry: compute `realAbs = await fs.realpath(abs)`; if `path.relative(rootReal, realAbs)` starts with `..` or is absolute, log `log.warn("rag.walker.symlink-escape " + JSON.stringify({ root, path }))` and `continue`.
- Add fixture-based tests for a symlink that points outside the root and one that points to a sibling within the root.

Validation:
```bash
npm run typecheck \
  && npx eslint src/rag/walker.ts src/rag/walker.test.ts \
  && npm test -- rag/walker
```

Commit: `F02(B02): walker silently skips symlink escapes`.

### B03 — `ToolCallContext.operatorContext` field

Scope:
- Extend `ToolCallContext` ([src/mcp/toolContext.ts](src/mcp/toolContext.ts#L17-L34)) with optional `operatorContext?: boolean`.
- Identify and patch the operator-driven call site (the CLI entry that builds the bootstrap-time `ToolCallContext` in `src/server/cli.ts` and `src/server/cli-actions.ts` for operator HTTP/Slash flows) to set `operatorContext: true` only there.
- Audit non-operator builders in `src/runtime/dispatcher.ts` and `src/agents/chat.ts`; assert they leave `operatorContext` unset.
- Tests: operator builder sets flag; dispatcher/chat builders do not.

Validation:
```bash
npm run typecheck \
  && npx eslint src/mcp/toolContext.ts src/runtime/dispatcher.ts src/agents/chat.ts src/server/cli.ts src/server/cli-actions.ts \
  && npm test -- mcp/toolContext runtime/dispatcher agents/chat
```

Commit: `F02(B03): operatorContext field set only by CLI/server operator paths`.

### B04 — `RagService` skeleton

Scope:
- Create `src/server/rag/service.ts` (RagService, RAG_TOOLS, requiresAdminRole, requiresControlMutex, isRuntimeOperatorContext, RuntimeRagDatasetConfig).
- Create `src/server/rag/envelope.ts` (ragOk / ragErr).
- Create `src/server/rag/errors.ts` (mapRagError; canonical RAG_* codes; SaivagePersistError → RAG_PERSIST_FAILED).
- Create `src/server/rag/mutex.ts` (`tryRunExclusive` with sync-throw safe release via `Promise.resolve().then(fn).finally(...)`).
- Unit tests for mapRagError (every class), mutex (sync + async throw release), envelope.

Validation:
```bash
npm run typecheck \
  && npx eslint src/server/rag/ \
  && npm test -- server/rag/service server/rag/errors server/rag/mutex server/rag/envelope
```

Commit: `F02(B04): RagService skeleton, mapRagError, mutex`.

### B05 — Tool implementations

Scope:
- Create `src/server/rag/tools/{list,stats,query,register,ingest,drop,admin}.ts` per design §A.5, §A.9.
- `rag_register` and `rag_drop`: config-first persist → manager call → best-effort config rollback on manager failure.
- `rag_admin`: covers `watch_arm`, `watch_disarm`, `reconcile`. `watch_arm` flow per design §A.9 — pre-check `dataset.config.watch === false` → `RAG_WATCH_DISABLED`; awaited `manager.get(id)` throws `DatasetNotFoundError` → `RAG_DATASET_NOT_FOUND`; `dataset.watch()` failure with `WatcherUnavailableError` → `RAG_WATCHER_UNAVAILABLE`; success → `watchStatus.set(id, "armed")`.
- Per-tool unit tests with mocked `RagManager` covering each envelope code listed above and successful path.

Validation:
```bash
npm run typecheck \
  && npx eslint src/server/rag/tools/ \
  && npm test -- server/rag/tools
```

Commit: `F02(B05): rag_* tool implementations`.

### B06 — Handler + builtins wiring

Scope:
- Create `src/server/rag/handler.ts` (`makeRagHandler`, `RAG_TOOL_DEFINITIONS`, `TOOL_SCHEMAS`, `TOOL_IMPL`).
- Extend `BuiltinServicesOptions` in [src/mcp/builtins.ts](src/mcp/builtins.ts#L1912-L1966) with `rag?: RagService`; when provided, `runtime.registerInProcess("rag", RAG_TOOL_DEFINITIONS, makeRagHandler(opts.rag), { available: true })`.
- Integration tests: `RAG_DISABLED` when `service.enabled=false`; `RAG_UNAUTHORIZED_ROLE` when role lacks admin & not operator; operator bypass; mutex contention → `RAG_CONTROL_BUSY`.

Validation:
```bash
npm run typecheck \
  && npx eslint src/server/rag/handler.ts src/mcp/builtins.ts \
  && npm test -- server/rag/handler mcp/builtins
```

Commit: `F02(B06): wire rag service through registerBuiltinServices`.

### B07 — Bootstrap construction

Scope:
- In [src/server/bootstrap.ts](src/server/bootstrap.ts#L133-L151), construct `ragDatasets`, `manager` (via `createRagManager` with full options including `projectId: project.config.project_name` and `enabled`), and `ragService`; share `ragDatasets` array reference with both.
- Pass `ragService` through `registerBuiltinServices(..., { rag: ragService })`.
- Propagate `ragService` into the agent-construction switch closure for F03 consumption.
- Bootstrap smoke test: temp project with `rag.enabled = false` → service registered as available; first `rag_list` call returns `RAG_DISABLED`.

Validation:
```bash
npm run typecheck \
  && npx eslint src/server/bootstrap.ts \
  && npm test -- server/bootstrap
```

Commit: `F02(B07): bootstrap constructs and wires RagService`.

### B08 — E2E + full validation

Scope:
- E2E in `src/server/rag/e2e.test.ts`: in-process `RagManager` + temp project; full `rag_register → rag_ingest → rag_query → rag_drop` under both operator and admin-role contexts.
- Full repo validation:

```bash
npm run typecheck \
  && npm test \
  && npx eslint src/server/rag/ src/rag/walker.ts src/config.ts src/mcp/builtins.ts src/mcp/toolContext.ts src/server/bootstrap.ts
```

Commit: `F02(B08): e2e + full validation`.

## Risks

- `loadConfig` callers must not regress; `saveSaivageConfig` reads raw JSON independently of `loadConfig`.
- Builtins registration order: `rag` registers at end of `registerBuiltinServices`; no caller depends on it earlier.
- Operator-context source sites are explicitly audited in B03 to prevent silent admin bypass through non-operator paths.
