# Dual-LLM Loop Conventions (Saivage v2 Review 2026-05)

Every writer and reviewer subagent in this review reads this file first. It is the authoritative convention. Per-issue prompts only override or extend these defaults.

## Roles

- **Writer**: `Claude Opus 4.7 (copilot)`. Produces analysis, design (>=2 proposals), and implementation plan documents per issue.
- **Reviewer**: `GPT-5.5 (copilot)`. Critiques the writer's documents and returns one of two verdicts.

## Mandatory project guidelines (apply to every proposal)

1. **Architecture-first, NO backward compatibility.** Any "migration shim", "transitional alias", "deprecated-but-keep-for-now", "old + new during rollout", `@deprecated` tags introduced to preserve old code paths, or feature flags that only exist for transition are forbidden. Delete the old in the same change.
2. **Clean code, no over-engineering.** No abstractions used only once. No premature configurability. No defensive code at internal boundaries (only validate at system boundaries). Remove dead code, do not preserve it.
3. **No new docstrings/comments** on code you are not otherwise modifying.
4. **No emojis** anywhere.
5. **Concrete file:line references** as clickable markdown links relative to the repo root, e.g. `[src/agents/base.ts](src/agents/base.ts#L120-L140)`. Verify them against the actual files; do not invent.

## Per-issue directory layout

For issue `FNN-<slug>` the directory is `SPEC/v2/review-2026-05/FNN/`. Files within:

```
01-analysis-rN.md           # writer
02-design-rN.md             # writer; at least 2 proposals (focused + level-up)
03-plan-rN.md               # writer; plan for the recommended proposal only
04-review-rN.md             # reviewer; ends with VERDICT line
APPROVED.md                 # created by reviewer when verdict is APPROVED
```

Round 1 files are `r1`. Each successive writer revision bumps the round; the reviewer's review file matches the round number it is reviewing.

## Document structure

### Analysis (`01-analysis-rN.md`)
- "## Changes from rN-1" (only on r2+): bullet list of what was revised and why.
- "## Problem restated": concrete duplication / inconsistency / bug, with file:line refs.
- "## Actual differences" (if duplication): diff-flavored summary of how the duplicates actually diverge.
- "## Contract": input/output shapes, error modes, lifecycle.
- "## Call sites & dependencies": who consumes the code, what schemas constrain it.
- "## Constraints any solution must respect".

### Design (`02-design-rN.md`)
- "## Changes from rN-1" (r2+).
- **At least two proposals**: typically "Proposal A — focused fix" and "Proposal B — one conceptual level up". Add Proposal C if a genuinely distinct third option exists; do not invent options for the sake of count.
- For each proposal: scope (files touched), what gets added/removed, risk, what it enables (cross-link to other Fxx), what it forbids, recommendation note.
- "## Recommendation": which proposal you pick and why.

### Plan (`03-plan-rN.md`)
- For the recommended proposal only.
- Ordered concrete edit steps with file paths.
- Test strategy: which existing tests cover this, what new tests are needed, exact commands to run.
- Validation commands using the project's `saivage` repo conventions:
  - `npm run typecheck`
  - `npm run build`
  - `npx vitest run [focused-path]` (the `saivage` repo uses Vitest per `vitest.config.ts`, NOT Jest — Jest is `saivage-v3`).
- Rollback strategy (typically: single commit, easy revert).
- Cross-issue ordering note: must this happen before/after any other Fxx?

### Review (`04-review-rN.md`)
- "## Reviewer": `GPT-5.5 (copilot)`.
- "## Documents reviewed": list with versions.
- "## Findings": Analysis / Design / Plan subsections, concrete points.
- "## Required changes": numbered, actionable. Empty if approving.
- "## Strengths": brief.
- **Final non-empty line MUST be exactly** `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`.

Reviewer policy:
- Reject ONLY for: project-guideline violations, factual errors (wrong file:line refs, wrong claims about code behavior), genuine executability gaps, or missing required deliverables.
- Do NOT reject for stylistic preferences. If the docs are good enough to hand to an engineer, approve.
- Do NOT introduce new categories of objection on r2+ unless they are equivalent in severity to r1 items.

### APPROVED.md (reviewer creates on approval)
```
# FNN Approved

- Chosen proposal: <A | B | C>
- Approving reviewer: GPT-5.5 (copilot)
- Final round: rN
- Analysis: 01-analysis-rN.md
- Design: 02-design-rN.md
- Plan: 03-plan-rN.md
```

## Loop control

- No round cap (user choice), BUT: if two consecutive rounds produce the same set of required changes (writer and reviewer disagree fundamentally), the reviewer should escalate by adding a "## ESCALATE" section above the VERDICT line and still emit `VERDICT: CHANGES_REQUESTED`. The orchestrator (human) will arbitrate.
- Writer revising round N+1: produce `0X-...-rN+1.md` (new files); do not overwrite history. Each rN+1 file starts with "## Changes from rN".
- If only one of {analysis, design, plan} needs revision, the writer revises only that one. The remaining files at the prior round number remain authoritative; the next reviewer call must treat them as such.

## Saivage v2 repo facts (use these, don't re-derive)

- Repo root: `/home/salva/g/ml/saivage`
- Test runner: Vitest (`vitest.config.ts`); existing tests live next to the code as `*.test.ts`.
- Type/build: `tsup` produces `dist/`. `tsconfig.json` is strict.
- Web UI: Vue 3 SFC under `web/src/`, Vite-built.
- Subsystem map: [00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md).
- Issue inventory: [00-INDEX.md](00-INDEX.md). One file per issue (`FNN-<slug>.md`) at the same directory level.
- Out-of-scope: `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/`, and any memory-related code. Another agent is working there; do NOT propose changes to it. If the cleanest fix would cross into that area, note the constraint and propose a fix that respects the boundary.

## Return contracts

Subagents return only:
- Absolute paths of files written.
- Verdict line verbatim (reviewer only).
- A 2-3 line summary.

Do NOT paste document contents in the return message.
