# Design Review Critique

Critical review of the architecture improvement packet, prioritizing clean/simple
architecture and focusing on the hardest/most-impactful work first.

---

## 1. Phase Ordering: Decompose Before Extending

**Problem.** The plan starts with compliance/nudge (Phase 1) and typed submission
(Phase 2) before structural decomposition (Phases 3–8). The argument is that
behavioral tests make later refactors safer. But adding new runtime machinery
into `BaseAgent` (1176 lines) and `builtins.ts` (2008 lines) before splitting
them makes those files larger and harder to decompose, not easier.

**Recommendation.** Invert the order: decompose `BaseAgent` first (the hardest,
highest-risk change), then add compliance and submission on top of the cleaner
structure. Without decomposition, compliance hooks get smeared across the
monolith and become harder to relocate later.

Proposed order:

| Phase | Work | Why |
|---|---|---|
| 0 | Baseline + stub harness | Unchanged |
| 1 | Agent session decomposition | Hardest structural change; most line-count risk |
| 2 | Runtime kernel split | Second-highest structural risk |
| 3 | MCP builtins modularization | Third monolith; also unblocks injectable compliance |
| 4 | Compliance and nudge | Now lands on clean, focused components |
| 5 | Typed artifact submission | Now lands on modular builtins |
| 6 | Persistence ownership | Structural, but lower risk |
| 7 | Provider router | Lowest risk, lowest urgency |
| 8 | Server modularization | Mostly route shuffling |
| 9 | Legacy cleanup | Delete after everything is stable |

The key insight: compliance and submission are *behavioral* improvements that
depend on the *structural* shape of the code they hook into. Doing them first
means hooking into a monolith, then tearing the hooks out and moving them during
decomposition. Doing them after decomposition means writing hooks once, in the
right place.

---

## 2. Compliance/Nudge System Is Over-Engineered

**Problem.** The proposed compliance system introduces: `ComplianceEvent`
interface, `ConventionCheck` interface, `ComplianceDecision`, a `registry.ts`
mapping roles to check families, separate check files (`tool-use.ts`,
`artifact.ts`, `path-convention.ts`, `review-evidence.ts`), `nudges.ts` for
rendering, lifecycle hooks (after tool-call batch, before terminal response,
before StageSummary, before plan_done, during dashboard snapshot).

This is a lot of new machinery for what should be simple: after an agent turn,
check if it met its contract, and if not, inject a repair prompt.

**Root cause.** The design builds a general-purpose compliance *framework*
instead of a small set of compliance *checks*. A framework needs a registry,
a lifecycle, pluggable check families. Simple checks just need functions.

**Recommendation.** Replace the compliance package with a single module:

```ts
// src/runtime/compliance.ts

interface ComplianceViolation {
  conventionId: string;
  message: string;
  repairPrompt: string;
  fatal: boolean;
}

function checkWorkerCompletion(
  role: AgentRole,
  toolCalls: string[],
  submittedArtifact: unknown,
): ComplianceViolation | null;

function checkManagerCompletion(
  role: AgentRole,
  toolCalls: string[],
  submittedArtifact: unknown,
): ComplianceViolation | null;

function checkPlannerCompletion(
  role: AgentRole,
  toolCalls: string[],
  submittedArtifact: unknown,
): ComplianceViolation | null;
```

No registry, no event types, no check families, no lifecycle hooks. The agent
loop calls the right function at the right point. Dashboard consumption can be
added later by logging the violation, not by building a projection system.

---

## 3. Agent Session Decomposition: Names And Scope Mismatch

Several proposed components don't match the source or over-extract trivial code:

### `runUntilTerminal()` vs `runLoop()`

The design proposes `AgentSession.runUntilTerminal()` as the main entry point.
The actual method is `BaseAgent.runLoop()`. The name matters: the loop doesn't
just run "until terminal" — it handles compaction, channel draining, stash,
diagnostics, and error recovery along the way. Call it what it is.

### `ToolRoundExecutor` Duplicates Dispatcher

The design proposes extracting `ToolRoundExecutor` from `BaseAgent`, but tool
execution is already handled by `runtime/dispatcher.ts` (`Dispatcher`). The
code in `BaseAgent` around tool calls (lines 348–370) just:
1. Calls `this.dispatcher.processToolCalls()`.
2. Builds tool_result blocks from the results.
3. Calls `maybeStash()` on large results.

Extracting a `ToolRoundExecutor` that wraps the existing `Dispatcher` adds a
layer of indirection without simplifying the call chain. The real extraction
targets are the stash logic and the tool-result-block construction, which are
3–5 lines each.

### `ConversationViewBuilder` Over-Extraction

`getConversationSnapshot()` and `getActivityStatus()` are lightweight
serialization methods. They don't maintain state or have complex logic. Making
them a separate class adds boilerplate without reducing cognitive load. They
belong as methods on `ConversationState` or `AgentSession`, not as a standalone
component.

### Missing: `AgentContext` Cleanup

`AgentContext` bundles project, router, mcpRuntime, noteManager, agentId, role,
modelSpec, startupDirectives, stageId, channelId, sessionId, and
authProfileKey. Several decomposition proposals introduce new objects
(`ToolCatalog`, compliance checks, submission tools) that need some of these
dependencies but not all. The design should propose narrowing `AgentContext`
into focused interfaces, or the decomposed components will still reach through
a god-bag.

### Missing: The Dispatcher Is Not Addressed

The `Dispatcher` is a key component that sits between `BaseAgent` and child
agents. It separates local tool calls from dispatch calls, enforces concurrency
limits, and creates child agents through `ChildSpawner`. None of the design
docs discuss it. The `AgentSession` decomposition should clarify whether
dispatch stays between `AgentSession` and `Dispatcher` or gets folded into a
different shape.

### What To Actually Extract From BaseAgent

The valuable extractions are:

1. **`ConversationState`** — message array, timestamps, round IDs, token counts.
   Currently `this.messages`, `this.roundIdSequence`, `this.tokenTracker`
   are interleaved with turn logic. This is a real extraction that reduces the
   cognitive width of the loop.

2. **`RetryPolicy`** — the `callLLM` retry/backoff logic is 70+ lines with
   provider-specific error classification. Worth extracting.

3. **`CompactionController`** — compaction threshold decisions, summarizer
   invocation, survivor block rebuilding. This is already partially in
   `runtime/compaction.ts`; what remains in `BaseAgent` is the planner hook and
   the context-reset notification. Extractable.

Drop `ToolRoundExecutor` and `ConversationViewBuilder` — they add abstraction
without reducing complexity.

---

## 4. Existing Compliance Mechanisms Are Not Acknowledged

The design docs propose a compliance/nudge system without discussing three
existing mechanisms that already do similar work:

### `validateFinalResponse()`

`WorkerAgent` overrides this to check `hasUsedAnyTool()`. `ManagerAgent`
overrides this to check `hasUsedToolNamed(...getDispatchToolsFor("manager"))`.
When the check fails, `BaseAgent` increments `invalidFinalResponseCount` and
injects a repair message:

> "Continue the task by using the required tools and return a final result only
> after real execution evidence exists."

This is **exactly** the nudge pattern the design proposes. The design should
acknowledge it and propose evolving it rather than building a parallel system.

### `detectTerminalToolCall()`

`PlannerAgent` overrides this to detect `plan_done` as a terminal tool call.
When detected, the loop exits with `{ name: "plan_done", data: { reason } }`.
This is the same pattern that `submit_task_report` and `submit_stage_summary`
should follow — but the design doesn't mention it. The typed submission design
should explicitly say that submission tools are terminal tools that use this
existing mechanism.

### `decidePathMutation()` In Runtime

The design claims that `conventions.ts` is "currently used only by tests." This
is **wrong**. `builtins.ts` imports `decidePathMutation` at line 15 and calls it
in `write_file`, `download_file`, and shell command path guards. The convention
system is *already* wired into runtime enforcement. The new compliance system
needs to explain its relationship to the existing convention system, not create
a second parallel system.

---

## 5. Typed Artifact Submission: Consider A Simpler Alternative

The `submit_task_report` and `submit_stage_summary` design adds two new MCP
built-in tools with schemas, validation, file writing, and metadata recording.
This is reasonable but may be more than needed.

**Simpler alternative:** Make the terminal-response JSON schema the contract.
Instead of adding new tools, validate the final response JSON against
`TaskReportSchema` or `StageSummarySchema` in the `validateFinalResponse` hook.
If the agent wrote the artifact to disk *and* the JSON validates, accept it.
If not, nudge.

This avoids: new MCP tools, prompt changes, a submission metadata system, and
a migration path with fallback parsing. The agent behavior change is minimal —
they already write reports and return JSON. The runtime just needs to check
whether the report file exists and validates, rather than parsing freeform text.

If you do keep `submit_task_report`, it should be documented as a **terminal
tool** using the existing `detectTerminalToolCall` pattern, not as a separate
submission mechanism that needs its own success path.

---

## 6. Bootstrap Split: Already Partially Decomposed

The design treats `bootstrap.ts` as a monolith needing extraction into five
components. In reality, bootstrap is **already decomposed** into named functions:

| Function | Lines (approx) |
|---|---|
| `createChildSpawner(runtime)` | ~120 |
| `runPlanner(runtime, options?)` | ~30 |
| `runPlannerWithRecovery(runtime)` | ~60 |
| `installFatalHandlers(runtime, lock)` | ~20 |
| `startConfiguredMcpServers(mcpRuntime, config)` | ~30 |
| `resolveAgentRoute(runtime, role)` | ~15 |
| `publishAgentResult(...)` | ~15 |
| `queuePlannerDirective(runtime, content)` | ~10 |
| `assertStageDispatchable(...)` | ~15 |
| `normalizeWorkerDispatchInput(...)` | ~10 |

The real extraction targets are `createChildSpawner` (the role switch block
with stage-scoped worker caching) and `runPlannerWithRecovery` (the recovery
loop). The other functions are small and already well-named.

**Recommendation.** Reduce the `RuntimeKernel` / `ServiceBootstrapper` /
`AgentFactory` / `PlannerRunner` proposal to two targeted extractions:

1. Extract `createChildSpawner` into `AgentFactory` — it's the only function
   that knows about all agent types.
2. Extract `runPlannerWithRecovery` into `PlannerRunner` — it's the only
   function with complex restart/loop logic.

Everything else can stay in bootstrap until server modularization (Phase 8)
shrinks it further. A `RuntimeKernel` lifecycle object is over-engineering for
a file that is already well-structured.

---

## 7. Persistence Ownership: 8 Repositories + 7 Read Models Is Too Many

The design proposes separate repositories for Plan, Stage, RuntimeState, Notes,
Chats, Inspections, Knowledge, and RAG — plus 7 read models. That's 15 new
interfaces for a system that uses simple file-based persistence with
atomic-write-and-rename.

**Problem.** The issue is not that there are too few abstractions; it's that
raw file reads are scattered across `server.ts`. The fix is to centralize file
I/O, not to introduce a repository-per-aggregate pattern.

**Recommendation.** Start with one `ProjectStore` that owns all reads and writes
to `.saivage/` files. It provides typed methods like `readPlan()`,
`readStageTasks(id)`, `writeStageReport(id, taskId, report)`, etc. Read models
are just methods on the store that return dashboard-shaped views.

Only split into separate repositories when you have a concrete reason (different
storage backend, different cache policy, different deployment boundary). Right
now, there's no reason.

---

## 8. Server Modularization: The Facade Is Too Wide

The proposed `ServerRuntimeView` has 10 fields:

```ts
interface ServerRuntimeView {
  project, config, routing, router, mcpRuntime, noteManager, eventBus,
  plannerControl, agents, reads
}
```

`SaivageRuntime` currently has 15 fields. This is not a meaningful narrowing.

**Recommendation.** Routes should receive only the two things they need:

1. `ReadModel` — typed query functions for data.
2. `Commands` — typed mutation functions for actions (start planner, cancel
   agent, acknowledge note).

No route should see `ModelRouter`, `McpRuntime`, or `EventBus` directly. This
would also help with the persistence ownership: read models become the only way
routes see data.

---

## 9. Missing From The Design Packet

These gaps should be addressed before implementation:

### WebSocket Chat Agent Creation

The `/ws` route creates `ChatAgent` on the fly inside the server handler.
This couples agent lifecycle to HTTP handler code. The server modularization
doc mentions extracting the WebSocket route but doesn't discuss decoupling
agent creation from the route handler.

### Nudge Loop And Compaction Interaction

If compliance nudges inject repair prompts, they add tokens to the
conversation. After multiple nudges, the context can fill up and trigger
compaction. Compaction is a lossy summary — it may drop the nudge history,
causing the agent to forget the violation it was told to fix. The design
should specify whether compliance nudges survive compaction (e.g., by
including them in the planner-compaction hook or by adding them to a
persistent "pending compliance" queue).

### `secretEnvNamePredicate` Singleton

`builtins.ts` line 1017 creates a module-level singleton from
`createSecretEnvNamePredicate(DEFAULT_CREDENTIAL_LEXEMES, ...)`. The
modularization doc mentions replacing module-level mutable config but doesn't
mention this security-critical singleton. It needs explicit injection via
`ProjectContext` or `SecurityContext`.

### Config Complexity

`SaivageConfig` is a large Zod schema with deep nesting, env interpolation, and
legacy migration rejects. None of the design docs address simplifying it, but
it's a source of complexity that touches bootstrap, server, and agents.

### Knowledge/RAG Service Lifecycle

`RuntimeContext` lists `ragService` and `knowledgeStore` as fields, but neither
the kernel split nor any other doc addresses their startup/initialization
lifecycle, which involves RAG ingestion and migration. If the
`ServiceBootstrapper` is not pursued (per the critique in section 6), this
needs to be addressed somewhere.

---

## 10. Provider Router Decomposition: Low Priority

Splitting `ModelRouter` into 7 new classes (`ProviderRegistry`,
`CredentialResolver`, `ModelAssignmentResolver`, `CandidatePlanner`,
`UsageRanker`, `FailoverState`, `ProviderCaller`) is pure structural
refactoring. It doesn't fix a bug, doesn't unblock other work, and introduces
7 new interfaces to understand. The router works, has tests, and is not
blocking any other phase.

**Recommendation.** Push this to the end. If it's still desired after the
higher-impact changes, do it then. The router is self-contained and can be
split any time without affecting other modules.

---

## Summary Of Recommendations

| # | Issue | Recommendation |
|---|---|---|
| 1 | Phase ordering | Decompose monoliths first, then add behavioral improvements |
| 2 | Compliance framework | Replace with simple check functions, not a registry/event system |
| 3 | Over-extraction | Drop ToolRoundExecutor and ConversationViewBuilder; extract ConversationState, RetryPolicy, CompactionController only |
| 4 | Unacknowledged existing mechanisms | Document relationship to `validateFinalResponse`, `detectTerminalToolCall`, and `decidePathMutation` |
| 5 | Typed submission | Consider validation-only alternative; if keeping tools, document as terminal tools |
| 6 | Bootstrap over-split | Reduce to AgentFactory + PlannerRunner; skip RuntimeKernel and ServiceBootstrapper |
| 7 | Too many repositories | Start with `ProjectStore`; add repositories only when needed |
| 8 | Facade too wide | Routes get ReadModel + Commands, not the full runtime |
| 9 | Missing items | Address WS agent creation, nudge+compaction, secretEnvNamePredicate, config, RAG lifecycle |

---

## Second-Round Findings

These findings are from a deeper source-level review after the first-round
recommendations were applied.

### 11. Path Conventions Are Already Hard-Enforced, Not Advisory

The role-access-boundaries doc and the autonomy doc both describe path conventions
as "observable contracts" with "nudges" for drift. But the actual code **blocks**
write-path violations. `decidePathMutation()` returns `{ ok: false, reason }` and
the tool handler returns `{ content: reason, isError: true }` — the write does not
happen.

This means path enforcement is already a hard safety boundary. The compliance
design should keep it as hard refusal and not soften it into a nudge. The nudges
are for behavioral drift (missing evidence, missing tools), not for path safety.

### 12. validateFinalResponse Already Implements Nudge-With-Retry

The existing `validateFinalResponse` mechanism is a working nudge loop:
- Worker checks `hasUsedAnyTool()`, Manager checks `hasUsedToolNamed(...)`.
- On failure, `invalidFinalResponseCount` increments and a repair prompt is
  injected.
- After 3 failures, the agent terminates with `finishReason: "error"`.
- The counter resets to 0 on any tool call.

This is exactly the pattern the compliance design proposes. The new design should
extend this mechanism (add evidence checks, prevent trivial-tool counter resets)
rather than create a parallel system.

### 13. LlmTurnRunner Misdescribes Channel Draining

The `LlmTurnRunner` extraction says "Channel draining before call" but
`drainChannels()` is called from `runLoop()` (line 274), not from inside
`callLLM()`. The turn runner should only own retry/backoff/error-classification,
not channel draining.

### 14. Stage-Scoped Worker Caching Not Addressed

`createChildSpawner` contains a `stageWorkers` map that caches reviewer, designer,
and critic agents per stage and reuses them across dispatches. This is a
non-trivial caching mechanism that the `AgentFactory` extraction must preserve.
The AgentFactory design should document this behavior.

### 15. Reviewer, Inspector, and Critic Have Shell Access

The tool filter gives `run_command` to reviewer-role agents (Reviewer, Inspector,
Critic). This means these "quality gate" roles can execute arbitrary shell commands.
The compliance design should acknowledge this and note that path enforcement and
behavioral nudges (not tool denial) are the main guardrails for these roles.

### 16. Compaction+Nudge Interaction Needs A Concrete Mechanism

The existing planner pre-compaction hook (`runPlannerCompactionHook`) gives the
planner a 5-turn window to create memories before compaction destroys context.
This is a proven pattern for preserving important information across compaction.
The compliance design should use the same approach: store pending repair prompts
in `ConversationState` and reinject them after compaction, rather than leaving
the mechanism unspecified.

### 17. Invalid Final Response Counter Resets On Any Tool Call

`invalidFinalResponseCount` resets to 0 whenever the agent makes any tool call.
This means a worker could call one trivial tool (like `list_dir`) then end without
a report, clearing the nudge counter. The compliance design should require
evidence of meaningful tool use (specific to the task) before clearing the
counter, not just any tool call.