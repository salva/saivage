# F03 — Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [F03-naive-json-extraction.md](../F03-naive-json-extraction.md)
- [01-analysis-r1.md](01-analysis-r1.md)
- [02-design-r1.md](02-design-r1.md)
- [03-plan-r1.md](03-plan-r1.md)
- Source spot-checks across [src/](../../../../src/) for the literal `\{[\s\S]*\}` pattern, `jsonMatch`, `parseJsonObject`, and `JSON.parse`.

## Findings

### Analysis

The writer's inventory is materially correct. A literal grep confirms eight greedy-brace regex sites: [src/agents/coder.ts](../../../../src/agents/coder.ts#L270), [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L266), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L182), [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L212), [src/agents/designer.ts](../../../../src/agents/designer.ts#L197), [src/agents/inspector.ts](../../../../src/agents/inspector.ts#L224), [src/agents/manager.ts](../../../../src/agents/manager.ts#L398), and [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L183). The supervisor near-duplicate is also correctly called out at [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L177-L218).

The broader `JSON.parse` sweep does not reveal an omitted free-form LLM JSON extraction site. The other hits are file/config/state parsing, protocol parsing, provider tool-call argument parsing, tests, or already-structured tool-result handling such as [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L334). Planner and chat are also correctly negative for this specific extraction pattern.

One factual correction is required: the current regex does **not** include the surrounding backtick fences for a simple fenced JSON response. In a response like ```` ```json\n{"ok":true}\n``` ````, `text.match(/\{[\s\S]*\}/)` starts at the first `{` and ends at the matching last `}`, so the candidate is valid JSON. The analysis and design both claim the regex span includes the fences and therefore chokes on backticks; that is incorrect and should be corrected so the risk section is accurate.

### Design

Proposal B is the right architectural direction: central extraction, schema validation at the LLM-output boundary, and typed parse failures align with the project guidelines and avoid preserving the silent-success bug. The rejected provider-native structured-output proposal is also scoped correctly as a separate provider-layer refactor.

However, the extractor strategy is currently specified in a way that can reproduce the issue's central failure mode. Both proposals try a fenced-code-block extraction before the balanced-brace scan. If a model response contains an earlier fenced JSON example plus a final JSON report, the first valid fenced block can be returned before the final report is considered. That conflicts with the design's stated goal of handling multiple JSON objects and with the plan's later test expectation that the final balanced object wins.

### Plan

The plan is mostly executable and uses the correct validation commands for this repo, but three details need revision before implementation can safely be handed off.

First, Step 1 repeats the fenced-block-first extraction order, while Step 2 asks for a test where an earlier fenced example is ignored in favor of the final object. Those instructions contradict each other.

Second, the `invalid_json` parse result is not reachable under the current helper contract because `extractJsonObject` only returns substrings that already survived `JSON.parse`. For malformed balanced text like `{a: 1}`, the planned extractor returns `null`, so `parseLlmJsonAs` reports `no_json`, not `invalid_json`. Either the contract must return raw candidates before parsing, or the public reason set and tests must be simplified.

Third, the designer path needs clearer sequencing. Current [src/types.ts](../../../../src/types.ts#L157-L170) does not admit `"designer"` as a `TaskReport.agent`, while [src/agents/designer.ts](../../../../src/agents/designer.ts#L197-L214) returns that value today. If F03 touches designer before F01 updates the roster/schema, `parseLlmJsonAs(text, TaskReportSchema.partial())` will reject otherwise-valid designer reports that include `agent: "designer"`. The plan should either require F01's schema/roster change first, exclude designer until F01 lands, or validate worker report payloads with an `agent`-omitting schema and then overlay the runtime role.

## Required changes

1. Correct the analysis/design statements about fenced JSON. The old regex does not include surrounding backticks for a single fenced JSON object; keep the critique focused on greedy first-brace-to-last-brace merging, multiple objects, malformed objects, and silent fallback behavior.
2. Revise the extractor precedence so an earlier fenced example cannot beat the final report. A reasonable contract is: try whole-message JSON, collect parseable object candidates from fenced blocks and balanced-brace scanning, then choose the last/top-level report candidate according to an explicit rule. The design and plan must state the same rule.
3. Make `ParseResult.reason` and the helper contract internally consistent. If `invalid_json` must be observable, extraction has to return raw candidates that parsing can reject; if extraction only returns parseable JSON, remove or downgrade the unreachable `invalid_json` branch and its planned public test.
4. Clarify the designer/F01 interaction around `TaskReportSchema.partial()`. Do not instruct implementers to validate designer output against the current worker-only `TaskReportSchema.agent` enum unless F01 has already widened the schema or removed designer from F03's edit scope.

## Strengths

- The source enumeration is complete for the regex-based LLM-output parsing problem, and the `JSON.parse` spot-check supports the writer's scope boundary.
- Proposal B fits the architecture-first/no-backward-compatibility guidance by deleting the duplicated extractors and surfacing malformed model output as real failure state.
- The plan names the right focused tests and validation commands once the helper contract contradictions are resolved.

VERDICT: CHANGES_REQUESTED