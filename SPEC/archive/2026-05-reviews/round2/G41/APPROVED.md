# G41 — APPROVED

**Chosen proposal**: Per [02-design-r2.md](02-design-r2.md) — introduce a shared web-side `PlanStage` interface that mirrors the canonical Zod `StageSchema` field-by-field (all 7 required fields with required arrays), narrow `AgentState.agent_type` to a literal `AgentRole` union of the 9 ROSTER roles, delete duplicate `AgentState`/`RuntimeState`/`Stage`/`Plan` declarations from `PlanView`, keep `HistoryEntry` local in `StatusPanel`/`PlanView` (it backs `/api/plan-history` and is out of G41 scope), and wire `vue-tsc` as a web devDep with a `typecheck` script chained into the Vite build.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All four r1 blockers addressed: full `PlanStage` mirror, consistent `HistoryEntry` handling, `PlanView` `Stage`/`Plan` deletion with anchored line ranges, real `vue-tsc` wiring (not the false claim that `npm run build` already ran it). New project-wide principles checked — no trigger for this finding.

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: Web-only; no daemon restart needed. Validation runs through `vue-tsc` + `vite build`.
