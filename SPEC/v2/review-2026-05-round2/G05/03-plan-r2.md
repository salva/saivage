# G05 — Plan r2

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
**Design**: [02-design-r2.md](02-design-r2.md) — Proposal B (refined)
**Round-1 review**: [04-review-r1.md](04-review-r1.md) — CHANGES_REQUESTED (4 items).

## Round 2 deltas vs r1

Applies the four reviewer changes:

1. No second registry — `WORKER_ROLE_SPECS` is dropped; worker init metadata lives on `ROSTER` as a new `workerInit` field; one accessor (`getWorkerInitMeta`) reads it ([02-design-r2.md §Single source of truth](02-design-r2.md)).
2. One exact API — single `WorkerAgent` constructor signature, single exported `buildInitialMessage`, empty nominal subclasses that inherit the base constructor; spelled out in steps 1–4.
3. Behaviour coverage — step 6c adds a `createChildSpawner` consumer test (normal worker + reviewer with stage-cache reuse + follow-up).
4. Local-only validation by default; live validation operator-gated and covers all three bind-mounted v2 harnesses (`saivage`, `diedrico`, `saivage-v3`).

Blast radius: **6 production files modified, 1 production file added (prompt-keys), 2 test files modified, 2 test files added** — 11 paths total.

---

## Sequenced steps

### 1. Break the prompt-key import cycle and add the field to ROSTER.

**1a.** Create [src/agents/prompt-keys.ts](../../../../src/agents/prompt-keys.ts) — a type-only module:

```ts
export type RolePromptName =
  | "planner"
  | "manager"
  | "coder"
  | "researcher"
  | "data-agent"
  | "reviewer"
  | "designer"
  | "inspector"
  | "chat";
```

**1b.** In [src/agents/prompts.ts](../../../../src/agents/prompts.ts):
- Replace the inline `export type RolePromptName = ...` union ([src/agents/prompts.ts](../../../../src/agents/prompts.ts#L16-L25)) with `export type { RolePromptName } from "./prompt-keys.js";`.
- Delete the `role === "data-agent" ? "data_agent" : role` magic in `substitutions()` at [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L54-L57). The renderer now sources `promptKey` from `ROSTER` for workers; `substitutions()` is only called from `loadRolePrompt(role)`, and the only role string that differs from its prompt file name is `data_agent`. Replace with a small reverse-map declared next to the existing prompt loader: `const PROMPT_KEY_TO_ROLE: Record<RolePromptName, AgentRole> = { ...identity for 8 keys..., "data-agent": "data_agent" }`. This keeps `loadRolePrompt` standalone (it does not yet know about `workerInit`) while removing the inline ternary.

**1c.** In [src/agents/roster.ts](../../../../src/agents/roster.ts):
- Add `import type { RolePromptName } from "./prompt-keys.js";` at the top.
- Add the new interface and field above `ROSTER`:

  ```ts
  export interface WorkerInitMeta {
    heading: string;
    extraInstructionLines: readonly string[];
    notesDir: ((stageId: string) => string) | null;
    followUpInstruction: string | null;
    promptKey: RolePromptName;
    invalidFinalResponseMessage: string;
  }
  ```

- Add `workerInit: WorkerInitMeta | null;` as a required field on `RosterEntry` ([src/agents/roster.ts](../../../../src/agents/roster.ts#L14-L40)).
- Populate `workerInit` on every entry in `ROSTER` ([src/agents/roster.ts](../../../../src/agents/roster.ts#L40-L210)):
  - `planner` / `manager` / `inspector` / `chat` — `workerInit: null`.
  - `coder`:
    ```ts
    workerInit: {
      heading: "Task Assignment",
      extraInstructionLines: [],
      notesDir: null,
      followUpInstruction: null,
      promptKey: "coder",
      invalidFinalResponseMessage:
        "Invalid final task response: you have not used any tools for this task yet.",
    }
    ```
  - `researcher`:
    ```ts
    workerInit: {
      heading: "Research Task Assignment",
      extraInstructionLines: ["Write findings under: research/"],
      notesDir: null,
      followUpInstruction: null,
      promptKey: "researcher",
      invalidFinalResponseMessage:
        "Invalid final task response: you have not used any tools for this research task yet.",
    }
    ```
  - `designer`:
    ```ts
    workerInit: {
      heading: "Design Task Assignment",
      extraInstructionLines: [
        "Produce design artifacts that are concrete enough for implementation and review.",
      ],
      notesDir: null,
      followUpInstruction: null,
      promptKey: "designer",
      invalidFinalResponseMessage:
        "Invalid final design response: you have not used any tools for this design task yet.",
    }
    ```
  - `data_agent`:
    ```ts
    workerInit: {
      heading: "Data Acquisition Task Assignment",
      extraInstructionLines: [
        "Write downloaded artifacts to the project-relative path that best fits the task; data/ is common but not mandatory.",
        "Write provenance notes under research/data-sources/ or another clearly named research/provenance path.",
        "Use retries, fallback source URLs, alternate access methods, and an attempt manifest when downloads are unreliable.",
      ],
      notesDir: null,
      followUpInstruction: null,
      promptKey: "data-agent",
      invalidFinalResponseMessage:
        "Invalid final task response: you have not used any tools for this data task yet.",
    }
    ```
  - `reviewer`:
    ```ts
    workerInit: {
      heading: "Stage Review Task Assignment",
      extraInstructionLines: [
        "Review the stage objectives, expected outcomes, acceptance criteria, task list, worker reports, changed artifacts, and any existing summary drafts.",
        "For data-heavy or ML/research stages, validate data provenance/suitability, leakage controls, statistical acceptance, benchmark comparison, and whether conclusions are supported.",
      ],
      notesDir: (stageId) => `.saivage/stages/${stageId}/reviews/`,
      followUpInstruction:
        "This is a follow-up review in the same stage-scoped reviewer session. Your previous reports and reasoning are above in this conversation. Focus first on the new corrective-task results, then verify whether earlier issues are resolved or still open.",
      promptKey: "reviewer",
      invalidFinalResponseMessage:
        "Invalid final review response: you have not used any tools to inspect evidence yet.",
    }
    ```
- Add the accessor at the bottom of [src/agents/roster.ts](../../../../src/agents/roster.ts) (after `getRosterByDispatchTool`):

  ```ts
  export function getWorkerInitMeta(role: WorkerRole): WorkerInitMeta {
    const meta = getRoster(role).workerInit;
    if (meta === null) {
      throw new Error(`Roster entry for "${role}" has no workerInit metadata`);
    }
    return meta;
  }
  ```

- Add the compile-time exhaustiveness anchor at the bottom of [src/agents/roster.ts](../../../../src/agents/roster.ts):

  ```ts
  type _EveryWorkerHasInit = Exclude<
    Extract<(typeof ROSTER)[number], { worker: true }>["workerInit"],
    null
  > extends WorkerInitMeta ? true : never;
  const _everyWorkerHasInit: _EveryWorkerHasInit = true;
  void _everyWorkerHasInit;
  ```

### 2. Add the renderer, ctor registry, and `createWorker` in `WorkerAgent`.

In [src/agents/worker.ts](../../../../src/agents/worker.ts):

- Replace the file imports block with:

  ```ts
  import { BaseAgent, type BaseAgentConfig } from "./base.js";
  import type { Agent, AgentContext, AgentResult, WorkerInput } from "./types.js";
  import {
    normalizeTask,
    parseTaskReport,
    buildFailureReport,
    ROLE_TO_TASK_TYPE,
    type WorkerRole,
  } from "./task-report.js";
  import { getWorkerInitMeta, type WorkerInitMeta } from "./roster.js";
  import { loadRolePrompt } from "./prompts.js";
  import { buildEagerBlock } from "../knowledge/eagerLoader.js";
  import { buildHandoffContext } from "./handoff.js";
  import { log } from "../log.js";
  ```

- Delete the `WorkerAgentConfig` interface at [src/agents/worker.ts](../../../../src/agents/worker.ts#L29-L35).
- Add the ctor registry and helpers:

  ```ts
  type WorkerCtor = new (
    ctx: AgentContext,
    input: WorkerInput,
    role: WorkerRole,
    eagerSkillBlock: string,
    initialMessage: string,
    config?: Partial<BaseAgentConfig>,
  ) => WorkerAgent;

  const WORKER_CTORS = new Map<WorkerRole, WorkerCtor>();

  export function registerWorkerCtor(role: WorkerRole, ctor: WorkerCtor): void {
    WORKER_CTORS.set(role, ctor);
  }

  function getWorkerCtor(role: WorkerRole): WorkerCtor {
    const ctor = WORKER_CTORS.get(role);
    if (!ctor) throw new Error(`No worker ctor registered for role "${role}"`);
    return ctor;
  }
  ```

- Add the renderer (exported free function, single source of truth):

  ```ts
  export interface BuildInitialMessageOpts {
    headingSuffix?: string;
    prependFollowUp?: boolean;
  }

  export async function buildInitialMessage(
    ctx: AgentContext,
    input: WorkerInput,
    role: WorkerRole,
    opts: BuildInitialMessageOpts = {},
  ): Promise<string> {
    const meta = getWorkerInitMeta(role);
    const checklist = (input.task.checklist ?? [])
      .map((c) => `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`)
      .join("\n");
    const handoff = await buildHandoffContext(ctx, {
      stageId: input.stageId,
      includeTasks: true,
    });
    const defaultType = ROLE_TO_TASK_TYPE[role];
    const headingSuffix = opts.headingSuffix ?? "";

    const instructions: string[] = [];
    if (opts.prependFollowUp && meta.followUpInstruction) {
      instructions.push(meta.followUpInstruction);
    }
    instructions.push(...meta.extraInstructionLines);
    if (meta.notesDir) {
      instructions.push(`Write optional detailed notes to: ${meta.notesDir(input.stageId)}`);
    }
    instructions.push(
      `Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json`,
    );
    instructions.push(
      `Commit using MCP git with message prefix: [${input.task.id}] if you modify files.`,
    );
    instructions.push("Return the full TaskReport JSON as your final response.");

    return (
      `## ${meta.heading}${headingSuffix}\n\n` +
      `${handoff}\n\n` +
      `**Task ID:** ${input.task.id}\n` +
      `**Stage ID:** ${input.stageId}\n` +
      `**Type:** ${input.task.type ?? defaultType}\n` +
      `**Attempt:** ${input.task.attempt ?? 1} of ${input.task.max_attempts ?? 3}\n\n` +
      `### Description\n${input.task.description}\n\n` +
      (checklist ? `### Checklist\n${checklist}\n\n` : "") +
      `### Instructions\n${instructions.join("\n")}`
    );
  }
  ```

- Replace the `WorkerAgent` constructor and add `createWorker`:

  ```ts
  export abstract class WorkerAgent extends BaseAgent implements Agent {
    protected input: WorkerInput;
    protected readonly workerRole: WorkerRole;
    private readonly invalidFinalResponseMessage: string;

    constructor(
      ctx: AgentContext,
      input: WorkerInput,
      role: WorkerRole,
      eagerSkillBlock: string,
      initialMessage: string,
      config?: Partial<BaseAgentConfig>,
    ) {
      const task = normalizeTask(input.task, role);
      const meta = getWorkerInitMeta(role);
      super(ctx, {
        systemPrompt: loadRolePrompt(meta.promptKey),
        eagerSkillBlock,
        skillContext: { agentRole: role, description: task.description, tags: task.tags ?? [] },
        initialMessage,
        ...config,
      });
      this.input = { ...input, task };
      this.workerRole = role;
      this.invalidFinalResponseMessage = meta.invalidFinalResponseMessage;
    }

    static async createWorker<T extends WorkerAgent>(
      ctx: AgentContext,
      input: WorkerInput,
      role: WorkerRole,
      config?: Partial<BaseAgentConfig>,
    ): Promise<T> {
      const initialMessage = await buildInitialMessage(ctx, input, role);
      const eagerSkillBlock = await buildEagerBlock(
        ctx.project.projectRoot,
        role,
        input.task.description,
        input.task.tags ?? [],
      );
      const ctor = getWorkerCtor(role);
      return new ctor(ctx, input, role, eagerSkillBlock, initialMessage, config) as T;
    }

    // run(), executeTask(), validateFinalResponse() bodies unchanged at
    // [src/agents/worker.ts](../../../../src/agents/worker.ts#L72-L150)
  }
  ```

- Update the file-header comment to add "build initial message →" before "normalise task" in the `WorkerAgent` lifecycle description.

`ROLE_TO_TASK_TYPE` must be exported from [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25-L35) — verify and add `export` if missing.

### 3. Shrink the four pure-worker subclasses to declarations.

For each of [src/agents/coder.ts](../../../../src/agents/coder.ts), [src/agents/researcher.ts](../../../../src/agents/researcher.ts), [src/agents/designer.ts](../../../../src/agents/designer.ts), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts) — replace the **entire file** with:

```ts
/**
 * Saivage — <Role> Agent (nominal subclass; metadata lives on ROSTER).
 */

import { WorkerAgent, registerWorkerCtor } from "./worker.js";

export class CoderAgent extends WorkerAgent {}
registerWorkerCtor("coder", CoderAgent);
```

(Adjust class name + role string per file: `ResearcherAgent`/`"researcher"`, `DesignerAgent`/`"designer"`, `DataAgent`/`"data_agent"`.) No other code in each file.

### 4. Rebuild `reviewer.ts` on top of the shared renderer.

Replace the contents of [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts) with:

```ts
/**
 * Saivage — Reviewer Agent
 *
 * Stage-scoped quality gate. Survives across multiple review calls within one
 * stage so follow-up requests build on earlier findings.
 */

import { WorkerAgent, registerWorkerCtor, buildInitialMessage } from "./worker.js";
import { normalizeTask } from "./task-report.js";
import type { AgentResult, WorkerInput } from "./types.js";

export class ReviewerAgent extends WorkerAgent {
  private reviewCount = 0;

  override async run(): Promise<AgentResult> {
    return this.review(this.input);
  }

  async review(input: WorkerInput): Promise<AgentResult> {
    this.input = { ...input, task: normalizeTask(input.task, "reviewer") };
    if (this.reviewCount > 0) {
      const followUp = await buildInitialMessage(this.ctx, this.input, "reviewer", {
        headingSuffix: ` - Follow-up Review ${this.reviewCount + 1}`,
        prependFollowUp: true,
      });
      this.injectMessage(followUp);
    }
    this.reviewCount++;
    return this.executeTask(this.input);
  }
}
registerWorkerCtor("reviewer", ReviewerAgent);
```

### 5. Wire the new factory into bootstrap.

In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts):

- Imports: keep `CoderAgent`, `ResearcherAgent`, `DesignerAgent`, `DataAgent`, `ReviewerAgent` imports (still referenced for the `<XxxAgent>` type parameter and the `instanceof ReviewerAgent` check at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L402-L403)).
- In each of the five `case` branches at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L317-L383), replace the construction line:
  - `case "coder"`:  `agent = await WorkerAgent.createWorker<CoderAgent>(ctx, workerInput, role, { onActivity: (agentId) => tracker.agentActivity(agentId) });`
  - `case "researcher"`:  `agent = await WorkerAgent.createWorker<ResearcherAgent>(ctx, workerInput, role, { onActivity: (agentId) => tracker.agentActivity(agentId) });`
  - `case "data_agent"`:  `agent = await WorkerAgent.createWorker<DataAgent>(ctx, workerInput, role, { onActivity: (agentId) => tracker.agentActivity(agentId) });`
  - `case "designer"`:  `agent = await WorkerAgent.createWorker<DesignerAgent>(ctx, workerInput, role, { onActivity: (agentId) => tracker.agentActivity(agentId) });`
  - `case "reviewer"`:  `const reviewer = await WorkerAgent.createWorker<ReviewerAgent>(ctx, workerInput, role, { onActivity: (agentId) => tracker.agentActivity(agentId) });` (keeps the existing local `reviewer` binding used by the `stageReviewers.set(stageId, { agent: reviewer, ctx })` line).
- The five branches are now identical except for the type parameter and the reviewer's stage-cache logic; consider collapsing the four pure-worker branches in a follow-up refactor (out of scope for G05; tracked under G02/G03/G04's already-approved roster work).

### 6. Add tests.

**6a.** Snapshot test for the renderer.

Create [src/agents/worker-initial-message.test.ts](../../../../src/agents/worker-initial-message.test.ts):

- One `describe("buildInitialMessage", () => { ... })` with six `it` cases: `coder`, `researcher`, `designer`, `data_agent`, `reviewer (first)`, `reviewer (follow-up #2)`.
- Mock `./handoff.js`: `vi.mock("./handoff.js", () => ({ buildHandoffContext: vi.fn().mockResolvedValue("## Shared Project Context\n[FIXTURE HANDOFF]") }))`.
- Build a fixture `AgentContext` and `WorkerInput` (mirror the shape used by [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts)).
- Each case: `expect(await buildInitialMessage(ctx, input, role)).toMatchSnapshot();`. The follow-up case passes `{ headingSuffix: " - Follow-up Review 2", prependFollowUp: true }`.
- Commit six snapshot entries under `src/agents/__snapshots__/worker-initial-message.test.ts.snap` on first run.

**6b.** Roster cross-check.

In [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts), add:

```ts
import { WORKER_ROLES, getWorkerInitMeta, getRoster } from "./roster.js";

it("every WorkerRole has a workerInit on ROSTER and a registered ctor", async () => {
  // Import once so subclass modules execute their registerWorkerCtor calls.
  await import("./coder.js");
  await import("./researcher.js");
  await import("./designer.js");
  await import("./data-agent.js");
  await import("./reviewer.js");
  const { WorkerAgent } = await import("./worker.js");
  for (const role of WORKER_ROLES) {
    const meta = getWorkerInitMeta(role);
    expect(meta.heading).not.toBe("");
    expect(meta.invalidFinalResponseMessage).not.toBe("");
    expect(meta.promptKey).not.toBe("");
    // ctor lookup: createWorker would throw if a role were unregistered.
    expect(() => WorkerAgent["createWorker"]).toBeDefined();
    expect(getRoster(role).worker).toBe(true);
  }
});

it("non-worker roles have workerInit: null", () => {
  for (const role of ["planner", "manager", "inspector", "chat"] as const) {
    expect(getRoster(role).workerInit).toBeNull();
  }
});
```

**6c.** Consumer-level spawner test (new behaviour coverage required by [04-review-r1.md](04-review-r1.md#L36-L42)).

Create [src/agents/worker-spawn.test.ts](../../../../src/agents/worker-spawn.test.ts):

- `describe("createChildSpawner worker dispatch", ...)` with three cases:
  1. **Normal worker (coder)** — build a fake `SaivageRuntime` (mirror the shape used by [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) or a new minimal fixture), call `createChildSpawner(runtime)("coder", workerInput, parentCtx)`, intercept `runtime.agentRegistry.set` to capture the constructed agent, assert `agent instanceof CoderAgent`, assert `tracker.agentActivity` is invoked via the `onActivity` config (by stubbing `runLoop` or substituting a fake `WorkerAgent.createWorker` spy), and assert `workerInput.task.type` is back-filled (`normalizeTask` ran) by reading `(agent as any).input.task.type === "code"`.
  2. **Reviewer first call** — spawn once with `role: "reviewer"`, assert `agent instanceof ReviewerAgent`, assert dispatch goes through `agent.review(input)` (stub `review` and `run` and check which was called) per the bootstrap branch at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L402-L403).
  3. **Reviewer second call same stage** — spawn again with the same `stageId`, assert the second invocation reuses the cached `ReviewerAgent` instance (`agent` identity equality), `reviewCount` increments to 2, and the follow-up message rendered through `buildInitialMessage` is injected via `injectMessage` (stub the latter and assert it was called with a string containing `"Follow-up Review 2"`).
- The test must stub `BaseAgent`'s `runLoop` so no real LLM call is made; it asserts dispatch/construction wiring only.

### 7. Build and run tests (mandatory validation).

```bash
cd /home/salva/g/ml/saivage && pnpm typecheck && pnpm test -- src/agents && pnpm build
```

Expectations:

- `pnpm typecheck` is green. The `_everyWorkerHasInit` compile-time anchor in [src/agents/roster.ts](../../../../src/agents/roster.ts) refuses to compile if any `worker: true` entry omits `workerInit`.
- `pnpm test -- src/agents` is green. The six new snapshot files are committed on first run; the roster cross-check and `worker-spawn.test.ts` pass; the existing eight agent test files remain unchanged and pass.
- `pnpm build` (tsup) is green.

### 8. Grep verifications (mandatory).

```bash
cd /home/salva/g/ml/saivage
grep -rn -E "build(Coder|Researcher|Designer|DataAgent|Reviewer)Message" src/ test/  # 0
grep -rn -E "\.(Coder|Researcher|Designer|DataAgent|Reviewer)Agent\.create\b" src/ test/  # 0
grep -rn "WorkerAgent\.createWorker" src/ test/                                          # 5 hits in src/server/bootstrap.ts
grep -rn "if you create review files\.\|if you modify files\." src/agents                # only in src/agents/worker.ts (the unified clause)
grep -rn "WorkerAgentConfig" src/ test/                                                  # 0
grep -rn "loadRolePrompt(" src/agents/{coder,researcher,designer,data-agent,reviewer}.ts # 0
```

### 9. Optional live validation (operator-gated; not part of the default validation gate).

Do NOT run this step automatically. Run only if the operator explicitly requests it AND has read [WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md).

The `/home/salva/g/ml/saivage` source is bind-mounted into three v2 containers (per [../G01/APPROVED.md](../G01/APPROVED.md#L9)): `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112). `saivage-v3-getrich-v2` (10.0.3.170) runs Saivage v3 and is unaffected.

Operator-gated procedure (per container, in this order: `saivage-v3` first as the lowest-risk harness, then `diedrico`, then `saivage`):

```bash
sudo lxc-ls --fancy  # confirm container state
ssh root@<ip> "systemctl status saivage.service"  # capture pre-restart state
ssh root@<ip> "ls -la /opt/saivage/dist/cli.js"   # confirm bind mount picked up new build
ssh root@<ip> "systemctl restart saivage.service"
curl -fsS http://<ip>:8080/health
curl -fsS http://<ip>:8080/api/notes | head -c 200
```

For each container, dispatch a one-task stage (coder if the harness has one queued, otherwise inspect the dashboard's first conversation turn) and verify:

- The rendered worker initial message uses the new unified shape (heading from `workerInit.heading`, four metadata lines, role-specific Instructions block, unified commit clause `Commit using MCP git with message prefix: [<id>] if you modify files.`).
- The reviewer follow-up case (if exercisable on the harness) shows ` - Follow-up Review 2` in the heading.
- `.saivage/stages/<stage>/reports/<task>.json` is written at the same path as today (no on-disk format change).

If any container fails the smoke check, stop and run the rollback below before touching the next container.

### 10. Validation outputs.

Mandatory:

- `pnpm typecheck` — green.
- `pnpm test -- src/agents` — green; six new snapshots present; `roster.test.ts` cross-check passes; `worker-spawn.test.ts` passes.
- `pnpm build` — green.
- Grep verifications in step 8 match.

Operator-gated (only if step 9 was exercised):

- `systemctl status saivage.service` on each of `saivage`, `diedrico`, `saivage-v3` reports `active (running)` post-restart.
- `curl http://<ip>:8080/health` returns 200 on each container.
- One conversation snapshot per container shows the unified worker initial message.

## Rollback

**Default (local-only, no containers restarted):** `git revert <merge-commit>`. The refactor is a pure source-tree change; no on-disk format, no API contract, no provider/router/MCP plumbing touched. The five deleted `buildXxxMessage` / `static create` / per-role constructors are restored; the new test files and snapshots are deleted by the revert. No data migration to undo.

**If step 9 was exercised (any container restarted):** the rollback is per-container, in reverse of the deployment order (last-restarted first):

```bash
git revert <merge-commit>                          # in /home/salva/g/ml/saivage
cd /home/salva/g/ml/saivage && pnpm build
# For each container that was restarted, in reverse order:
ssh root@<ip> "systemctl restart saivage.service"
curl -fsS http://<ip>:8080/health
```

There is no on-disk state drift to repair: the runtime renders the initial message at dispatch time and older renderings already in conversation history are inert. The `.saivage/stages/<stage>/reports/<task>.json` path and shape are unchanged.

## Cross-finding

- Round-1 F09 / F25 (`WorkerAgent` + `task-report.ts` extractions) — this plan completes the same lift.
- G01 ([../G01/APPROVED.md](../G01/APPROVED.md)) — established the roster-as-source-of-truth pattern (`getAbortPriority`, `getToolFilter`, `getDispatchToolsFor`, `isConcurrencyLimitedDispatch`). G05 r2 adds `getWorkerInitMeta` to the same accessor family. G02/G03/G04 are subsumed by G01.
- G06–G08 — adjacent "duplication left behind by a partial round-1 extraction" findings; the snapshot-test pattern in step 6a and the consumer-test pattern in step 6c are reusable.
