# F02 Collection Tools Analysis R4 Review

## Summary

R4 fixes the largest R3 regressions: it keeps the `rag` service available so handlers can return `RAG_DISABLED`, adds mutating/admin tools to the worker deny-list, constrains `rag_register.sources` to one source root, removes unsupported watcher logger wiring, and keeps the public `src/rag/` API unchanged. I still cannot approve it. The remaining issues are not cosmetic: write/admin authorization is described as a filter-only property even though the dispatcher executes registered tool names from the unfiltered runtime catalog, `rag_ingest` can still destructively purge a collection by accepting an arbitrary root, and the path boundary story misses the current walker's symlink-out behavior.

## Confirmed Facts

1. `McpRuntime.registerInProcess(..., { available: false })` prevents handler execution. `callTool()` checks `!inProc.available` and throws before invoking `inProc.handler(...)` [src/mcp/runtime.ts](src/mcp/runtime.ts#L153-L184). R4's conclusion that `rag` must stay available for typed `RAG_DISABLED` envelopes is correct.

2. `WORKER_EXCLUDED_TOOLS` is a deny-list and the worker predicate is exactly `(n) => !WORKER_EXCLUDED_TOOLS.has(n)` [src/agents/tool-filters.ts](src/agents/tool-filters.ts#L24-L34). R4 correctly requires adding `rag_register`, `rag_ingest`, `rag_drop`, and `rag_admin` to that set.

3. `runIngest()` has full-snapshot semantics for the supplied input. It builds `seenPaths` from current input items [src/rag/pipeline.ts](src/rag/pipeline.ts#L177-L188), then deletes every prior `file_state` path absent from that set [src/rag/pipeline.ts](src/rag/pipeline.ts#L276-L288).

4. `WatcherController.reconcile()` does not call ingest when `changedPaths` is empty, even if `removedPaths` is non-empty. The implementation checks `changedPaths.concat(removedPaths)` only for the early return, but the ingest loop filters roots using `result.changedPaths` and skips every root with no changed paths [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L81-L93).

5. `Dataset.watch()` throws a plain `Error` when `watch` is false or omitted [src/rag/dataset.ts](src/rag/dataset.ts#L149-L153). R4 is right that `RAG_WATCH_DISABLED` must come from a handler pre-check.

6. `RagManagerOptions` includes `projectRoot`, `projectId`, `enabled`, `datasets`, and optional `providerOptions`, with no watcher logger field [src/rag/manager.ts](src/rag/manager.ts#L34-L40). `DatasetOpenOptions` likewise exposes only optional `providerOptions` [src/rag/dataset.ts](src/rag/dataset.ts#L59-L61).

7. A single stable root is necessary for non-destructive `fs` snapshot ingest through the current public API, because `IngestInput` accepts one `fs` root per call [src/rag/types.ts](src/rag/types.ts#L120-L126). R4 has not yet made that root stable across `rag_ingest`; see finding 2.

## Findings

1. Write/admin authorization is not source-enforced, so "unreachable from every existing role" is too strong.

   Sections 1.3 and 3.1 say the mutating/admin tools are unreachable from every existing role once they are added to `WORKER_EXCLUDED_TOOLS` and omitted from allow-lists [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L57-L64), [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L145-L164). The actual filter is only applied while building the tool schema list for an agent prompt [src/agents/base.ts](src/agents/base.ts#L662-L668). When a tool call is executed, the dispatcher looks up the name in the unfiltered `mcpRuntime.getAllTools()` catalog and calls `mcpRuntime.callTool(...)` directly [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L156-L194). That means the filter is a presentation boundary, not an enforcement boundary. If the analysis wants to claim no existing role can perform write/admin RAG operations, `src/mcp/rag.ts` must enforce role authorization from `ToolCallContext` for `rag_register`, `rag_ingest`, `rag_drop`, and `rag_admin`, or the dispatcher must be changed to re-apply `applyToolFilter` before execution.

   The same section also misstates which roles use the worker deny-list: `manager`, `coder`, `researcher`, `data_agent`, and `designer` use `toolFilter: "worker"`, but `critic` uses the reviewer allow-list [src/agents/roster.ts](src/agents/roster.ts#L87-L92), [src/agents/roster.ts](src/agents/roster.ts#L107-L168), [src/agents/roster.ts](src/agents/roster.ts#L229-L266). Correct the role list when describing the deny-list blast radius.

2. The one-root rule is necessary but not sufficient because `rag_ingest` accepts any root.

   R4 constrains `rag_register.sources` to a one-element tuple [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L249-L292), but `rag_ingest` still takes `source.root` from the caller and passes it straight to `manager.ingest(id, { kind: "fs", ...source })` after only project-root and `shouldSkipPath` validation [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L303-L315). The pipeline stores `fs` paths relative to the root used for that call [src/rag/pipeline.ts](src/rag/pipeline.ts#L72-L84), then deletes all prior paths not seen in the current call [src/rag/pipeline.ts](src/rag/pipeline.ts#L276-L288). A `rag_ingest` over a subdirectory, sibling directory, or the project root instead of the registered source root can therefore purge unrelated chunks from the same collection. To make the snapshot semantics non-destructive, `rag_ingest` must either derive the root from `dataset.config.sources[0]` and remove caller choice, or reject any caller root whose resolved identity is not the configured sole root.

3. The path traversal boundary misses symlink escape through the current RAG walker.

   Sections 1.6 and 9 say every path argument is resolved under `ctx.projectRoot` and passed through `shouldSkipPath` [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L112-L115), [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L467-L473). That is not enough for the existing ingest path. `shouldSkipPath()` is a secret-path predicate, not a containment check [src/rag/security/secrets.ts](src/rag/security/secrets.ts#L59-L64), and the walker explicitly follows symlinks that point outside the root [src/rag/walker.ts](src/rag/walker.ts#L6-L10). During traversal it computes a relative display path, applies `shouldSkipPath(rel)`, then calls `fs.stat(abs)` which follows symlinks and recurses into directories [src/rag/walker.ts](src/rag/walker.ts#L55-L69). A source root inside the project can therefore ingest files reachable through a symlinked directory outside the project. R4 needs an OWASP-grade boundary statement and implementation requirement: realpath-contain the root and reject or preflight symlinked descendants before calling the public RAG ingest API, or explicitly mark this as a required RAG-layer security fix instead of claiming F02's handler checks close the boundary.

4. The service-construction snippet would pass a `Promise<RagManager>` as the manager.

   Section 6 shows `const ragManager = createRagManager({ ... })` without `await` [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L390-L408). The actual factory is `async` and returns `Promise<RagManager>` [src/rag/manager.ts](src/rag/manager.ts#L87-L88). The bootstrap function is already async, so the analysis should require `const ragManager = await createRagManager(...)`. While touching this section, fix the wording in Section 1.4: `providerOptions` is optional, not required [src/rag/manager.ts](src/rag/manager.ts#L34-L40). Also either add the proposed `resolveOpenAIProviderOptions(...)` helper to the file inventory or describe it as an implementation detail to be created; the current public provider options are only raw OpenAI options such as `apiKey`, `baseUrl`, `client`, `batchSize`, and retry settings [src/rag/provider/index.ts](src/rag/provider/index.ts#L22-L34).

5. Watcher error propagation is described inaccurately.

   Sections 1.7 and 4.4 say `WatcherUnavailableError` is not observable through the public API and that chokidar arm failures surface only as `RAG_INTERNAL` [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L119-L128), [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L295-L299). The source exports `WatcherUnavailableError` from the public RAG barrel [src/rag/index.ts](src/rag/index.ts#L1-L14), and `WatcherController.arm()` throws it synchronously when `chokidar.watch(...)` throws [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L130-L140). What is not observable is the later async `ENOSPC` event, which only logs and flips `armed` false inside the event handler [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L142-L153). R4 can still choose to fold synchronous `WatcherUnavailableError` into `RAG_INTERNAL`, but it must state that as an explicit mapping choice, not as an API visibility limitation.

6. The reconcile explanation has the right behavior but the wrong mechanism.

   Section 1.5 says `WatcherController.reconcile()` "short-circuits when `changedPaths` is empty, even if `removedPaths` is non-empty" [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L104-L107). The actual early return is based on `changedPaths.concat(removedPaths)`, so a deletion-only result does not take that early return [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L81-L84). It still does not ingest because the per-root loop filters only `result.changedPaths` and continues when there are none [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L87-L93). The document should preserve the conclusion but fix the line-level explanation.

7. The MCP error-envelope fact overgeneralizes existing handlers.

   Section 1.1 says existing handlers use `{ content: { error: { code, message, details? } }, isError: true }` [SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md](SPEC/2026-05/rag-agent-integration/F02-collection-tools/01-analysis-r4.md#L11-L17). Some knowledge handlers do use typed error objects [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L166-L171), but many built-ins and stubs return string-shaped `error` values [src/mcp/builtins.ts](src/mcp/builtins.ts#L1876-L1885), [src/mcp/builtins.ts](src/mcp/builtins.ts#L1936-L1940). The accurate source fact is that `McpRuntime.callTool()` JSON-wraps whatever `result.content` the handler returns when `isError` is true [src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L193). R4 should say the RAG service will use the typed envelope, not that all existing handlers already do.

## Required Changes

1. Update Sections 1.3, 3.1, and 3.2 to distinguish tool-schema filtering from source-enforced authorization. Add handler-side role checks for `rag_register`, `rag_ingest`, `rag_drop`, and `rag_admin`, or require dispatcher-level enforcement, and correct the worker-filter role list against [src/agents/roster.ts](src/agents/roster.ts#L87-L266), [src/agents/base.ts](src/agents/base.ts#L662-L668), and [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L156-L194).

2. Update Sections 1.5, 4.4, 4.5, 7.3, and 9 so the configured single source root is also the only root `rag_ingest` may use. Tie the rule to the one-root `IngestInput` shape and deletion loop in [src/rag/types.ts](src/rag/types.ts#L120-L126) and [src/rag/pipeline.ts](src/rag/pipeline.ts#L177-L288).

3. Update Sections 1.6, 4.4, 4.5, and 9 with an explicit symlink/realpath containment requirement, or mark the current walker behavior as an unresolved security blocker. Ground the change in [src/rag/walker.ts](src/rag/walker.ts#L6-L10) and [src/rag/walker.ts](src/rag/walker.ts#L55-L69).

4. Update Sections 1.4, 6, and 10 so service construction awaits `createRagManager`, treats `providerOptions` as optional, and inventories any new provider-options resolver. Cite [src/rag/manager.ts](src/rag/manager.ts#L34-L40), [src/rag/manager.ts](src/rag/manager.ts#L87-L88), and [src/rag/provider/index.ts](src/rag/provider/index.ts#L22-L34).

5. Update Sections 1.7, 4.4, 4.7, and 5 to accurately distinguish plain watch-disabled `Error`, synchronous exported `WatcherUnavailableError`, and async ENOSPC logging. Cite [src/rag/dataset.ts](src/rag/dataset.ts#L149-L153), [src/rag/index.ts](src/rag/index.ts#L1-L14), and [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L130-L153).

6. Update Sections 1.5 and 4.7 to fix the reconcile mechanism wording while preserving the correct conclusion that deletion-only reconcile does not call ingest. Cite [src/rag/watcher/controller.ts](src/rag/watcher/controller.ts#L81-L93).

7. Update Section 1.1 to stop claiming all existing in-process handlers use typed error envelopes; state that F02's RAG handler will use the typed envelope and that runtime wraps arbitrary handler content on `isError`. Cite [src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L193), [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L166-L171), and [src/mcp/builtins.ts](src/mcp/builtins.ts#L1876-L1885).

VERDICT: CHANGES_REQUESTED