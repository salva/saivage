# F29 - Pi AI unsafe casts and synthesis - Review r1

## Reviewer

`GPT-5.5 (copilot)`

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F29-pi-ai-as-any-and-synthesis.md](SPEC/v2/review-2026-05/F29-pi-ai-as-any-and-synthesis.md)
- [SPEC/v2/review-2026-05/F29/01-analysis-r1.md](SPEC/v2/review-2026-05/F29/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F29/02-design-r1.md](SPEC/v2/review-2026-05/F29/02-design-r1.md)
- [SPEC/v2/review-2026-05/F29/03-plan-r1.md](SPEC/v2/review-2026-05/F29/03-plan-r1.md)
- Spot-checks: [src/providers/pi-ai.ts](src/providers/pi-ai.ts), [src/providers/types.ts](src/providers/types.ts), [package.json](package.json), [node_modules/@mariozechner/pi-ai/dist/types.d.ts](node_modules/@mariozechner/pi-ai/dist/types.d.ts), [node_modules/@mariozechner/pi-ai/dist/models.d.ts](node_modules/@mariozechner/pi-ai/dist/models.d.ts), [node_modules/@mariozechner/pi-ai/dist/models.js](node_modules/@mariozechner/pi-ai/dist/models.js), [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts).

## Findings

### Analysis

The core diagnosis is correct. The provider really does erase pi-ai's strict literal generics at the runtime boundary in [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L82-L83), silently accepts fuzzy model IDs in [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L94-L96), and synthesizes cloned model records in [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L98-L105). The analysis is also right that deleting the fuzzy/sibling branches is the proper architecture-first fix, because a bad `modelSpec` should fail rather than route to a guessed catalogue entry.

There is one blocking factual error in the compat discussion. The analysis says `compat` is not on pi-ai's `Model` type, but the installed dependency is `@mariozechner/pi-ai` `^0.73.1` in [package.json](package.json#L21), and its declaration already exposes `Model<TApi>.compat?` in [node_modules/@mariozechner/pi-ai/dist/types.d.ts](node_modules/@mariozechner/pi-ai/dist/types.d.ts#L380-L403), including `requiresReasoningContentOnAssistantMessages` in [node_modules/@mariozechner/pi-ai/dist/types.d.ts](node_modules/@mariozechner/pi-ai/dist/types.d.ts#L260-L263). The current cast around `model.compat` is a conditional-union merge problem, not an absent-property problem. The analysis and downstream design should be corrected so the implementer does not add a local compat facade for the wrong reason.

The cast inventory is incomplete. In addition to the listed sites, the current file still has body assertions at [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L162), [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L201), and [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L281). The first can likely disappear through TypeScript's `typeof m.content === "string"` narrowing, the list-models cast is covered by the proposed `piGetModels`, and the tool-call `input` assertion needs either a named conversion boundary or a source type change. Without adding those to the inventory, the analysis understates the work and the plan's final grep check cannot pass honestly.

### Design

Proposal A is the right shape: keep the change local, delete the guessed model resolution path, put the unavoidable `getModel`/`getModels` erasure behind named helper exports, and give the unknown-model case a structured error that F13 can later normalize. Proposal B is appropriately identified as too broad for this issue because it couples F29 to capability and barrel work.

The design needs one correction before approval: `PiAiModelWithCompat` is justified as exposing a field that the upstream type already declares. If a helper type is still necessary, it should be framed as narrowing/merging `Model<Api>["compat"]` for OpenAI-compatible Kimi models, not as adding a missing property. Otherwise this creates local type drift against a dependency that already has the desired field.

The design also says there will be no `as` casts inside `pi-ai.ts` except the tool-parameters bridge, but it does not say what replaces the `ContentBlock[]` assertion or the tool-call argument assertion. That is a genuine design gap because F29 is explicitly about cleaning unsafe assertion patterns, and the file cannot become visibly cast-free if two unaccounted assertions remain.

### Plan

The ordered edits are close but not yet executable as written. Step 8 says `grep -c " as " src/providers/pi-ai.ts` should return exactly one. That command is not a reliable acceptance check because it also matches the import alias `Message as PiMessage` in [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L20) and prose comments, and because the ordered edits do not remove [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L162) or [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L201). The plan should either list every allowed assertion precisely or use a more targeted check.

The new `chat` error test would not typecheck as shown. `ChatRequest.system` is required in [src/providers/types.ts](src/providers/types.ts#L20-L29), but the proposed test call omits it. Add `system: ""` or a typed request builder so the test plan is directly runnable.

The proposed model IDs are otherwise plausible against the installed catalogue: `claude-sonnet-4-20250514` exists for `anthropic` in [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L1942-L1958), and `kimi-k2.5` / `kimi-k2.6` exist for the opencode family in [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L8788-L8819) and [node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts](node_modules/@mariozechner/pi-ai/dist/models.generated.d.ts#L9016-L9047). The runtime `getModel` miss behavior also matches the plan: it returns `undefined` in [node_modules/@mariozechner/pi-ai/dist/models.js](node_modules/@mariozechner/pi-ai/dist/models.js#L11-L14), despite the stricter declaration in [node_modules/@mariozechner/pi-ai/dist/models.d.ts](node_modules/@mariozechner/pi-ai/dist/models.d.ts#L4-L8).

## Required changes

1. Correct the upstream compat-type claim across analysis/design/plan. `Model<TApi>` already has `compat?`; describe the real problem as narrowing/merging the conditional compat type, or remove the local `PiAiModelWithCompat` helper if it is no longer needed.
2. Complete the `as` inventory and update Proposal A/Step 2 to handle every assertion that should go away or be intentionally isolated, including [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L162), [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L201), and [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L281).
3. Replace the naive `grep -c " as "` acceptance check with a check that does not count import aliases or comments, and make its expected output match the allowed assertion boundaries.
4. Fix the `chat` test recipe so the request satisfies `ChatRequest` by including the required `system` field.

## Strengths

- The recommended proposal deletes the dangerous behavior instead of adding a transitional compatibility path.
- The plan correctly keeps F19's barrel export work out of scope and avoids touching router call sites.
- The test strategy targets the most important regression: near-miss model IDs must not resolve to synthesized siblings.

VERDICT: CHANGES_REQUESTED