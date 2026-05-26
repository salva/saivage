# F09 — Design proposals (R1)

Three proposals. All assume the project guideline of architecture-first / no backward compatibility: no shim layer, no "old + new", and the orphan `designer.ts` (F01) is deleted as part of any F09 change instead of being carried.

## Proposal A — Focused fix: shared `task-report.ts` module

Extract the three helpers into one module that every worker imports.

### Shape

New file: `src/agents/task-report.ts`

```ts
import type { Task, TaskReport } from "../types.js";
import type { WorkerInput } from "./types.js";

export type WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer";

const ROLE_TO_TASK_TYPE: Record<WorkerRole, Task["type"]> = {
  coder: "code",
  researcher: "research",
  data_agent: "data",
  reviewer: "review",
};

export function normalizeTask(raw: any, role: WorkerRole): Task {
  const descriptionParts = [raw.description ?? raw.objective ?? "(no description)"];
  if (Array.isArray(raw.files) && raw.files.length > 0) {
    descriptionParts.push(`Suggested files or starting points:\n${raw.files.map((f: string) => `- ${f}`).join("\n")}`);
  }
  if (typeof raw.instructions === "string" && raw.instructions.trim()) {
    descriptionParts.push(`Detailed instructions from Manager:\n${raw.instructions.trim()}`);
  }
  return {
    id: raw.id ?? "unknown",
    type: raw.type ?? ROLE_TO_TASK_TYPE[role],
    assigned_to: raw.assigned_to ?? role,
    description: descriptionParts.join("\n\n"),
    checklist: Array.isArray(raw.checklist)
      ? raw.checklist
      : Array.isArray(raw.acceptance_criteria)
        ? raw.acceptance_criteria.map((c: string) => ({ description: c, required: true }))
        : [],
    dependencies: raw.dependencies ?? [],
    status: raw.status ?? "pending",
    tags: raw.tags ?? [],
    attempt: raw.attempt ?? 1,
    max_attempts: raw.max_attempts ?? 3,
  };
}

export function parseTaskReport(
  text: string,
  input: WorkerInput,
  role: WorkerRole,
  startedAt: string,
  startMs: number,
): TaskReport { /* single implementation, single F03 fix-site later */ }

export function buildFailureReport(
  input: WorkerInput,
  role: WorkerRole,
  startedAt: string,
  startMs: number,
  reason: string,
): TaskReport {
  return {
    task_id: input.task.id,
    stage_id: input.stageId,
    agent: role,
    status: "failed",
    summary: `Task failed: ${reason}`,
    checklist_results: [],
    files_modified: [], files_created: [], tests_added: [], tests_run: [], commits: [],
    issues_found: [{ severity: "error", description: reason }],
    failure_reason: reason,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
  };
}
```

Resolution of the drift in §2.3 of the analysis: `issues_found` always contains the failure as a single `error` issue. This matches data-agent / reviewer / designer behavior and gives the Manager a usable signal.

### After-state of each worker

- [coder.ts](src/agents/coder.ts): module-private `normalizeTask`, `parseTaskReport`, `buildFailureReport` deleted (lines 212-340). Top adds `import { normalizeTask, parseTaskReport, buildFailureReport } from "./task-report.js";`. All three callsites pass `"coder"` as the role. `CODER_PROMPT`, `buildCoderMessage`, `CoderAgent` class, and the unused `readFileSync`/`join` imports stay or are cleaned. Net: ~140 lines removed.
- [researcher.ts](src/agents/researcher.ts): same. Net: ~140 lines removed.
- [data-agent.ts](src/agents/data-agent.ts): same. Net: ~140 lines removed.
- [reviewer.ts](src/agents/reviewer.ts): same, plus `normalizeWorkerInput` becomes `{ ...input, task: normalizeTask(input.task, "reviewer") }` inline at its single use site ([reviewer.ts L115](src/agents/reviewer.ts#L115)). The stray `this.messages.push({ role: "assistant", content: text })` at [reviewer.ts L122](src/agents/reviewer.ts#L122) is **not** in F09's scope and stays. Net: ~145 lines removed.
- [designer.ts](src/agents/designer.ts): **deleted** per F01. Not ported.

### Scope of edits

- 1 file added (`task-report.ts`, ~120 lines).
- 4 files edited (coder/researcher/data-agent/reviewer), ~140 lines removed each.
- 1 file deleted (`designer.ts`, ~290 lines).
- Net: roughly -700 lines.

### Risk profile

Low. The change is mechanical extraction with one behavioural unification (`issues_found` in `buildFailureReport`). Existing tests in [agents.test.ts](src/agents/agents.test.ts) exercise `CoderAgent` and `ReviewerAgent` end-to-end and will catch any signature mistake.

### Enables

- F03 (naive JSON parsing) becomes a 1-line edit in `task-report.ts` instead of 5.
- Any future `TaskReport` field addition is 1 edit.
- F01 designer deletion is bundled in (designer drift can no longer accumulate because the file is gone).

### Forbids / does not address

- The `run()` skeleton remains duplicated in 4 worker files. The "~150 lines per file" body of `run()` is not touched.
- `validateFinalResponse` overrides remain per-file (which is correct).
- Reviewer's manual `messages.push` after `runLoop()` is not addressed.

### Recommendation note

Solves the literal duplication. Leaves the structural duplication in `run()` and the reviewer assistant-push bug. Worth doing if a heavier refactor is judged too risky for this review pass; otherwise Proposal C subsumes it.

---

## Proposal B — Hoist the worker loop into `BaseAgent`

`BaseAgent` already owns the LLM loop. Hoist `normalize / build-initial-message / run-loop / parse-result / build-failure` into a new `BaseAgent.runWorker<TInput, TReport>()` method. Worker subclasses shrink to a manifest of role + prompt + a `buildInitialMessage` hook + a `buildReport`/`buildFailure` pair.

### Shape

```ts
// in BaseAgent
protected async runWorker(opts: {
  startedAt: string;
  startMs: number;
  onSuccess: (text: string) => AgentResult;
  onFailure: (kind: "abort" | "failure", reason: string) => AgentResult;
}): Promise<AgentResult> {
  try {
    const { text, finishReason } = await this.runLoop();
    if (finishReason === "abort" || finishReason === "cancelled") return opts.onFailure("abort", text);
    if (finishReason === "max_compactions" || finishReason === "error") return opts.onFailure("failure", text);
    return opts.onSuccess(text);
  } catch (err) {
    return opts.onFailure("failure", err instanceof Error ? err.message : String(err));
  }
}
```

Worker `run()` collapses to:

```ts
async run(): Promise<AgentResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  return this.runWorker({
    startedAt, startMs,
    onSuccess: (text) => ({ kind: "success", data: parseTaskReport(text, this.input, "coder", startedAt, startMs) }),
    onFailure: (kind, reason) => ({ kind, reason, partial: buildFailureReport(this.input, "coder", startedAt, startMs, reason) }),
  });
}
```

### Scope of edits

- `BaseAgent` grows by ~20 lines (one new protected method, plus the log line currently in each worker can move here if desired).
- `task-report.ts` is still introduced (Proposal A's helper module is a prerequisite).
- Each worker `run()` shrinks from ~35 lines to ~10.
- Designer deleted.

### Risk profile

Medium. `BaseAgent` is shared with planner, manager, and chat — adding a worker-specific method there is a category violation. Planner and chat are long-lived loops with different finishReason semantics; they would never call `runWorker`. The method would be dead weight in their inheritance tree.

### Enables

- Same as Proposal A, plus: future changes to the finishReason-to-AgentResult mapping live in one place.

### Forbids

- Per-agent override of normalisation: each worker can still pass any role to `normalizeTask`, so no real loss.
- The shape forces all workers to use the same try/catch wrapping. None of them needs to vary, so no real loss.

### Recommendation note

Conceptually clean but puts worker-shaped code into the wrong class. Proposal C splits the difference correctly.

---

## Proposal C — Introduce `WorkerAgent extends BaseAgent` (recommended)

Same as Proposal B, but the new method lives on a new intermediate class `WorkerAgent` that only the four worker roles extend. `BaseAgent` stays untouched; planner/manager/chat/inspector keep extending `BaseAgent` directly.

### Shape

New file: `src/agents/worker.ts`

```ts
import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type { Agent, AgentContext, AgentResult, WorkerInput } from "./types.js";
import type { TaskReport } from "../types.js";
import {
  normalizeTask,
  parseTaskReport,
  buildFailureReport,
  type WorkerRole,
} from "./task-report.js";
import { log } from "../log.js";

export interface WorkerAgentConfig extends Partial<BaseAgentConfig> {
  role: WorkerRole;
  systemPrompt: string;
  buildInitialMessage: (input: WorkerInput) => string;
  invalidFinalResponseMessage: string;
}

export abstract class WorkerAgent extends BaseAgent implements Agent {
  protected input: WorkerInput;
  private readonly workerRole: WorkerRole;
  private readonly invalidFinalResponseMessage: string;

  constructor(ctx: AgentContext, input: WorkerInput, config: WorkerAgentConfig) {
    const task = normalizeTask(input.task, config.role);
    const normalized: WorkerInput = { ...input, task };
    super(ctx, {
      systemPrompt: config.systemPrompt,
      skillContext: { agentRole: config.role, description: task.description, tags: task.tags ?? [] },
      initialMessage: config.buildInitialMessage(normalized),
      ...config,
    });
    this.input = normalized;
    this.workerRole = config.role;
    this.invalidFinalResponseMessage = config.invalidFinalResponseMessage;
  }

  async run(): Promise<AgentResult> {
    log.info(
      `[${this.workerRole}:${this.id}] Starting task ${this.input.task.id}: ${this.input.task.description.slice(0, 80)}`,
    );
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      const { text, finishReason } = await this.runLoop();
      if (finishReason === "abort" || finishReason === "cancelled") {
        return { kind: "abort", reason: text, partial: buildFailureReport(this.input, this.workerRole, startedAt, startMs, text) };
      }
      if (finishReason === "max_compactions" || finishReason === "error") {
        return { kind: "failure", reason: text, partial: buildFailureReport(this.input, this.workerRole, startedAt, startMs, text) };
      }
      return { kind: "success", data: parseTaskReport(text, this.input, this.workerRole, startedAt, startMs) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${this.workerRole}:${this.id}] Failed: ${msg}`);
      return { kind: "failure", reason: msg, partial: buildFailureReport(this.input, this.workerRole, startedAt, startMs, msg) };
    }
  }

  protected override validateFinalResponse(): string | null {
    if (this.hasUsedAnyTool()) return null;
    return this.invalidFinalResponseMessage;
  }
}
```

### After-state per worker

- [coder.ts](src/agents/coder.ts): file shrinks from ~340 lines to ~210 (the prompt is the bulk). Class body becomes:

  ```ts
  export class CoderAgent extends WorkerAgent {
    constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<BaseAgentConfig>) {
      super(ctx, input, {
        role: "coder",
        systemPrompt: CODER_PROMPT,
        buildInitialMessage: (i) => buildCoderMessage(ctx, i),
        invalidFinalResponseMessage: "Invalid final task response: you have not used any tools for this task yet.",
        ...config,
      });
    }
  }
  ```

  `buildCoderMessage` stays as a module-private function. `normalizeTask`, `parseTaskReport`, `buildFailureReport`, the overridden `run()`, and `validateFinalResponse()` are deleted from coder.ts. The unused `readFileSync`/`join` imports are removed.

- [researcher.ts](src/agents/researcher.ts): same shape.
- [data-agent.ts](src/agents/data-agent.ts): same shape.
- [reviewer.ts](src/agents/reviewer.ts): same shape with one extra method — `review(input: WorkerInput): Promise<AgentResult>` stays as a `ReviewerAgent`-specific addition for the manager loop. Inside `review()`, the normalisation and message-injection lines remain; the success/abort/failure plumbing reuses the same `parseTaskReport`/`buildFailureReport` helpers. The stray `this.messages.push({ role: "assistant", content: text })` ([reviewer.ts L122](src/agents/reviewer.ts#L122)) is removed in F09's scope here — keeping it would leave a behavioural difference between `run()` and `review()`, and removing it is consistent with `BaseAgent.runLoop()` already pushing the assistant message. (This intersects with the subsystem-map note about double-push; F09 fixes it as a side-effect of unification.)
- [designer.ts](src/agents/designer.ts): **deleted** per F01.
- [inspector.ts](src/agents/inspector.ts): **untouched**. It uses `InspectionRequest`/`InspectionReport`, not `WorkerInput`/`TaskReport`, and is invoked through a different lifecycle (it has no manager-driven retry, no Stage scoping, no checklist). Keeping it on `BaseAgent` directly preserves the right separation of concerns.

### Scope of edits

- 2 files added: `task-report.ts` (~120 lines), `worker.ts` (~80 lines).
- 4 files edited: coder/researcher/data-agent/reviewer (~150 lines removed each).
- 1 file deleted: designer.ts (~290 lines).
- `BaseAgent` untouched.
- Net: roughly -700 lines, with a clear class hierarchy.

### Risk profile

Low–medium. Slightly more moving parts than Proposal A (an extra class), but each worker file becomes a near-trivial role declaration, which is the actual design intent. Existing `agents.test.ts` constructs `CoderAgent` and `ReviewerAgent` and exercises `run()` / `review()`; the public API of those classes is unchanged.

### Enables

- Same as A and B.
- A 5th worker role (if ever introduced) is ~20 lines, not a 340-line copy.
- F03 fix is 1 line in `task-report.ts`.
- F01 (designer orphan) executed in the same commit.
- Reviewer double-push bug fixed as a side-effect.

### Forbids

- Per-worker override of `validateFinalResponse` semantics beyond changing the message string. None of the four needs more than that today.
- Per-worker override of the success/abort/failure mapping. None varies today.

### Recommendation note

Right level of abstraction: the shared structure goes into a class that exists for exactly that reason. `BaseAgent` keeps its role as "LLM/tool/compact loop"; `WorkerAgent` keeps its role as "manager-dispatched, task-scoped, TaskReport-producing". Inspector stays separate because it genuinely is.

---

## Recommendation

**Proposal C — `WorkerAgent` base class.**

It eliminates the same ~700 lines as A while also removing the duplicated `run()` skeleton, executes F01's designer deletion in the same commit, fixes the reviewer double-push side-effect, and keeps `BaseAgent` clean for planner/manager/chat/inspector. The extra class is justified because the four worker agents share a real, named lifecycle ("manager dispatches a task → worker normalises → run loop → parse TaskReport → return") that does not apply to the long-lived agents. Risk is comparable to Proposal A because the public API of each worker class is unchanged and existing tests cover the critical paths.

Proposal A is the fallback if reviewer's `review()` second-call semantics turn out to need more divergence than expected during implementation — but they don't, based on the current code.
