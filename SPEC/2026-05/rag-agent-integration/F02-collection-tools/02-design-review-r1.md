# F02 Collection Tools Design Review R1

Reviewed `02-design-r1.md` against approved `01-analysis-r7.md` and the current source under `src/`, focusing on module boundaries, `RagService`, `registerRagService`, the switch handler, mutex, `mapRagError`, walker hardening, and `saveSaivageConfig`.

## Findings

1. `saveSaivageConfig` is not safe or classifiable as designed. The design's implementation calls `loadConfig(projectRoot)` and writes the parsed result back to `configPath(projectRoot)` (`02-design-r1.md` §A.6), but the real `loadConfig` path interpolates environment variables before parsing (`src/config.ts` `deepInterpolate` / `loadConfig`), and provider accounts explicitly allow `apiKey` fields. A persist operation could therefore materialize env-substituted credential values into `.saivage/saivage.json` and also churn the file with schema defaults. The design also says generic write/parse errors "bubble to the handler -> `RAG_PERSIST_FAILED`", but `mapRagError` only maps RAG error classes; a bare filesystem or Zod error will become `RAG_INTERNAL`. This conflicts with the approved `RAG_PERSIST_FAILED` and rollback contract in `01-analysis-r7.md` §§5, 7.3. Required fix: make `saveSaivageConfig` read the raw JSON file without env interpolation, validate a merged candidate with `SaivageConfigSchema`, write via a unique temp file in the config directory, and either throw a dedicated persist error or have register/drop catch persistence failures explicitly and return `RAG_PERSIST_FAILED` with rollback details.

2. `mapRagError` omits a required public RAG error and relies on the wrong watch-disabled path. The design says to switch on eight RAG error classes plus the message-prefixed plain `Error` from `Dataset.watch()`. The current public barrel exports `WatcherUnavailableError`, `WatcherController.arm()` throws it synchronously, and the approved analysis requires it to map to `RAG_WATCHER_UNAVAILABLE`. `Dataset.watch()` does throw a plain "watch is disabled" error, but the analysis requires the handler to pre-check `dataset.config.watch` and return `RAG_WATCH_DISABLED` before calling `watch()`. Required fix: enumerate all current non-base RAG error classes, including `WatcherUnavailableError`; keep watch-disabled handling in the `rag_admin watch_arm` pre-check rather than message-prefix classification; and describe how `RAG_SECRET_DROPPED` remains reserved if `SecretDroppedError` is never emitted by F02.

3. The control mutex is not implementable from the current source as specified. `RagService.controlMutex: Mutex` and `tryAcquire` are named in the design, but the repository has no mutex helper or `async-mutex` dependency; `package.json` only has the existing `proper-lockfile` dependency for dataset ingest locks. The approved analysis does require `RAG_CONTROL_BUSY`, so this cannot stay abstract. Required fix: add a concrete local control gate, for example `src/server/rag/mutex.ts` with a non-queueing `tryRunExclusive(fn)` / `tryAcquire()` API, or explicitly add and justify a dependency. The design should state release semantics for `finally` paths and tests for contention.

4. The registration boundary conflicts with the approved integration point. The design introduces `registerRagService(runtime, service)` in `src/server/rag/handler.ts` and has it call `runtime.registerInProcess(...)` directly. The approved analysis says `registerBuiltinServices` gains a fourth options field `rag: RagService` and registers the `rag` service there; the current source has `BuiltinServicesOptions` with only `webSearchEndpoint`, `bootstrap.ts` calls `registerBuiltinServices(mcpRuntime, config.mcp, config.security)`, and built-ins own the in-process service registration cluster. Required fix: either make `registerRagService` a small helper that `src/mcp/builtins.ts` calls when `options.rag` is present, or revise the approved integration story explicitly. As written, the chosen direction claims it matches builtins convention while bypassing the builtins registration boundary.

5. The walker hardening location and containment predicate are mostly right, but the implementation snippet still does not compile against `src/log.ts`. All fs ingest paths go through `walk()` (`runIngest` / `loadFsItems`, plus watcher reconcile), and the `path.relative(rootReal, realAbs)` containment check matches the analysis. However, the snippet calls `log.warn("rag.walker.symlink-escape", JSON.stringify(...))`, while `src/log.ts` exposes `warn(msg: string)` only. Required fix: make the snippet a single string such as `log.warn("rag.walker.symlink-escape " + JSON.stringify({ root: rootReal, path: realAbs }))`, and mention that `rootReal` is computed once from `fs.realpath(root)` before recursion.

## Confirmations

- The core `RagService` data shape is realistic: `RagManagerOptions.datasets` is a readonly view of an array, and `manager.get()` resolves datasets from that same array, so keeping a mutable `RuntimeRagDatasetConfig[]` in the service is source-aligned.
- A single `rag` service with a switch-based handler is consistent with the existing large in-process handlers and with the approved seven-tool surface.
- Keeping `register`, `drop`, and all `admin` actions under the control mutex while leaving `query`, `list`, `stats`, and `ingest` outside it matches the approved data-plane/control-plane split, once the mutex implementation is made concrete.
- The walker hardening belongs in private RAG internals and does not need a public RAG API change.

## Focused Proposal

Keep the design's single-service, switch-handler architecture, but revise R1 before implementation:

- move actual rag registration through `registerBuiltinServices(..., { rag })`, with `registerRagService` only as a helper if desired;
- define a local non-queueing mutex/control gate and wire contention to `RAG_CONTROL_BUSY`;
- implement persistence as raw JSON read/validate/write, never through interpolating `loadConfig`, and classify persistence/rollback failures explicitly;
- map `WatcherUnavailableError` and keep `RAG_WATCH_DISABLED` as a handler pre-check;
- fix the walker log call to the current one-string logger API.

## Level-Up Alternative

Split the server-side RAG adapter into an explicit `RagController` class that owns the service state, mutex, persistence helpers, and tool functions, while `builtins.ts` only adapts `controller.tools` and `controller.handleToolCall` into `registerInProcess`. This would make rollback and contention state easier to test as one unit, but it is more structure than F02 needs and risks obscuring the straightforward seven-tool adapter.

## Chosen Direction

Stay with the focused proposal: one `rag` in-process service, a switch-based handler, per-tool implementation files, private walker hardening, and builtins-mediated registration. Request changes to R1 for the source conflicts above before approving the design.

VERDICT: CHANGES_REQUESTED