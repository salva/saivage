# G11 — APPROVED

**Chosen proposal**: Proposal B (per [02-design-r3.md](02-design-r3.md)) — delete the fuzzy free-text restart heuristic from `ChatAgent`, keep Planner restart behind the existing `/restart-planner` local slash command, and rewrite the five Chat system-prompt directives at [prompts/chat.md](../../../../prompts/chat.md#L7) (L7), L33, L43, L51, and L73 so Chat never claims to restart the Planner. Free-text restart requests are answered by directing the user to `/restart-planner <reason>`. The "Restart cautiously" guideline at L73 is removed outright because after the code shortcut is gone Chat has no restart action to be cautious about. Proposal A (multilingual regex + negation guards) is explicitly rejected — it preserves a free-text control protocol and contradicts the architecture-first rule.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md). All three r2 changes addressed (prompt L73 included, regex semantics corrected including the `i` flag and `\bplanner\b` matching `planner's`, cross-finding grep replaced with literal markers `tryHandleExplicitPlannerRestart`, `restartPlanner(this.localCommandContext(`, and `\b(restart|reset|relaunch)\b`).

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md). Includes a ChatAgent-level regression test using the existing fake-channel/router harness in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) that proves free text like "Why did the planner restart yesterday?" reaches the router and does NOT call `plannerControl.requestRestart` or publish a restart event.

**Daemon impact**: Operator-gated. Live smoke check on `saivage-v3` (10.0.3.112) optional; `saivage` (10.0.3.111) and `diedrico` (10.0.3.113) untouched.
