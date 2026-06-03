# Compatibility Debt Removal Plan

Status: executed. The sections below record the cleanup assessment and the
implementation choices made while removing the remaining transition seams.

This plan targets backward-compatibility code, transition bridges, unnecessary
adapter exports, temporary fallbacks, and dead code after the architecture
cleanup. The priority is simple, clean architecture and code. It is acceptable to
rewrite tests, prompts, UI callers, or thin layers when they exist only to
preserve obsolete behavior.

## Assessment Summary

The current codebase is much cleaner after the architecture phases, but several
intentional transition seams remain. They fall into three groups:

- **Remove now:** compatibility barrels, server helper re-exports, explicit
  project-root fallback for built-ins, unavailable-tool API support if no UI
  consumer exists.
- **Remove after direct caller update:** `/api/config.provider`, tests importing
  through old module locations, prompt/test final-response fallback assertions.
- **Remove after state verification:** legacy config-key rejection and legacy
  knowledge JSON-tree cleanup, because they protect old local project state.

Current useful architecture that should **not** be removed just because it is an
adapter layer:

- Server route modules. They are the current thin-transport architecture.
- `ProjectStore` plus `FileBrowserService`. They separate typed project state
  from operator file browsing.
- Stub-model test helpers, if moved out of runtime-facing source or kept clearly
  test-only.

## Removal Candidates

### 1. Final-Response Artifact Fallback

Files:

- `src/agents/worker.ts` — calls `parseTaskReport` fallback at line 240
- `src/agents/manager.ts` — calls private `parseStageSummary` fallback at line 99; prompt text at line 186 references "temporary fallback"
- `src/agents/task-report.ts` — defines and exports `parseTaskReport`, the Worker fallback parser
- `src/agents/task-report.test.ts` — tests for `parseTaskReport`
- `src/agents/compliance.ts` — `checkManagerCompletion` parses LLM text when `artifactResult` is missing; not fallback parsing itself, but validation logic that must be updated to treat missing artifacts as failures
- `src/agents/agents.test.ts` — asserts fallback warning logs

Current behavior:

- Worker and Manager prefer validated on-disk artifacts.
- If the expected artifact is missing, they still parse final response JSON as a
  temporary fallback and log a warning.
- The fallback currently short-circuits `validateFinalResponse`: it produces a
  "success" result from raw LLM text before compliance can reject the missing
  artifact. Removing it makes compliance the sole success/failure gate.
- The Manager prompt (line 186) explicitly says "Full StageSummary JSON in the
  final response is accepted only as a temporary fallback."

Why remove:

- This is explicit transition code from the old "final answer contains the full
  JSON artifact" workflow.
- Clean architecture should have one success boundary: validated artifact files.
- The repair-nudge path (`validateFinalResponse`/`compliance.ts`) already
  handles invalid artifacts; the bypass is what makes compliance ineffective
  for missing artifacts.

Plan:

1. Update Worker/Manager prompts to require writing the artifact and returning
   concise final text only. Remove "temporary fallback" language from the
   Manager prompt string in `manager.ts:186` (this is runtime code, not a doc).
2. Remove final-response JSON artifact parsing from Worker and Manager:
   - Remove `parseTaskReport` call and fallback branch from `worker.ts`.
   - Remove `parseStageSummary` function entirely from `manager.ts`.
   - Decide whether to deprecate/remove the `parseTaskReport` export from
     `task-report.ts` (it has its own tests in `task-report.test.ts`).
3. Make missing artifacts a first-class validation failure: use the existing
   repair-nudge path while retries remain, then return an explicit failure that
   explains the expected artifact path and reason it was not accepted.
4. Keep invalid artifacts on the current repair path, and ensure exhausted repair
   attempts fail rather than silently parsing final-response prose.
5. Update `checkManagerCompletion` in `compliance.ts`: when `artifactResult` is
   missing and no valid artifact exists, treat it as a repair-triggering
   violation rather than falling back to `parseLlmJsonAs` for the `result` field.
6. Rewrite tests that assert fallback warnings to assert repair/failure instead.
7. Remove fallback references from docs and prompt snapshots.
8. Before deletion, run at least one real or stubbed Manager/Worker loop that
   demonstrates valid on-disk `TaskReport` and `StageSummary` artifacts are
   written without relying on fallback parsing.

Risk: high. Agents or deployments that still return only final JSON, or that hit
operational write failures such as permissions/disk/path issues, will no longer
be converted into successful outcomes by fallback parsing. This cleanup should
not merge until artifact writes are verified end-to-end.

### 2. Built-Ins Compatibility Barrel Exports

Files:

- `src/mcp/builtins.ts`
- `src/mcp/index.ts` — re-exports `registerBuiltinServices` from `builtins.js` (not affected by removing barrel re-exports, but listed for completeness)
- `src/mcp/builtins.test.ts` — imports `classifyFsError`, `extractDdgResults`, `registerBuiltinServices` from barrel
- `src/mcp/shell-env.test.ts` — imports `filterShellEnv` from barrel
- `src/mcp/fsGuard.test.ts` — imports `registerBuiltinServices` from barrel
- `src/config.ts` — imports `WALL_CLOCK_HEADROOM_MS` from barrel (production code; cross-module dependency from config validation into MCP internals)
- `src/server/bootstrap.ts` — imports `registerBuiltinServices` from barrel (production code; unaffected since this symbol stays in `builtins.ts`)

Current behavior:

- `builtins.ts` is now mostly composition, but it re-exports internals:
  `classifyFsError`, `filterShellEnv`, `WALL_CLOCK_HEADROOM_MS`,
  `extractDdgResults`, and web types.
- `filterShellEnv` is intentionally exported from `builtins/shell.ts` as a thin
  wrapper over the implementation in `builtins/context.ts`, so tests should use
  the `shell.ts` helper surface unless the implementation is moved.

Why remove:

- These exports preserve old monolithic import paths after modularization.
- Tests and config can import from the leaf modules directly.

Plan:

1. Change `src/config.ts` to import `WALL_CLOCK_HEADROOM_MS` from
   `src/mcp/builtins/shell.ts`. This removes a cross-module dependency from
   core config validation into MCP internals; consider extracting the constant
   to a shared location (e.g., `src/mcp/builtins/limits.ts`) if the MCP
   dependency is undesirable.
2. Change tests to import helper functions from leaf modules:
   - `builtins/errors.ts`
   - `builtins/shell.ts`
   - `builtins/web.ts`
   Also update `src/mcp/fsGuard.test.ts` to import `registerBuiltinServices`
   from the barrel (it already does, but this is listed for completeness since
   `registerBuiltinServices` stays in `builtins.ts`).
3. Remove compatibility re-exports from `src/mcp/builtins.ts`.
4. Keep only `registerBuiltinServices` and its registration option types in
   `builtins.ts`.
5. Treat `WALL_CLOCK_HEADROOM_MS` as a deliberate cross-module constant. If
   importing it from `shell.ts` makes the leaf module too public, move it to a
   small `builtins/limits.ts` module instead of keeping the barrel export.

Risk: low. This is import churn only.

### 3. Server Helper Compatibility Exports

Files:

- `src/server/server.ts`
- `src/server/server.test.ts`
- `src/server/server.notes.test.ts`

Current behavior:

- `server.ts` re-exports helpers/read models/routes such as
  `isPathInside`, `isPathHiddenForFileRoot`, safe config/debug helpers, and
  `registerNotesRoutes` for tests.
- All production consumers (`safeConfigResponse`, `safeProvidersResponse`,
  `safeDebugStateResponse`, `safeProjectConfigView`, route modules) import
  directly from their origin modules, not through `server.ts`. The re-exports
  exist solely for test convenience.

Why remove:

- These are bridge exports after route/read-model extraction.
- Tests should import from the modules that own the behavior.

Plan:

1. Rewrite tests to import from:
   - `server/file-browser-service.ts`
   - `server/read-models/config.ts`
   - `server/read-models/debug.ts`
   - `server/routes/notes.ts`
2. Remove helper re-exports from `server.ts`.
3. Keep `startServer` and `ServerOptions` as the server public surface.

Risk: low. This affects internal tests and imports, not runtime behavior.

### 4. `/api/config.provider` Backward-Compatible Label

Files:

- `src/server/read-models/config.ts`
- `src/server/routes/config.ts`
- `src/server/server.test.ts`
- `src/server/routes/route-modules.test.ts`
- `web/src/components/PlanView.vue`
- `web/src/api/types.ts`

Current behavior:

- Safe config responses include a generic `provider` label for the planner model.
- Structured routing already exists under `routing.planner` and `routing.chat`.
- `routing.planner.provider`, `routing.planner.model`, chat-message provider
  metadata, and `/api/providers` provider names are current structured data and
  are not removal targets.

Why remove:

- The field is explicitly backward-compatible dashboard data.
- It duplicates structured routing.

Plan:

1. Update `PlanView.vue` to render `config.routing.planner.modelSpec` or a
   clearly named route display field.
2. Remove `provider` from web API config types where it represents safe config,
   not chat logs.
3. Remove `provider` from `SafeConfigResponse` and server tests.
4. Keep chat-log message provider fields; those are current per-message metadata,
   not this compatibility label.
5. Keep `SafeResolvedRoute.provider`, `SafeResolvedRoute.model`, and
   `SafeProvidersResponse.providers[].name`; those are not compatibility fields.

Risk: low-to-medium. Requires coordinated UI and server test updates.

### 5. Built-In Project Root Fallback

Files:

- `src/mcp/builtins/context.ts`
- tests calling `registerBuiltinServices(...)` without `options.project`

Current behavior:

- Production bootstrap passes `project` explicitly.
- Tests or direct callers can omit project and fall back to environment/current
  working directory.

Why remove:

- This is a compatibility bridge for old direct registration call shapes.
- Clean service factories should require explicit project context.

Plan:

1. Make `project` required in `registerBuiltinServices` options.
2. Update all tests and call sites to pass `{ project: { projectRoot } }`.
3. Make `project` required in `createBuiltinContext` options as well; this is
   the function that currently owns the fallback.
4. Remove `fallbackProjectRoot()`.
5. Ensure shell still injects `PROJECT_ROOT` into subprocess env from explicit
   context only.
6. Keep `DEFAULT_BUILTIN_SECURITY_CONTEXT` and `filterShellEnv` defaults; they
   are independent of project-root fallback and remain useful for tests and
   standalone env scrubbing.

Risk: low. Mostly test and call-site updates.

### 6. `McpRuntime` `available:false` Unavailable-Service Support

Files:

- `src/mcp/runtime.ts`
- `src/mcp/runtime.api.test.ts`
- `src/server/routes/config.ts`

Current behavior:

- `McpRuntime` can register in-process services with `available: false` and list
  them for API consumers.
- Retired unavailable built-in stubs have already been removed.
- The same flag also acts as a general feature gate: unavailable in-process
  tools are listed for API visibility, skipped from agent tool rosters, and hard
  rejected if called.

Why remove:

- It originally supported retired stub services, and no current built-in service
  registers with `available: false`.
- If the project does not want registered-but-disabled tools as an operator
  visibility feature, the flag is avoidable complexity.

Plan:

1. Confirm the web UI does not use unavailable tool rows.
2. Make an explicit product decision:
   - keep the feature gate if future services should be visible while disabled;
   - remove it if the runtime should expose callable tools only.
3. If keeping it, remove only test-only unavailable placeholders and document the
   intended feature-gate semantics.
4. If removing it, remove `available?: boolean` from registration, remove
   unavailable-call branches, simplify `getAllTools()` and `listAllToolsForApi()`
   to callable tools only, and rewrite runtime API tests accordingly.

Risk: medium. Risk is API/UI contract drift and loss of operator visibility for
future intentionally-disabled tools.

### 7. Legacy Config-Key Rejection

Files:

- `src/types.ts`
- `src/types.test.ts`

Current behavior:

- `ProjectConfigSchema` explicitly rejects legacy `model_overrides` with a custom
  migration error.
- The underlying Zod object schema strips unknown keys by default, so deleting
  this custom rejection would make `model_overrides` silently disappear unless
  strict unknown-key validation is added.

Why remove:

- This is transition code for an obsolete v1/pre-v2 config shape.
- Under the clean-v2 goal, old state may fail generically or require an external
  migration script.

Plan:

1. Verify active project `.saivage/config.json` files no longer contain
   `model_overrides` without printing secrets.
2. Decide the desired unknown-key behavior explicitly:
   - keep the targeted helpful rejection;
   - switch the whole config schema to strict unknown-key rejection;
   - or accept silent stripping for obsolete fields.
3. If silent stripping is not acceptable, do not remove this rejection unless a
   generic strict-key policy replaces it.
4. Remove `LEGACY_PROJECT_KEY` and custom preprocess rejection only after the
   chosen unknown-key policy is implemented.
5. Rewrite `types.test.ts` to cover current schema behavior.
6. If operator recovery is desired, add a one-shot admin migration note/script
   outside runtime validation.

Risk: medium. Removing targeted errors may make old config failures less helpful
or silently ignore obsolete operator intent.

### 8. Legacy Knowledge JSON-Tree Cleanup

Files:

- `src/knowledge/legacy.ts`
- `src/knowledge/init.ts`
- `src/knowledge/legacy.test.ts`
- `src/store/project.test.ts`
- docs under `docs/internals/knowledge/`

Current behavior:

- Runtime initialization removes/refuses old `.saivage/skills` and
  `.saivage/memory` JSON tree state depending on sidecar state.
- If markers exist and the sidecar is empty, startup hard-fails with
  `KNOWLEDGE_MIGRATION_REQUIRED` rather than booting with an empty knowledge
  store and stale legacy files.

Why remove:

- This is migration logic embedded in normal runtime startup.
- Clean runtime should assume the current sidecar storage model.
- However, the current behavior is also a startup safety check that prevents
  silent loss of legacy skill/memory state.

Plan:

1. Verify active projects no longer contain legacy JSON trees.
2. Choose a replacement safety path before deleting runtime refusal:
   - keep a startup assertion that fails when legacy markers coexist with an
     empty sidecar;
   - move the check to an explicit admin preflight command and require operators
     to run it before startup;
   - or intentionally accept stale legacy files being ignored.
3. If moving to an admin command, implement and document that command before
   removing `refuseOrCleanLegacyTree` from `knowledge/init.ts`.
4. Remove runtime startup call from `knowledge/init.ts` only after the chosen
   replacement path exists or after accepting the data-loss risk.
5. Rewrite/delete legacy knowledge tests to match the new safety policy.
6. Update docs to describe sidecar-only current storage and the legacy-state
   handling policy.

Risk: high until active state is verified. Removing the startup refusal without a
replacement can silently strand or ignore old local knowledge state.

### 9. Test-Only Stub Model Helper Location

Files:

- `src/agents/stub-model.ts`
- `src/server/prompt-tool-sequence.test.ts`
- `src/server/prompt-self-correction.test.ts`

Current behavior:

- Deterministic test helper lives under runtime source tree.

Why remove/simplify:

- It is not runtime code and should not be importable as agent source.

Plan:

1. Move `stub-model.ts` to one concrete test utility location. Prefer
   `tests/helpers/stub-model.ts` to avoid creating a new `src/test/` convention.
2. Update imports in prompt tests and adjust the helper's import of
   `ChatRequest`/`ChatResponse` to point back to `src/providers/types.ts`.
3. Verify Vitest includes the helper through normal test imports.
4. Ensure package exports do not include test helpers.

Risk: low.

### 10. Route Module Type Coupling Polish

Files:

- `src/server/routes/files.ts`
- `src/server/file-browser-service.ts`

Current behavior:

- File routes may type themselves against `FileBrowserService` methods.

Why candidate:

- This is not backward compatibility, but it is a small adapter-coupling smell.

Plan:

1. Define a route-local structural `FileReads` interface.
2. Keep `FileBrowserService` as the implementation.

Risk: low. Optional polish, not a blocker.

### 11. Deprecated Shell Tool Parameter Aliases

Files:

- `src/mcp/builtins/shell.ts`

Current behavior:

- The `run_command` tool schema defines two deprecated parameter aliases:
  `timeout` (alias for `timeout_ms`, line 38-40) and `idle_timeout_ms` (alias
  for `inactivity_timeout_ms`, line 46-48).
- `parseOptionalTimeoutMs` (line 64-76) resolves both aliases at runtime:
  `["timeout_ms", "timeout"]` and `["inactivity_timeout_ms", "idle_timeout_ms"]`.
- The tool description already recommends the canonical names over the aliases.

Why remove:

- These aliases exist for backward compatibility with older prompts or
  conversation contexts.
- LLM agents receive the current schema and should use canonical names.
- Removing reduces schema surface and parsing complexity.

Plan:

1. Verify no active prompts or past conversation contexts depend on the alias
   names. Search agent prompt templates for `timeout` and `idle_timeout_ms`.
2. Remove `timeout` and `idle_timeout_ms` from the `run_command` input schema.
3. Simplify `parseOptionalTimeoutMs` calls to use single-key arrays:
   `["timeout_ms"]` and `["inactivity_timeout_ms"]`.
4. Remove the "Deprecated alias" descriptions from the schema.
5. Update any tests that send alias parameter names.

Risk: low. Existing conversations that already used the aliases will still have
them in their context windows, but new tool calls from the agent will only see
canonical names.

## Recommended Execution Order

1. **Import surface cleanup:** remove built-ins and server compatibility
   re-exports; move stub-model helper to test utilities.
2. **Explicit context cleanup:** require project context in built-ins registration
   and delete `fallbackProjectRoot()`.
3. **API duplicate cleanup:** remove `/api/config.provider` after updating web UI
   and tests.
4. **Unavailable-tool decision:** decide whether `available:false` is a supported
   feature gate. Only remove it after that decision.
5. **Artifact fallback cleanup:** update prompts first, then verify valid
   artifact writes in a real or stubbed Manager/Worker loop, then remove
   Worker/Manager final-response JSON parsing fallback and rewrite tests/prompts
   to artifact-only behavior.
6. **Legacy config cleanup:** remove `model_overrides` custom rejection after
   checking active config state and deciding unknown-key policy.
7. **Legacy knowledge cleanup:** move/delete JSON-tree migration after checking
   active project state and providing a replacement safety path or accepting the
   data-loss risk explicitly.
8. **Optional polish:** simplify route-local interfaces where service type
    coupling remains.
9. **Deprecated shell aliases:** remove `timeout`/`idle_timeout_ms` input aliases
   from `run_command` schema after verifying prompt templates don't use them.

## Validation Gates

Run after each cleanup slice:

```bash
npm run typecheck
npm run build
npm test
```

Run after docs or prompt changes:

```bash
npm run docs:build
```

Run web-focused validation after removing `config.provider`:

```bash
npm run build:web
```

## Open Checks Before Deletion

- Confirm active `.saivage/config.json` files do not use `model_overrides`
  without printing secret-bearing config values.
- Confirm active projects do not contain legacy `.saivage/skills` or
  `.saivage/memory` JSON trees, or provide a one-shot migration/removal script.
- Confirm the web UI does not rely on unavailable MCP tools or the generic
  config `provider` label.
- Confirm prompts/tests no longer rely on final-response JSON artifacts.
- Confirm removing final-response artifact fallback does not turn common
  operational artifact-write failures into opaque stage/task failures.
- Confirm whether `defaultBuiltinSkillsRoot()` is runtime convention rather than
  compatibility fallback. Current assessment: keep it, because it locates bundled
  skills rather than guessing project state.
- Decide whether `parseTaskReport` export in `task-report.ts` should be kept for
  tests, deprecated and kept, or removed alongside the Worker's fallback branch.
