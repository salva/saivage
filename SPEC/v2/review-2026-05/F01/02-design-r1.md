# F01 — Design proposals (R1)

Three proposals, all consistent with the operator note "Wire this agent in the system! Do not remove it!!!" (so straight deletion is not on the table) and with [F09 APPROVED](../F09/APPROVED.md) Proposal C (extract `WorkerAgent` + `task-report.ts`, delete the current orphan in the F09 commit). Project guideline applies: no backward compatibility, no migration shim, no "old + new" parallel period.

## Proposal A — Wire the existing orphan in-place, before F09

Land F01 first. Keep [src/agents/designer.ts](../../../../src/agents/designer.ts) as-is (with its private `normalizeTask` / `parseTaskReport` / `buildFailureReport`), add the missing wiring on every surface listed in [01-analysis-r1.md](01-analysis-r1.md#contract-a-wired-designer-must-satisfy), and let F09 subsequently rewrite `designer.ts` to extend `WorkerAgent` when it converts the other four workers.

### Scope of edits

- 1 file kept (`src/agents/designer.ts`, 267 lines unchanged — its 4 private helpers are not deleted).
- 9 files edited: `src/agents/types.ts`, `src/types.ts`, `src/routing/resolver.ts`, `src/runtime/self-check.ts`, `src/runtime/dispatcher.ts`, `src/agents/base.ts` (`RUN_DESIGNER_SCHEMA` + `ROLE_DISPATCH_TOOLS.manager`), `src/server/bootstrap.ts` (`createChildSpawner` switch + `resolveAgentRoute` reachability), `src/index.ts` (barrel), `src/agents/manager.ts` (worker roster narrative + `hasUsedToolNamed` guard).
- 1 test file edited: `src/agents/agents.test.ts` adds a `DesignerAgent` smoke test mirroring [agents.test.ts L439-end](../../../../src/agents/agents.test.ts#L439).

### Risk profile

Medium. The wiring itself is mechanical and well-scoped. The real cost is that F09 will then re-edit `src/agents/designer.ts` to delete its private helpers and rebase it onto `WorkerAgent`, so the orphan file is touched twice across two commits — first to wire it, then to refactor it. Conflict risk is low because F09 is also rewriting `coder.ts` / `researcher.ts` / `data-agent.ts` / `reviewer.ts` in the same pass, but it imposes ordering: F01 must merge before F09 starts editing `designer.ts`.

### Forbids / does not enable

- Forbids F09 deleting `designer.ts` outright (the file now has live wiring). F09's step 7 ([F09/03-plan-r2.md](../F09/03-plan-r2.md)) becomes "convert designer.ts to `WorkerAgent` like the other four workers" instead of "delete it".
- Does not improve the duplication problem until F09 lands.

### Recommendation note

Solves the operator's request immediately, but knowingly admits ~150 lines of duplicated helper code into the wired system for the window between F01 and F09. Wasteful when F09 is already approved.

---

## Proposal B — Wire the orphan in-place AND extract the helpers in the F01 commit

Land F01 with both the wiring AND the F09 helper extraction (only enough of F09 to remove `designer.ts`'s private helpers). Adds `src/agents/task-report.ts` containing `normalizeTask` / `parseTaskReport` / `buildFailureReport` keyed by `WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer" | "designer"`, makes `DesignerAgent` import from it, and keeps the other four workers untouched (they keep their private copies until F09 lands).

### Scope of edits

- 1 file added: `src/agents/task-report.ts` (~120 lines, lifted from coder's helpers with `agent: role` parameterised).
- `src/agents/designer.ts` shrinks from 267 to ~80 lines (delete the 4 private functions, delete `buildDesignerMessage`'s `agent: "designer"` constants, import from `task-report.ts`). Class still extends `BaseAgent` directly.
- Same 9 wiring edits as Proposal A.
- Same test addition as Proposal A.

### Risk profile

Medium-high. Stealing F09's `task-report.ts` extraction into the F01 commit pre-empts a chunk of F09's approved scope and creates a merge conflict surface when F09 lands — F09's plan ([F09/03-plan-r2.md step 1](../F09/03-plan-r2.md)) is the explicit creator of `src/agents/task-report.ts`. If F01 also creates it, one of the two commits has to be edited to drop the file creation, and F09's commit ordering note becomes moot.

### Forbids / does not enable

- Forbids F09 from creating `task-report.ts` as a new file (must convert step 1 of F09's plan into "move helpers from coder/researcher/data-agent/reviewer into the existing `task-report.ts`").
- Does not extract `WorkerAgent`. Designer still has its own `run()` skeleton until F09's step 2 lands.

### Recommendation note

Splits the difference and ends up with the worst of both worlds: enough of F09 to break F09's pre-condition, but not enough of F09 to remove the `run()` skeleton duplication. Picks up scope that wasn't asked of F01. Not recommended.

---

## Proposal C — Defer wiring until after F09 lands (recommended)

Land F09 first exactly as approved. F09's step 7 deletes the orphan [src/agents/designer.ts](../../../../src/agents/designer.ts) (267 lines of stale duplicates gone). Then F01 lands a single follow-up commit that creates a fresh, minimal `src/agents/designer.ts` as a `WorkerAgent` subclass and performs all eleven wiring edits.

### Shape after F09 + F01

```ts
// src/agents/designer.ts (new, ~80 lines)
import { WorkerAgent, type WorkerAgentConfig } from "./worker.js";
import type { AgentContext, WorkerInput } from "./types.js";
import { buildHandoffContext } from "./handoff.js";

const DESIGNER_PROMPT = `# Designer — System Prompt
... // single-file system prompt, lifted verbatim from the deleted orphan
`;

function buildDesignerMessage(ctx: AgentContext, input: WorkerInput): string {
  // single function, lifted from the deleted orphan
}

export class DesignerAgent extends WorkerAgent {
  constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<WorkerAgentConfig>) {
    super(ctx, input, {
      role: "designer",
      systemPrompt: DESIGNER_PROMPT,
      buildInitialMessage: (i) => buildDesignerMessage(ctx, i),
      invalidFinalResponseMessage: "Invalid final design response: you have not used any tools for this design task yet.",
      ...config,
    });
  }
}
```

That is the whole agent. Run loop, finishReason switch, `parseTaskReport`, `buildFailureReport`, `validateFinalResponse`, log lines — all inherited from `WorkerAgent` and `task-report.ts` created by F09. The 250-line system prompt and the small initial-message builder are the only Designer-specific code paths.

### Scope of edits (F01 commit, after F09 has merged)

- 1 file added: `src/agents/designer.ts` (~80 lines).
- 9 files edited: same surfaces as Proposal A — `types.ts` (agent role enum), `src/types.ts` (4 Zod enums), `routing/resolver.ts`, `runtime/self-check.ts`, `runtime/dispatcher.ts`, `agents/base.ts` (schema + manager dispatch tools), `server/bootstrap.ts` (spawner switch), `index.ts` (barrel), `agents/manager.ts` (prompt + guard).
- 1 file edited: `src/agents/task-report.ts` — widen `WorkerRole` to include `"designer"` and `ROLE_TO_TASK_TYPE.designer = "design"`. Single line each.
- 1 test added: `src/agents/agents.test.ts` smoke test for `DesignerAgent`.

### Risk profile

Low. The new file is ~80 lines, the wiring edits are all tiny additions to enums and lookup tables, and the `WorkerAgent` base class is already shaken out by the four workers F09 converted in the same release. No file is touched twice across F01 and F09. No new abstractions; everything plugs into machinery F09 introduced.

### Enables

- Designer immediately gets every fix that lands later in `task-report.ts` (e.g. F03's JSON-extraction fix) without per-role edits.
- Future worker additions follow the same ~80-line subclass pattern.
- Designer benefits from F09's reviewer-double-push fix and `buildFailureReport.issues_found` unification with no extra work.

### Forbids

- Forbids landing F01 before F09 (creates ordering constraint, opposite of Proposal A).

### Recommendation note

Cleanest end-state. Smallest F01 patch. Zero re-edits. Aligns with the approved F09 plan's own cross-issue note. The only cost is sequencing: F01 cannot land until F09 has merged.

---

## Recommendation

**Proposal C** — defer F01 implementation to a follow-up commit that lands after [F09 APPROVED](../F09/APPROVED.md) is merged.

Reasons, in order of importance:

1. **Architecture-first project guideline.** Adding a fully-wired Designer that ships with its own copy of the worker helpers (Proposal A) or that pre-empts F09's `task-report.ts` extraction (Proposal B) violates the no-duplication / no-shim posture. Proposal C produces the only end-state where Designer's code path is `WorkerAgent` + a system prompt, with zero per-role helper duplication.
2. **F09 is already approved and explicitly anticipates this case.** [F09's cross-issue note in 03-plan-r2.md §5](../F09/03-plan-r2.md) reads: "F09 should land first and a fresh F01 commit can wire the now-`WorkerAgent`-based designer with ~20 lines of subclass code." Proposal C is literally the path F09's reviewer signed off on.
3. **Lowest churn.** Proposal C edits each file exactly once across the two commits. Proposals A and B both touch `designer.ts` twice.
4. **Operator note is honoured.** "Wire this agent in the system! Do not remove it!!!" is satisfied by the F01 follow-up commit. The temporary deletion-in-F09 is a refactoring step in the same release; in the wired runtime the operator ends up seeing, Designer exists.
