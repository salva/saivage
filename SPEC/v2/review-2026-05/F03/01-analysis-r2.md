# F03 — Functional analysis (R2)

## Changes from r1

- Corrected the fenced-code-block claim. The old regex `text.match(/\{[\s\S]*\}/)` slices from the **first `{`** to the **last `}`**; the surrounding backticks are not in the slice. A response shaped ```` ```json\n{"ok":true}\n``` ```` therefore parses correctly today (the regex window is just `{"ok":true}`). The real failure mode E5 is "fenced JSON example earlier in the message + a real report later" — the regex merges them into an invalid wide slice. Updated the E1-E5 failure-mode table and the `parseTaskReport` behaviour notes accordingly.
- Added an explicit constraint that `agent` on `TaskReport` is a **runtime fact owned by the worker**, not a value the model should declare. The current [`TaskReportSchema.agent`](../../../../src/types.ts#L160) enum is `["coder", "researcher", "data_agent", "reviewer"]` and does not list `"designer"`, so any solution that validates worker output with `TaskReportSchema.partial()` directly would reject otherwise-valid designer payloads. This constraint is satisfied independent of F01's roster decisions.
- Refined the contract surface: introduced `extractJsonCandidates(text): string[]` as the lower-level primitive so downstream parsing can distinguish "no candidate text at all" (`no_json`) from "candidate text that does not parse as JSON" (`invalid_json`). The r1 contract collapsed both into `no_json`.

## Problem restated

Eight call sites independently use the same brittle regex `text.match(/\{[\s\S]*\}/)` (or its `indexOf("{") / lastIndexOf("}")` morally-equivalent twin) to recover a JSON object from a model's free-form text response. The regex is greedy and unanchored: it picks the substring from the first `{` to the last `}` in the whole message, then hands the slice to `JSON.parse` and either returns the parsed object or silently degrades to a synthesised default. Concrete sites:

| # | File | Line | Surrounding helper / call | Result type cast |
| --- | --- | --- | --- | --- |
| 1 | [src/agents/coder.ts](../../../../src/agents/coder.ts#L270) | L270 | `parseTaskReport` (L263) | `as TaskReport` |
| 2 | [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L266) | L266 | `parseTaskReport` (L260) | `as TaskReport` |
| 3 | [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L182) | L182 | `parseTaskReport` (L176) | `as TaskReport` |
| 4 | [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L212) | L212 | `parseTaskReport` (L206) | `as TaskReport` |
| 5 | [src/agents/designer.ts](../../../../src/agents/designer.ts#L197) | L197 | `parseTaskReport` (L191) | `as TaskReport` |
| 6 | [src/agents/inspector.ts](../../../../src/agents/inspector.ts#L224) | L224 | `parseInspectionReport` (L219) | `as InspectionReport` |
| 7 | [src/agents/manager.ts](../../../../src/agents/manager.ts#L398) | L398 | `parseStageSummary` (L392) | `as StageSummary` |
| 8 | [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L183) | L183 | `parseModelVerdict` (L182) | `{ verdict?, confidence?, reason? }` |

Plus a ninth site that already extracted the helper but only for one caller, and with its own subtly-different semantics (trim-first, then full-trim parse, then fallback to `indexOf("{") / lastIndexOf("}")` slice):

| 9 | [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L177) | L177 (call) / L204 (helper `parseJsonObject`) | called from `parseVerdict` | `unknown` |

The F03 issue text claims "seven sites"; actual count is **eight regex sites plus one near-duplicate helper** = **9 places that all want the same primitive**.

The F03 issue text also flags "planner's JSON parsing, chat agent's slash command JSON" as candidates. Verified by `grep -nE 'JSON\.parse|jsonMatch|match\(/\\\{' src/agents/planner.ts src/agents/chat.ts` — **no matches**. Planner and chat never parse JSON out of LLM output. Those are negative findings and stay out of scope.

A broader `grep -RnE 'JSON\.parse' src/` sweep was rerun for r2; the other hits are file/config/state parsing, protocol parsing, provider tool-call argument parsing, tests, or already-structured tool-result handling such as [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L334). None are free-form LLM-text extraction. The 9-site inventory above is complete.

## Actual differences between the 9 copies

The copies are not bit-identical. Three semantic axes differ.

### Axis 1: extraction algorithm

| Site | Algorithm |
| --- | --- |
| 8 worker/inspector/manager/cop sites | Single regex `text.match(/\{[\s\S]*\}/)`. First-`{` to last-`}` span only. |
| `supervisor.parseJsonObject` ([supervisor.ts L204-L218](../../../../src/runtime/supervisor.ts#L204-L218)) | Trim, try `JSON.parse(trimmed)` whole, **then** fall back to `indexOf("{")..lastIndexOf("}")+1`. |

Supervisor's two-tier algorithm is strictly better for models that already return clean JSON (no surrounding prose). The eight regex sites can still parse a clean-JSON response because the regex slice `{...}` is itself valid JSON, but they cannot short-circuit the whole-message case. Both algorithms diverge on the **multiple-JSON-objects case**: the regex merges from first `{` to last `}` into an invalid wide slice, while supervisor's `indexOf/lastIndexOf` fallback exhibits the same merging bug. Neither handles "first valid object earlier, second valid object later" correctly.

### Axis 2: fallback behaviour on parse failure

| Site | Behaviour on parse failure |
| --- | --- |
| `parseTaskReport` (5 copies) | Silent: synthesise `status: "completed"`, `summary: text.slice(0, 1000)`. Task is recorded as a success. |
| `parseInspectionReport` ([inspector.ts L227-L256](../../../../src/agents/inspector.ts#L227-L256)) | Silent: synthesise findings from `text.slice(0, 2000)`. |
| `parseStageSummary` ([manager.ts L398-L436](../../../../src/agents/manager.ts#L398-L436)) | Silent: synthesise `result: "completed"`, `summary: text.slice(0, 1000)`. |
| `parseModelVerdict` ([prompt-injection-cop.ts L182-L196](../../../../src/security/prompt-injection-cop.ts#L182-L196)) | Returns `null`. Caller at [L137](../../../../src/security/prompt-injection-cop.ts#L137) returns `null` from the model scan, which short-circuits to heuristic-only — i.e. the model verdict is silently dropped. |
| `parseJsonObject` ([supervisor.ts L204](../../../../src/runtime/supervisor.ts#L204)) | Returns `null`. Caller `parseVerdict` ([supervisor.ts L171-L201](../../../../src/runtime/supervisor.ts#L171-L201)) turns `null` into a synthetic `stuck: true` verdict with the raw text as evidence — i.e. failures are **escalated**, not silenced. |

The worker/manager/inspector path "any parse failure becomes success" is the bug F03 cares about most. Supervisor is the only caller that handles parse failure correctly (escalates to a recognisable degraded verdict). Cop drops the model verdict silently which is acceptable because the heuristic scanner is the conservative default. Workers silently lying about success is the most-consequential of the three failure modes.

### Axis 3: post-parse validation

| Site | Validation against schema |
| --- | --- |
| All 8 type-cast sites | None. Result is cast with `as TaskReport` / `as InspectionReport` / `as StageSummary` and then field-by-field `?? default` overlay. A model returning `{"foo": "bar"}` produces a "TaskReport" with every field defaulted, including `status: "completed"`. |
| `parseModelVerdict` | Hand-rolled: `verdict === "block" ? "block" : "allow"`, numeric clamp on `confidence`, string check on `reason`. Equivalent to a tiny Zod schema. |
| `parseJsonObject` callers | `parseVerdict` does similar hand-rolled field checks. |

No site re-validates with the Zod schema that already exists in [src/types.ts](../../../../src/types.ts). The schemas are right there ([`TaskReportSchema` L157](../../../../src/types.ts#L157-L176), [`InspectionReportSchema`](../../../../src/types.ts), [`StageSummarySchema`](../../../../src/types.ts#L191-L208)) and unused for inbound LLM payloads.

## Contract

The primitive every site wants is structured in two layers so the public failure surface can distinguish "no candidate text" from "candidate text that does not parse":

```
extractJsonCandidates(text: string): string[]
parseLlmJson(text: string): unknown | null
parseLlmJsonAs<T>(text: string, schema: ZodType<T>): ParseResult<T>
```

`extractJsonCandidates` returns **raw substrings** (not yet parsed) that plausibly contain a JSON object: any fenced ```` ```json … ``` ```` body, the trimmed whole message, and every balanced top-level `{…}` span identified by a brace-depth scan. Source order. Lower layers decide which one wins by parsing and by schema.

`parseLlmJson` tries `JSON.parse` on each candidate, returning the **last** one that parses (the rule "later objects in the message override earlier examples" is the new contract; under the old regex an earlier example wins or the whole thing merges).

`parseLlmJsonAs(text, schema)` runs the same enumeration and parse, then `schema.safeParse`s the last parseable candidate. Failure reasons:

- `no_json` — `extractJsonCandidates` returned `[]`.
- `invalid_json` — candidates exist, none survive `JSON.parse`. Reachable, e.g. `{a: 1}` (unquoted key) is a balanced candidate that won't parse.
- `schema_mismatch` — at least one candidate parses, but the chosen (last-parseable) value doesn't match the schema.

Lifecycle / where called:

- All 8 regex sites are reached **once per agent turn** at the end of `run()`/`review()`/`scanWithModel()`/`runLoop()` for the verdict step. None are in a hot loop.
- Each site is the **only** consumer of its private helper; no helper is re-used across files.
- All helpers are module-private; **none are exported** (confirmed by `grep -n parseTaskReport src/index.ts` → no hits, and `grep -RnE 'import.*parseTaskReport' src/` → no cross-file imports).

Error modes the contract must support:

- E1: text has no `{` at all (worker said "I'm done" with prose only). → `no_json`.
- E2: text has balanced braces but the slice is invalid JSON (unquoted keys, trailing commas). → `invalid_json`.
- E3: text has valid JSON but it does not match the expected schema (model emitted the wrong shape). → `schema_mismatch`.
- E4: text has multiple JSON objects (a fenced example earlier, a real one at end). → enumerate both, last-parseable wins.
- E5: text has a fenced code block ```` ```json … ``` ```` followed by additional prose that may contain a stray `}`. The old regex slice runs from first `{` to last `}` and so wraps the fenced body together with stray prose into an invalid slice. The new helper enumerates the fenced body as one candidate and any balanced span as a separate candidate, so the fenced JSON survives even if a later stray brace exists.

Today's regex handles E1 (`jsonMatch` is `null` → fallback) and E2 (parse throws → fallback). It silently mishandles E3 (caller's `?? defaults` overlay produces a plausible-looking object). It mishandles E4 and E5 (merged span fails to parse → falls back to synthesised success).

## Call sites & dependencies

External imports of the 9 helpers — none. All helpers are module-private. The refactor's import surface is bounded: only the 9 files above plus whatever new module the helper goes into. Tests:

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) — exercises worker agents but does not directly call any of the 9 helpers.
- [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) — exercises the cop end-to-end including model-verdict path.
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — exercises supervisor in places.
- No dedicated `parse-json.test.ts` / `parse-llm-json.test.ts` exists today.

Zod schemas constraining the parsed values:

- [`TaskReportSchema`](../../../../src/types.ts#L157-L176) — `parseTaskReport` (5 copies) target. Note `agent` is a closed enum `["coder","researcher","data_agent","reviewer"]` (designer is **not** listed; see constraint below).
- [`InspectionReportSchema`](../../../../src/types.ts) — `parseInspectionReport` target.
- [`StageSummarySchema`](../../../../src/types.ts#L191-L208) — `parseStageSummary` target.
- Cop and supervisor want ad-hoc shapes (`{verdict, confidence, reason}`, `{stuck, confidence, reason, evidence}`).

Provider-level structured-output support today: **none**. Verified by `grep -RnE 'response_format|responseFormat|json_schema|structured' src/providers/ | head` → one hit (`tool_choice: "auto"` in `openai-codex.ts`), zero `response_format` / `json_schema` usage. So a "level-up to provider-native JSON mode" is genuinely a much bigger lift than a shared parser.

## Constraints any solution must respect

- **No backward compatibility shims**: the project guideline ([_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)) forbids leaving the old per-file helpers behind once consolidated. The refactor must delete the eight in-file regex sites and the supervisor's `parseJsonObject` in the same change.
- **`agent` is a runtime fact, not a model-emitted field**: each worker statically knows its role (`coder` constructs `TaskReport.agent: "coder"`, designer constructs `"designer"`, etc.). The current `TaskReportSchema.agent` enum doesn't include `"designer"`, so validating raw model output with `TaskReportSchema.partial()` would reject designer's payload even though the runtime overwrites `agent` anyway. The solution must validate worker payloads with `TaskReportSchema.omit({ agent: true }).partial()` and overlay the runtime role afterward. This decouples F03 from F01 entirely: F03 makes no claim about which roles exist, and the parser stays correct whether F01 widens the enum, deletes designer, or does nothing.
- **F09 sequencing**: F09 consolidates the five worker copies of `parseTaskReport` into a single worker base. F03 should run **after** F09 — once F09 has merged the five worker `parseTaskReport` copies into one, F03 has 4 helper sites left, not 9. Either order works in net edits; F03 is correct regardless.
- **F05 sequencing**: F05 cleans up `normalizeNonStuckOperationalVerdict` (supervisor's regex post-processor that flips its own LLM verdict). F05 sits on top of `parseVerdict` → `parseJsonObject`. F03 changes `parseJsonObject`'s identity (moves it to the shared module, possibly with a different return signature). F05 should run **after** F03, or at minimum aware of the new helper signature.
- **F25 sequencing**: F25 covers cop false positives on legitimate documentation. The cop's model-scan path calls `parseModelVerdict` to interpret an LLM verdict; F03 changes how that verdict is extracted but does not change the cop's heuristic patterns. F25 is independent.
- **Schemas are authoritative**: [`TaskReportSchema`](../../../../src/types.ts#L157-L176), [`InspectionReportSchema`](../../../../src/types.ts), [`StageSummarySchema`](../../../../src/types.ts#L191-L208) already exist. The refactor must use them for parsed values rather than minting new ad-hoc shapes.
- **System-boundary validation only**: per project guidelines ("no defensive code at internal boundaries"), the shared parser should validate at the LLM-output boundary and trust the validated value downstream. The worker / manager / inspector callers currently do field-by-field `?? defaults` overlays — those overlays must move into the parser's "post-validation fill-in" step or be replaced by `schema.partial()` parsing.
- **No new docstrings on untouched code**: only the helper module and the call-site lines that change get new comments. The surrounding worker/inspector/manager/cop/supervisor logic stays untouched at the doc level.
- **No emojis** anywhere.
