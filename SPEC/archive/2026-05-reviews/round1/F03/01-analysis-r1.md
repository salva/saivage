# F03 — Functional analysis (R1)

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

## Actual differences between the 9 copies

The copies are not bit-identical. Three semantic axes differ.

### Axis 1: extraction algorithm

| Site | Algorithm |
| --- | --- |
| 8 worker/inspector/manager/cop sites | Single regex `text.match(/\{[\s\S]*\}/)`. First-`{` to last-`}` span only. |
| `supervisor.parseJsonObject` ([supervisor.ts L204-L218](../../../../src/runtime/supervisor.ts#L204-L218)) | Trim, try `JSON.parse(trimmed)` whole, **then** fall back to `indexOf("{")..lastIndexOf("}")+1`. |

Supervisor's two-tier algorithm is strictly better for models that already return clean JSON (no surrounding prose), because the whole-message parse succeeds without a regex. The eight regex sites can also fail on a clean JSON response that happens to contain a string with `}` followed by trailing whitespace (the regex still works there — `[\s\S]*` is greedy, so it's fine for that case). They fail differently from supervisor when the response is `{...}\nextra prose` containing a `}` somewhere in the trailing prose: regex picks the wider span and parse fails. Supervisor would also fail on that case, but only after first trying the whole-message parse, which also fails. So in practice the two algorithms diverge only on the **clean-JSON case** (supervisor: 1 parse attempt, regex sites: 1 parse attempt — same outcome) and on the **prose-around-JSON case** (both attempt the same wide span).

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

No site re-validates with the Zod schema that already exists in [src/types.ts](../../../../src/types.ts). The schemas are right there ([`TaskReportSchema` L157](../../../../src/types.ts#L157), [`InspectionReportSchema`](../../../../src/types.ts), [`StageSummarySchema`](../../../../src/types.ts)) and unused for inbound LLM payloads.

## Contract

The primitive every site wants is:

```
extractJsonObject(text: string): string | null
```

Input: arbitrary model text. Output: the raw substring that looks most likely to be a top-level JSON object, or `null` if no candidate found.

Two stronger contracts that callers actually want on top:

```
parseJsonObject(text: string): unknown | null
parseJsonAs<T>(text: string, schema: ZodType<T>): { ok: true; value: T } | { ok: false; reason: string; raw: string | null }
```

Lifecycle / where called:

- All 8 regex sites are reached **once per agent turn** at the end of `run()`/`review()`/`scanWithModel()`/`runLoop()` for the verdict step. None are in a hot loop.
- Each site is the **only** consumer of its private helper; no helper is re-used across files.
- All helpers are module-private; **none are exported** (confirmed by `grep -n parseTaskReport src/index.ts` → no hits, and `grep -RnE 'import.*parseTaskReport' src/` → no cross-file imports).

Error modes the contract must support:

- E1: text has no `{` at all (worker said "I'm done" with prose only).
- E2: text has balanced braces but the slice is invalid JSON (model emitted half-baked output).
- E3: text has valid JSON but it does not match the expected schema (model emitted the wrong shape).
- E4: text has multiple JSON objects (a fenced example earlier, a real one at end).
- E5: text has a fenced code block ```` ```json ... ``` ```` and trailing prose.

Today's regex handles E1 (`jsonMatch` is `null` → fallback) and E2 (parse throws → fallback). It silently mishandles E3 (caller's `?? defaults` overlay produces a plausible-looking object). It mishandles E4 (picks the merged-from-first-`{`-to-last-`}` span which is invalid → fallback). It is fine on E5 only when the fenced block is followed by no other `}` and the parser doesn't choke on the ```` ``` ```` characters (it does choke, because the regex span includes them).

## Call sites & dependencies

External imports of the 9 helpers — none. All helpers are module-private. The refactor's import surface is bounded: only the 9 files above plus whatever new module the helper goes into. Tests:

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) — exercises worker agents but does not directly call any of the 9 helpers.
- [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) — exercises the cop end-to-end including model-verdict path.
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — exercises supervisor in places.
- No dedicated `parse-json.test.ts` / `parse-llm-json.test.ts` exists today.

Zod schemas constraining the parsed values:

- [`TaskReportSchema`](../../../../src/types.ts#L157) — `parseTaskReport` (5 copies) target.
- [`InspectionReportSchema`](../../../../src/types.ts) — `parseInspectionReport` target.
- [`StageSummarySchema`](../../../../src/types.ts) — `parseStageSummary` target.
- Cop and supervisor want ad-hoc shapes (`{verdict, confidence, reason}`, `{stuck, confidence, reason, evidence}`).

Provider-level structured-output support today: **none**. Verified by `grep -RnE 'response_format|responseFormat|json_schema|structured' src/providers/ | head` → one hit (`tool_choice: "auto"` in `openai-codex.ts`), zero `response_format` / `json_schema` usage. So a "level-up to provider-native JSON mode" is genuinely a much bigger lift than a shared parser.

## Constraints any solution must respect

- **No backward compatibility shims**: the project guideline ([_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)) forbids leaving the old per-file helpers behind once consolidated. The refactor must delete the eight in-file regex sites and the supervisor's `parseJsonObject` in the same change.
- **F09 sequencing**: F09 consolidates the five worker copies of `parseTaskReport` into a single worker base. F03 should run **after** F09 — once F09 has merged the five worker `parseTaskReport` copies into one, F03 has 4 helper sites left (worker-base `parseTaskReport`, `parseInspectionReport`, `parseStageSummary`, plus cop + supervisor primitive), not 9. Sequencing the other way means F03 first edits 5 worker files that F09 will then delete. Same outcome in net edits but more churn. If F09 has not yet landed when F03 is implemented, F03's recommended proposal still works — it just touches more files.
- **F05 sequencing**: F05 cleans up `normalizeNonStuckOperationalVerdict` (supervisor's regex post-processor that flips its own LLM verdict). F05 sits on top of `parseVerdict` → `parseJsonObject`. F03 changes `parseJsonObject`'s identity (moves it to the shared module, possibly with a different return signature). F05 should run **after** F03, or at minimum aware of the new helper signature.
- **F25 sequencing**: F25 covers cop false positives on legitimate documentation. The cop's model-scan path calls `parseModelVerdict` to interpret an LLM verdict; F03 changes how that verdict is extracted but does not change the cop's heuristic patterns. F25 is independent.
- **Schemas are authoritative**: [`TaskReportSchema`](../../../../src/types.ts#L157), [`InspectionReportSchema`](../../../../src/types.ts), [`StageSummarySchema`](../../../../src/types.ts) already exist. The refactor must use them for parsed values rather than minting new ad-hoc shapes.
- **System-boundary validation only**: per project guidelines ("no defensive code at internal boundaries"), the shared parser should validate at the LLM-output boundary and trust the validated value downstream. The worker / manager / inspector callers currently do field-by-field `?? defaults` overlays — those overlays must move into the parser's "post-validation fill-in" step or be replaced by `schema.partial()` parsing.
- **No new docstrings on untouched code**: only the helper module and the call-site lines that change get new comments. The surrounding worker/inspector/manager/cop/supervisor logic stays untouched at the doc level.
- **No emojis** anywhere.
