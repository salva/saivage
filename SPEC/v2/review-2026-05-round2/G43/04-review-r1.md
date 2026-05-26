# G43 - Review r1

## Findings

1. **Correct the current-runtime impact model before using it for severity and sequencing.**

   The analysis says the planner receives the broken skill today because "every agent gets every built-in" ([SPEC/v2/review-2026-05-round2/G43/01-analysis-r1.md](01-analysis-r1.md#L233)), and the plan repeats that the current bug is masked because the planner sees this body mixed with unrelated skills ([SPEC/v2/review-2026-05-round2/G43/03-plan-r1.md](03-plan-r1.md#L20-L25)). The production path does not behave that way. The current built-in walker synthesizes `triggers: [topic]`, `target_agents: []`, and `survive_compaction: false` ([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L103-L118)); the trigger scorer ignores bare triggers without a `kind:` prefix ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L57-L58)); and `resolveEagerRecords` drops zero-score, non-survivor skills ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L246-L251)).

   The finding is still real, and G43 can still need to land before G42 because G42's planned trigger/targeting normalization would make the remaining planner skill reachable. But the draft should say the bug is currently dormant because the broken built-ins are filtered out by the resolver, not because the planner prompt overrides a smeared eager block. That correction affects the "Why dormant" section, the severity wording, and the validation assumptions.

2. **Tighten the G42 coordination so Option C and the sibling plan agree.**

   Option C deletes the planner skill, but the fallback says that if G42 must land first, G42 should "apply step 6" from the G43 plan ([SPEC/v2/review-2026-05-round2/G43/03-plan-r1.md](03-plan-r1.md#L33-L35)). Step 6 is the no-op subsystem-map check ([SPEC/v2/review-2026-05-round2/G43/03-plan-r1.md](03-plan-r1.md#L86-L88)); the deletion is step 2 ([SPEC/v2/review-2026-05-round2/G43/03-plan-r1.md](03-plan-r1.md#L50-L52)). That is more than a numbering nit because the sibling G42 plan still assumes G43 rewrites the skill body, not deletes it ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](../G42/03-plan-r1.md#L8-L12)), and its manual targeting check still expects `SKILL: planning` in the planner block ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](../G42/03-plan-r1.md#L117)).

   Keep the landing order as G43 -> G42, but make the coordination explicit: after G43, G42's tests and docs must expect a three-skill bundle and an empty planner eager block unless a future planner-targeted skill is added. If the order is inverted, the G42 diff must include the deletion from step 2, not a later no-op step, and must remove its `planner -> planning` assertions in the same patch.

3. **Replace the transcript grep validation with sentinels that cannot match legitimate planner contract text.**

   The planner smoke asks reviewers to grep the planner transcript for `executor|dependsOn|"steps"|"goal"|"summary"` and expect zero hits ([SPEC/v2/review-2026-05-round2/G43/03-plan-r1.md](03-plan-r1.md#L123-L126)). `summary` is not fictional in general: `plan_complete_stage` takes a `summary` argument in the planner prompt ([prompts/planner.md](../../../../prompts/planner.md#L65)), `CompletedStage` and `StageSummary` both include `summary` fields ([src/types.ts](../../../../src/types.ts#L54-L62), [src/types.ts](../../../../src/types.ts#L180-L183)), and the plan tool schema exposes `summary` as a required input property ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L482-L487)). A transcript that includes tool schemas or structured returns can therefore fail this smoke while being perfectly correct.

   Make the negative check precise: assert the eager knowledge block no longer contains `--- SKILL: planning` or `## Planning Guidelines`, and if transcript greps are kept, look for the distinctive fictional shape (`"steps"` plus `dependsOn` plus `"type": "execute"`) rather than any occurrence of `"summary"`. The positive grep for `plan_add_stage|plan_set_current|run_manager` should also be scoped to a known planner path or replaced by a direct eager-block assertion, because a valid recovery turn can call `plan_get` or `plan_init` without hitting those three tokens.

## Verified Good

- The core fictional-format analysis is sound. The skill really teaches `steps`, `executor`, `dependsOn`, numeric IDs, `goal`, and `execute` ([skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L11-L39)), while the real plan shape is `stages[]` with string stage IDs and no dependency field on stages ([src/types.ts](../../../../src/types.ts#L34-L48)).
- The roster check is correct: the shipped roles are `planner`, `manager`, `coder`, `researcher`, `data_agent`, `reviewer`, `designer`, `inspector`, and `chat`; there is no `executor` role ([src/agents/roster.ts](../../../../src/agents/roster.ts#L42-L193)).
- Option C is the right architecture-first recommendation. The planner prompt already covers the MCP plan service, dispatch tools, stage fields, and planning guidelines ([prompts/planner.md](../../../../prompts/planner.md#L20-L73), [prompts/planner.md](../../../../prompts/planner.md#L118-L126)), so deleting the duplicate built-in skill removes the drift surface instead of creating another restatement to maintain.
- The proposed rollback shape is appropriate for a bundle-only deletion: no project `.saivage/` state migration is needed, and `git revert` plus rebuild/restart is enough if a deployment regresses.

## Change Count

Requested changes: 3

VERDICT: CHANGES_REQUESTED