# G05 — Design r2

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
**Round-1 review**: [04-review-r1.md](04-review-r1.md) — CHANGES_REQUESTED (4 items).

## Round 2 deltas vs r1

Four reviewer-mandated changes ([04-review-r1.md](04-review-r1.md#L20-L48)) are applied here:

1. **No second registry.** R1 introduced `WORKER_ROLE_SPECS` next to `ROSTER` ([03-plan-r1.md](03-plan-r1.md#L49-L53), [03-plan-r1.md](03-plan-r1.md#L84-L85)). r2 folds the worker-init metadata into `ROSTER` itself as a new optional `workerInit: WorkerInitMeta | null` field on each `RosterEntry` (populated on the five worker entries, `null` on the four non-worker entries). The runtime reads it through one accessor: `getWorkerInitMeta(role: WorkerRole): WorkerInitMeta`. The only residual table — `WORKER_CTORS` in [src/agents/worker.ts](../../../../src/agents/worker.ts) — is ctor wiring, not metadata, and is mandatory because `roster.ts` cannot import any agent class without an import cycle (see Analysis §9). It is exhaustive-checked by a roster cross-check test ([03-plan-r2.md](03-plan-r2.md) step 7).
2. **One exact, compile-checkable API.** r1 had two contradictory constructor signatures and two contradictory `buildInitialMessage` exports ([04-review-r1.md](04-review-r1.md#L26-L34)). r2 fixes both:
   - `WorkerAgent` constructor: `(ctx, input, role, eagerSkillBlock, initialMessage, config?)` — one shape, used by `createWorker` and by every empty nominal subclass via the inherited base constructor (no explicit subclass constructors).
   - `buildInitialMessage` is **exported** from [src/agents/worker.ts](../../../../src/agents/worker.ts) (free function, not a method) so the reviewer follow-up path imports it directly. Internally called by `createWorker`.
   - Nominal subclasses are bare `export class CoderAgent extends WorkerAgent {}` — no constructor, no overrides — with one trailing `registerWorkerCtor("coder", CoderAgent);` line. They rely on the inherited base constructor.
3. **Behaviour coverage at the consumer level.** r2 adds a `createChildSpawner` test ([03-plan-r2.md](03-plan-r2.md) step 6c) covering at minimum: normal worker (one of coder/researcher/designer/data_agent) and reviewer (first call goes via `agent.review(...)`, second call into the same `stageId` reuses the cached `ReviewerAgent` and injects the follow-up message). Onactivity propagation, `normalizeTask` back-fill of `task.type`, and the reviewer follow-up rendering are asserted, not just the renderer snapshot.
4. **Local-only validation by default; live validation is operator-gated and covers every bind-mounted v2 harness.** r2 keeps `pnpm typecheck`, `pnpm test`, `pnpm build`, and grep checks as the **mandatory** validation gate. The "restart `saivage.service` and dispatch a task" step is moved to an explicitly-gated optional section that, if exercised, MUST cover `saivage` (10.0.3.111), `diedrico` (10.0.3.113), and `saivage-v3` (10.0.3.112) — the three containers that bind-mount `/home/salva/g/ml/saivage` to `/opt/saivage` (per [../G01/APPROVED.md](../G01/APPROVED.md#L9)). `saivage-v3-getrich-v2` (10.0.3.170) runs Saivage v3 and is unaffected.

---

## Chosen design — Proposal B (refined)

Proposal A (single helper, leave the five subclasses alone) is rejected for r2: the reviewer accepted A as a fallback if B remained registry-heavy ([04-review-r1.md](04-review-r1.md#L62-L66)). r2 removes the second registry, so B becomes the cleaner architecture-first answer and A's "still keep five `static create` factories and five constructors" downside no longer needs to be paid.

### Idea

Move the message construction *and* the factory boilerplate *and* the per-role data (prompt key, invalid-final message, heading, extra instruction lines, notes dir, follow-up paragraph) into `WorkerAgent` and `ROSTER`. Each subclass becomes a one-class-one-register line file. The dispatcher in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) calls `WorkerAgent.createWorker<XxxAgent>(ctx, input, role, config?)` for all five workers.

### Single source of truth: `ROSTER.workerInit`

Add to [src/agents/roster.ts](../../../../src/agents/roster.ts):

```ts
import type { RolePromptName } from "./prompts.js";

export interface WorkerInitMeta {
  heading: string;
  extraInstructionLines: readonly string[];   // [] when none; not optional
  notesDir: ((stageId: string) => string) | null;
  followUpInstruction: string | null;
  promptKey: RolePromptName;
  invalidFinalResponseMessage: string;
}

export interface RosterEntry {
  // ...existing fields...
  /** Worker-only initial-message metadata; null for non-worker roles. */
  workerInit: WorkerInitMeta | null;
}

export function getWorkerInitMeta(role: WorkerRole): WorkerInitMeta {
  const meta = getRoster(role).workerInit;
  if (meta === null) {
    throw new Error(`Roster entry for "${role}" has no workerInit metadata`);
  }
  return meta;
}
```

The five worker entries gain a `workerInit: { ... }` populated literal (see plan §1 for the exact values). The four non-worker entries gain `workerInit: null`. A `tsc --noEmit` checks coverage because the `RosterEntry` field is non-optional and the `as const satisfies readonly RosterEntry[]` assertion at [src/agents/roster.ts](../../../../src/agents/roster.ts#L210) refuses to compile if any entry omits the field.

A second compile-time check is added at the bottom of [src/agents/roster.ts](../../../../src/agents/roster.ts):

```ts
type EveryWorkerHasInit = Exclude<
  Extract<(typeof ROSTER)[number], { worker: true }>["workerInit"],
  null
> extends WorkerInitMeta ? true : never;
const _everyWorkerHasInit: EveryWorkerHasInit = true;
```

This forces every entry with `worker: true` to have a non-null `workerInit`. If a future commit flips `worker: true` without populating `workerInit`, `tsc` fails at this anchor.

The cyclic-import constraint: `roster.ts` already imports `RolePromptName` from `prompts.ts` is **not** acceptable because `prompts.ts` imports `renderRosterSummary` from `roster.ts` ([src/agents/prompts.ts](../../../../src/agents/prompts.ts#L13)). r2 breaks the cycle by lifting `RolePromptName` out of `prompts.ts` into a new tiny module [src/agents/prompt-keys.ts](../../../../src/agents/prompt-keys.ts) (just the union type, no runtime), re-exported from `prompts.ts` for back-compat-free callers. Both `roster.ts` and `prompts.ts` import from `prompt-keys.ts`. This is a four-line change and removes the existing `role === "data-agent" ? "data_agent" : role` magic in [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L54-L57) by sourcing the `promptKey` from roster directly via `getRoster(role).workerInit?.promptKey` for workers (non-workers keep their literal call sites).

### Unified renderer and factory in `WorkerAgent`

Add to [src/agents/worker.ts](../../../../src/agents/worker.ts):

```ts
import {
  getWorkerInitMeta,
  type WorkerInitMeta,
} from "./roster.js";

const WORKER_CTORS = new Map<
  WorkerRole,
  new (
    ctx: AgentContext,
    input: WorkerInput,
    role: WorkerRole,
    eagerSkillBlock: string,
    initialMessage: string,
    config?: Partial<BaseAgentConfig>,
  ) => WorkerAgent
>();

export function registerWorkerCtor<T extends WorkerAgent>(
  role: WorkerRole,
  ctor: new (
    ctx: AgentContext,
    input: WorkerInput,
    role: WorkerRole,
    eagerSkillBlock: string,
    initialMessage: string,
    config?: Partial<BaseAgentConfig>,
  ) => T,
): void {
  WORKER_CTORS.set(role, ctor);
}

function getWorkerCtor(role: WorkerRole) {
  const ctor = WORKER_CTORS.get(role);
  if (!ctor) throw new Error(`No worker ctor registered for role "${role}"`);
  return ctor;
}

export interface BuildInitialMessageOpts {
  headingSuffix?: string;          // reviewer follow-up only
  prependFollowUp?: boolean;       // reviewer follow-up only
}

export async function buildInitialMessage(
  ctx: AgentContext,
  input: WorkerInput,
  role: WorkerRole,
  opts: BuildInitialMessageOpts = {},
): Promise<string> { /* renderer body from Analysis §4 */ }
```

`WorkerAgent` itself:

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
      ctx.project.projectRoot, role, input.task.description, input.task.tags ?? [],
    );
    const ctor = getWorkerCtor(role);
    return new ctor(ctx, input, role, eagerSkillBlock, initialMessage, config) as T;
  }

  // existing run(), executeTask(), validateFinalResponse() unchanged
}
```

The old `WorkerAgentConfig` interface at [src/agents/worker.ts](../../../../src/agents/worker.ts#L29-L35) is deleted.

### Subclass files become declarations

[src/agents/coder.ts](../../../../src/agents/coder.ts), [src/agents/researcher.ts](../../../../src/agents/researcher.ts), [src/agents/designer.ts](../../../../src/agents/designer.ts), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts):

```ts
import { WorkerAgent, registerWorkerCtor } from "./worker.js";

export class CoderAgent extends WorkerAgent {}
registerWorkerCtor("coder", CoderAgent);
```

That is the entire file. No constructor (inherits base), no `static create`, no `buildXxxMessage`, no `loadRolePrompt`, no `buildEagerBlock`, no `invalidFinalResponseMessage` literal, no `BaseAgentConfig` import.

[src/agents/reviewer.ts](../../../../src/agents/reviewer.ts) keeps a body because it owns `reviewCount`, `override run()`, and the follow-up `review(input)` method:

```ts
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

No `static create`, no `buildReviewerMessage`, no positional constructor, no `loadRolePrompt`, no `buildEagerBlock`.

### Bootstrap changes

[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L317-L383): each of the five `case` branches replaces

```ts
agent = await XxxAgent.create(ctx, workerInput, { onActivity: ... });
```

with

```ts
agent = await WorkerAgent.createWorker<XxxAgent>(ctx, workerInput, role, { onActivity: ... });
```

The `role` variable already exists in scope (it is the `switch` discriminant). The reviewer `case` keeps the stage-session cache and the `agent.review(input)` dispatch path at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L353-L403) unchanged in shape — only the construction expression changes.

### Deletion list

- `buildCoderMessage`, `buildResearcherMessage`, `buildDesignerMessage`, `buildDataAgentMessage`, `buildReviewerMessage` (5 free functions across 5 files).
- The three drifted commit-clause sentences — replaced by one unified clause `Commit using MCP git with message prefix: [${id}] if you modify files.` rendered once in `buildInitialMessage`.
- `static async create(ctx, input, config?)` factory in `CoderAgent`, `ResearcherAgent`, `DesignerAgent`, `DataAgent`, `ReviewerAgent` (5 methods).
- Per-subclass positional constructor in the same five files (5 constructors). The four pure-worker subclasses become bodyless.
- `WorkerAgentConfig` interface at [src/agents/worker.ts](../../../../src/agents/worker.ts#L29-L35).
- Five `loadRolePrompt("<role>")` calls in subclass constructors.
- Five `invalidFinalResponseMessage` string literals in subclass constructors (moved into `ROSTER`).
- Five `buildEagerBlock(...)` calls in subclass `static create` (moved into `createWorker`).
- Per-subclass `type` defaults in the five `**Type:**` lines (the renderer reads `ROLE_TO_TASK_TYPE` directly).
- The `role === "data-agent" ? "data_agent" : role` magic in [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L54-L57) (the renderer-side mapping disappears once roster owns `promptKey`).

Net subclass-file reduction: ~250 lines → ~25 (4 × 3-line files + reviewer at ~22 lines).

### Test impact

- No existing test imports any `build*Message` function or `XxxAgent.create` factory (verified by grep, Analysis §7), so nothing is broken by removal.
- One new snapshot test [src/agents/worker-initial-message.test.ts](../../../../src/agents/worker-initial-message.test.ts): six cases (one per role + reviewer follow-up) asserting `buildInitialMessage(...)` matches a committed snapshot.
- One new behavioural test [src/agents/worker-spawn.test.ts](../../../../src/agents/worker-spawn.test.ts) (or extension of [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts)) exercising `WorkerAgent.createWorker<CoderAgent>(...)` and a reviewer dispatch round-trip via `createChildSpawner` — asserts subclass identity (`instanceof`), `onActivity` propagation, `normalizeTask` back-fill of `task.type`, and reviewer stage-cache reuse + follow-up message injection.
- One new roster cross-check in [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts): for every `WorkerRole`, assert `getWorkerInitMeta(role)` returns a non-empty `heading`, a non-empty `invalidFinalResponseMessage`, a resolvable `promptKey`, and that the role is registered in `WORKER_CTORS`.

### Trade-offs

- ✅ One owner for worker-role metadata: `ROSTER`. No second registry.
- ✅ One compile-checkable constructor signature (`(ctx, input, role, eagerSkillBlock, initialMessage, config?)`).
- ✅ One exported `buildInitialMessage` — same entry point for the factory and for reviewer's follow-up.
- ✅ Four of the five subclass files shrink to 3 lines; the reviewer keeps only the genuinely role-specific override (`reviewCount` + follow-up flow).
- ✅ Commit-clause drift eliminated by construction.
- ✅ Architecture-first: matches the G01 roster-as-source-of-truth pattern explicitly.
- ❌ Larger blast radius than Proposal A: `WorkerAgent`'s constructor signature changes, `ROSTER` gains a field, `bootstrap.ts` changes five lines, `prompts.ts` loses one magic branch. Mitigated by the consumer-level test in §6c of the plan.
- ❌ `WORKER_CTORS` is a second table by line count, but it holds only `role → class` bindings (not metadata) and is exhaustive-checked by the roster cross-check test. The reviewer's "no second role-spec registry" objection is about metadata; this is plumbing.

### Why not Proposal A in r2

Proposal A leaves the five `static create` factories and five subclass constructors in place. Once r2 has solved the "no second registry" problem by putting `workerInit` on `ROSTER`, the only remaining argument for A would be smaller blast radius — and the smaller blast radius costs ~175 lines of remaining boilerplate plus the same five copies of `loadRolePrompt`, `buildEagerBlock`, and `invalidFinalResponseMessage` strings that the cross-finding pattern G01–G04 has decided to delete. Architecture-first guideline rules out the smaller change.
