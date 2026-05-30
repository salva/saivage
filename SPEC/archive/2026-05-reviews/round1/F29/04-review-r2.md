# F29 - Pi AI unsafe casts and synthesis - Review r2

## Reviewer

`GPT-5.5 (copilot)`

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F29-pi-ai-as-any-and-synthesis.md](SPEC/v2/review-2026-05/F29-pi-ai-as-any-and-synthesis.md)
- [SPEC/v2/review-2026-05/F29/04-review-r1.md](SPEC/v2/review-2026-05/F29/04-review-r1.md)
- [SPEC/v2/review-2026-05/F29/01-analysis-r2.md](SPEC/v2/review-2026-05/F29/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F29/02-design-r2.md](SPEC/v2/review-2026-05/F29/02-design-r2.md)
- [SPEC/v2/review-2026-05/F29/03-plan-r2.md](SPEC/v2/review-2026-05/F29/03-plan-r2.md)
- Spot-checks: [src/providers/pi-ai.ts](src/providers/pi-ai.ts), [src/providers/types.ts](src/providers/types.ts), [package.json](package.json), [node_modules/@mariozechner/pi-ai/dist/types.d.ts](node_modules/@mariozechner/pi-ai/dist/types.d.ts), [node_modules/@mariozechner/pi-ai/dist/models.d.ts](node_modules/@mariozechner/pi-ai/dist/models.d.ts), [node_modules/@mariozechner/pi-ai/dist/models.js](node_modules/@mariozechner/pi-ai/dist/models.js), [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts).

## Findings

### Analysis

The r1 compat objection is fixed. The r2 analysis correctly states that `@mariozechner/pi-ai` is `^0.73.1` in [package.json](package.json#L21), that upstream `Model<TApi>.compat?` exists in [node_modules/@mariozechner/pi-ai/dist/types.d.ts](node_modules/@mariozechner/pi-ai/dist/types.d.ts#L380-L403), and that `requiresReasoningContentOnAssistantMessages` is already part of `OpenAICompletionsCompat` in [node_modules/@mariozechner/pi-ai/dist/types.d.ts](node_modules/@mariozechner/pi-ai/dist/types.d.ts#L260-L263). The revised diagnosis is now the right one: this is a conditional-union/narrowing problem, not a missing upstream property.

The r1 cast-inventory objection is fixed in substance. The r2 table includes the previously missed current-source assertions at [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L162), [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L201), and [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L281), and it gives every current assertion a disposition. One summary sentence still says there are 11 real assertions, while the table and current `rg -n " as " src/providers/pi-ai.ts` inventory show 14 real assertions after excluding the import alias and prose comment. I am not treating that stale count as blocking because the actionable inventory and plan cover all 14 sites.

The synthesis-path analysis remains accurate. The current source still has fuzzy resolution and sibling cloning in [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L94-L105), and r2 correctly requires deleting both rather than warning or preserving compatibility.

### Design

Proposal A now has the right shape for implementation. It removes the erroneous `PiAiModelWithCompat` local facade, keeps the unavoidable pi-ai generic erasure in a named helper module, deletes fuzzy/synthetic model lookup, and isolates the two remaining body assertions as explicit bridge boundaries for `ContentBlock.input` and `Tool.parameters`.

The design no longer hides the r1-missed casts. It accounts for the `ContentBlock[]` assertion through TypeScript narrowing, the duplicate `getModels` assertion through `piGetModels`, and the tool-call input assertion as a documented bridge. That is good enough for implementation and respects the architecture-first/no-backward-compatibility guideline.

### Plan

The r1 test-snippet objection is fixed. The proposed `chat` error test now builds a `ChatRequest` with `system: ""`, matching the required field in [src/providers/types.ts](src/providers/types.ts#L20-L29).

The acceptance checks are also fixed. The r2 plan no longer uses the naive `grep -c " as "` count that would match the `Message as PiMessage` import alias in [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L20). The targeted greps now check the two allowed body bridges, reject residual message/model casts, and reject synthesis residue. The validation commands use the Saivage repo's Vitest/typecheck/build conventions.

## Required changes

None.

## Strengths

- r2 corrects the upstream compat-type claim instead of adding local type drift.
- The plan deletes silent model substitution outright, matching the no-backward-compatibility rule.
- The test plan now covers exact lookup, unknown lookup, near-miss synthesis regression, the typed unknown-model throw, and Kimi compat injection without network calls.

VERDICT: APPROVED