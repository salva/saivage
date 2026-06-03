# Architecture Implementation Plan

This plan implements the architecture improvement program in an order that
prioritizes clean, simple architecture and tackles the hardest structural
problems first. Easy work is scheduled early only when it creates safety for the
hard work.

The key sequencing rule is: do not add major new behavioral machinery to the
largest monoliths before splitting them. Compliance nudges and typed artifact
submission should land on cleaner agent/session and built-in-tool boundaries, not
be smeared across `BaseAgent` and `builtins.ts` and then moved later.

## Phase 0: Baseline And Stub Harness

Goals:

- Capture current behavior before structural changes.
- Add deterministic tests that make refactoring safer without adding new runtime
  behavior.
- Avoid deployment/runtime state changes.

Tasks:

1. Run `npm run typecheck`, `npm test`, and `npm run build` from `saivage/`.
2. Record any pre-existing failures.
3. Add a small stub-model harness that can drive agent turns without real
   provider calls.
4. Convert the skipped prompt-sequence and prompt-self-correction tests into
   executable stub-model tests, or delete them if they no longer describe the
   target architecture.
5. Add golden tests around the existing agent loop behavior:
   - final-response repair via `validateFinalResponse()`;
   - terminal tool handling via `detectTerminalToolCall()`;
   - tool-call dispatch and tool-result block insertion;
   - compaction trigger behavior.

Exit criteria:

- There is a known baseline.
- Stub-model tests can drive Planner/Manager/Worker turns without real provider
  calls.
- Existing repair/terminal-tool behavior is covered before decomposition starts.

## Phase 1: Agent Session Decomposition

Goals:

- Reduce `BaseAgent` risk before adding compliance or submission behavior.
- Keep the extracted design smaller than the original. Avoid new layers that do
  not remove meaningful complexity.

Tasks:

1. Extract `ConversationState` for messages, timestamps, round IDs, token
   accounting, and message replacement.
2. Extract `RetryPolicy` from `callLLM()` retry/backoff decisions.
3. Extract `CompactionController` for threshold checks, compaction execution,
   survivor reinjection, planner pre-compaction hook, and context-reset notices.
4. Keep `Dispatcher` as the tool execution owner. Do not add a separate
   `ToolRoundExecutor` unless a concrete simplification appears during the work.
5. Keep dashboard snapshot rendering close to `ConversationState` or
   `AgentSession`. Do not add a standalone `ConversationViewBuilder` unless the
   method becomes independently complex.
6. Clarify the small public/protected surface role subclasses depend on:
   `runLoop()`, `validateFinalResponse()`, `detectTerminalToolCall()`,
   `hasUsedAnyTool()`, `hasUsedToolNamed()`, and cancellation/snapshot methods.
7. Identify where `AgentContext` can be narrowed for extracted components rather
   than passed through wholesale.

Exit criteria:

- `BaseAgent` is mostly orchestration glue around focused state/retry/compaction
  components.
- The agent loop still uses the existing `Dispatcher` directly and clearly.
- Existing agent tests and Phase 0 golden tests pass after each extraction.

## Phase 2: Runtime Agent Factory And Planner Runner

Goals:

- Remove the hardest runtime behavior from `bootstrap.ts` without replacing a
  partially decomposed file with a large lifecycle framework.

Tasks:

1. Extract `createChildSpawner()` into an `AgentFactory` that owns role-to-agent
   construction, child-spawner behavior, stage dispatch checks, and stage-scoped
   worker caching.
2. Extract `runPlannerWithRecovery()` and related restart-loop behavior into a
   `PlannerRunner`.
3. Keep small bootstrap helpers in `bootstrap.ts` when they are already clear and
   named.
4. Do not introduce `RuntimeKernel` or `ServiceBootstrapper` unless extraction
   reveals a concrete lifecycle problem that cannot be expressed simply.
5. Start narrowing `SaivageRuntime` toward explicit runtime views, but avoid a
   facade that is almost as wide as the original runtime object.

Exit criteria:

- Agent spawning tests do not need full server startup.
- Planner recovery tests can run against a stub Planner result sequence.
- `bootstrap()` remains a composition/orchestration function, not a new class
  hierarchy.

## Phase 3: MCP Built-Ins Modularization

Goals:

- Split the 2000-line built-ins module before adding submission tools.
- Remove process-global and module-global runtime context.

Tasks:

1. Extract shared path, error, and limit helpers.
2. Extract filesystem service unchanged.
3. Extract shell service unchanged.
4. Extract git service unchanged.
5. Extract web fetch/search/download services.
6. Extract RAG and knowledge adapters.
7. Inject `ProjectContext`, MCP limits, and security settings into service
   factories.
8. Remove module-level mutable limit variables.
9. Move the `secretEnvNamePredicate` singleton behind injected security context.
10. Keep unavailable stubs isolated or delete them when not needed by current UI.

Exit criteria:

- Built-in service modules can be unit-tested independently.
- `registerBuiltinServices` is only composition.
- Only the shell/environment adapter reads process env directly.

## Phase 4: Minimal Compliance And Nudge Layer

Goals:

- Preserve agent autonomy while adding deterministic repair for contract drift.
- Build on existing mechanisms instead of adding a parallel compliance framework.

Tasks:

1. Extend the existing `validateFinalResponse()` repair path rather than adding a
   registry/event/check-family framework. The existing mechanism already
   increments `invalidFinalResponseCount` and injects a repair prompt, then
   terminates after 3 failures.
2. Add small compliance functions that return `{ conventionId, message,
   repairPrompt, fatal } | null`.
3. Reuse existing `decidePathMutation()` and roster conventions for path-related
   drift. Path enforcement is already hard-blocked in tool handlers — keep it as
   a safety boundary, not a nudge.
4. Reuse existing `detectTerminalToolCall()` for terminal tool semantics.
5. Add checks for:
   - Worker ending without enough execution evidence;
   - Manager ending without worker/reviewer evidence;
   - Planner `plan_done` without completed-plan evidence.
6. Use one simple retry limit for repair nudges. Do not make per-convention retry
   policy configurable unless a concrete need appears. The existing counter
   resets to 0 after any tool call — the new design should require evidence of
   meaningful tool use before clearing the counter, not just any tool call.
7. Preserve pending repair nudges across compaction by storing them in
   `ConversationState` and reinjecting after compaction, similar to how the
   planner pre-compaction hook preserves important context.
8. Keep path enforcement as hard refusal for safety boundaries (writes outside
   territory, secret-bearing paths, project-root escape). Behavioral drift
   (missing evidence, missing tools) gets nudges.

Exit criteria:

- Stub tests prove drift -> nudge -> repaired turn works.
- Repeated unrepaired drift becomes failure through one clear attempt limit.
- Fatal safety cases still fail immediately.
- There is no standalone compliance registry unless later evidence justifies it.
- Path enforcement remains hard refusal; nudges are for behavioral drift only.
- Reviewer, Inspector, and Critic retain `run_command` access; compliance and path
  enforcement are their main guardrails, not tool denial.

## Phase 5: Typed Artifact Submission

Goals:

- Make reports and summaries deterministic without scripting agent tactics.
- Use the cleaned built-in-tool structure and existing terminal-tool pattern.

Tasks:

1. Decide whether validation-only completion is sufficient:
   - If the agent writes a valid expected artifact to disk and the final response
     validates, accept it.
   - If this is too weak, proceed with explicit submission tools.
2. If explicit tools are kept, add `submit_task_report` in the modular filesystem
   or stage-artifact built-in service.
3. Add `submit_stage_summary` the same way.
4. Treat submission tools as terminal tools through `detectTerminalToolCall()` or
   an equivalent shared terminal-tool mechanism.
5. Validate with `TaskReportSchema` and `StageSummarySchema`.
6. Ensure stage/task ids match current agent context.
7. Prefer submitted/validated artifacts over final-response parsing.
8. Keep fallback final parsing only temporarily and mark its use as a repairable
   compliance warning.

Exit criteria:

- Worker success can come from a validated `TaskReport` artifact.
- Manager success can come from a validated `StageSummary` artifact.
- The success path does not depend on parsing freeform prose.
- Fallback parsing is covered and explicitly temporary.

## Phase 6: Project Store And Persistence Ownership

Goals:

- Stop scattering raw `.saivage` file access across runtime and server.
- Centralize file I/O without creating a repository-per-file hierarchy.

Tasks:

1. Add a `ProjectStore` that owns typed reads/writes for `.saivage` files.
2. Move plan load/save/cache internals behind `ProjectStore` or a very small
   `PlanStore` only if PlanService needs distinct cache semantics.
3. Add typed methods for stages, tasks, reports, summaries, runtime state,
   inspections, and chats.
4. Add dashboard-shaped read methods where needed instead of a large set of
   separate read-model classes.
5. Migrate server routes away from direct `readFile`, `readdir`, `readDocOrNull`,
   and hand-assembled stage paths.
6. Keep `KnowledgeStore` and RAG-specific storage as their existing owners, but
   document how `ProjectStore` reaches them for server reads.

Exit criteria:

- Server route code no longer hand-assembles stage artifact paths.
- Plan mutations still serialize through one owner.
- Lenient/debug reads are explicit and isolated.

## Phase 7: Server API Modularization

Goals:

- Make Fastify a thin transport adapter.
- Decouple HTTP/WebSocket route handlers from mutable runtime internals.

Tasks:

1. Extract token auth.
2. Extract static UI/docs mounting.
3. Introduce a narrow route dependency shape:
   - `Reads`: typed query/read-model functions;
   - `Commands`: explicit runtime mutations/control actions.
4. Do not pass `ModelRouter`, `McpRuntime`, `EventBus`, or the full runtime into
   route modules unless a route truly needs that object.
5. Extract file browser route and path hiding into `FileBrowserService` or
   `ProjectStore` methods.
6. Extract debug errors/timeline into explicit debug reads.
7. Extract WebSocket chat and move ChatAgent creation behind an agent/chat
   command service rather than constructing it inside the route handler.
8. Reduce `startServer` to app construction, plugin registration, route
   registration, and listen.

Exit criteria:

- Route tests can use fake `Reads` and `Commands`.
- `startServer` is small and mostly registers modules.
- No route parses secret-bearing config or raw project files directly.

## Phase 8: Provider Router Decomposition

Goals:

- Split model-routing policies only after higher-impact structural work is done.

Tasks:

1. Keep `ModelRouter` public API stable.
2. Extract only policies that are actively hard to test or change.
3. Prefer small pure helpers before introducing classes.
4. Candidate extraction order, if still needed:
   - credential resolution;
   - candidate-chain construction;
   - sticky failover state;
   - provider call timeout/error classification;
   - usage ranking.

Exit criteria:

- Existing router behavior remains unchanged.
- Each extracted policy has focused tests.
- No provider call happens during pure candidate planning tests.

## Phase 9: Legacy And Transition Cleanup

Goals:

- Delete obsolete compatibility paths after the new architecture is stable.

Tasks:

1. Inventory `legacy`, `v1`, `backward-compatible`, `stub`, and skipped-test
   markers.
2. Delete current-unneeded config compatibility code.
3. Move any still-useful migration code to admin scripts.
4. Delete or isolate unavailable MCP stubs.
5. Remove temporary final-response parsing fallback after submission or artifact
   validation is fully adopted.
6. Update docs to remove obsolete behavior descriptions.

Exit criteria:

- Grep results for legacy/stub/backward compatibility are explainable and small.
- No skipped tests remain as design placeholders.

## Validation Matrix

Run after each phase:

```bash
npm run typecheck
npm test
```

Run after phases that touch build/runtime/server/provider code:

```bash
npm run build
```

Run after docs/sidebar changes:

```bash
npm run docs:build
```

## Recommended First Implementation Slice

Start with Phase 0 and the first extraction in Phase 1, not compliance or
submission tools.

Suggested first pull/request-sized slice:

1. Add the stub-model harness for agent loop tests.
2. Unskip or replace the prompt-sequence and self-correction tests.
3. Add golden tests for existing `validateFinalResponse()` and
   `detectTerminalToolCall()` behavior.
4. Extract `ConversationState` from `BaseAgent` with no behavior changes.
5. Run `npm run typecheck`, `npm test`, and `npm run build`.

Reason:

- This starts with the hardest/most-important area: the agent loop.
- It creates safety for later structural and behavioral changes.
- It avoids adding new concepts into the largest files before they are split.
