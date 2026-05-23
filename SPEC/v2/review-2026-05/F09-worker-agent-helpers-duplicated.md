# F09 — Worker agents duplicate `normalizeTask` / `parseTaskReport` / `buildFailureReport`

**Category**: duplication
**Severity**: high
**Transversality**: architectural

## Summary

Five worker-style agents (coder, researcher, data-agent, reviewer, designer) ship near-identical copies of `normalizeTask`, `parseTaskReport`, and `buildFailureReport`. Inspector replicates a sixth variant for `InspectionReport`. The functions are ~150 lines combined per file and use the same `raw: any` shape — meaning each fix must be applied five (or six) times and currently isn't.

## Evidence

- `function normalizeTask(raw: any)`:
  - [src/agents/coder.ts](src/agents/coder.ts#L212)
  - [src/agents/researcher.ts](src/agents/researcher.ts#L208)
  - [src/agents/data-agent.ts](src/agents/data-agent.ts#L125)
  - [src/agents/reviewer.ts](src/agents/reviewer.ts#L148)
  - [src/agents/designer.ts](src/agents/designer.ts#L142) (orphan, drifts independently)
- `function buildFailureReport(...)`:
  - [src/agents/coder.ts](src/agents/coder.ts#L319)
  - [src/agents/researcher.ts](src/agents/researcher.ts#L313)
  - [src/agents/data-agent.ts](src/agents/data-agent.ts#L229)
  - [src/agents/reviewer.ts](src/agents/reviewer.ts#L259)
  - [src/agents/designer.ts](src/agents/designer.ts#L244)
- Each pairs with a `parseTaskReport` that uses the F03 JSON regex (see F03 for the line numbers).

## Why this matters

This is the single largest source of mechanical drift in the codebase. The orphan `designer.ts` already has stale copies relative to the live four; any extension (new TaskReport field, new normalisation rule) must be made in five places and currently isn't. Extracting one `task-report.ts` helper module would remove ~750 lines of duplication and let each agent file shrink to system-prompt + finalisation.

## Related

- F01 (designer is orphan)
- F03 (naive JSON parsing — duplicated within these duplicates)
- F18 (prompt bloat compounds with this)
