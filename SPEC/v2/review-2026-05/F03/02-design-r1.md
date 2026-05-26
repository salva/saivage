# F03 — Design (R1)

## Proposal A — Focused fix: shared `extractJsonObject` helper

### Scope

New module at top-level `src/`, matching the existing convention (`src/log.ts`, `src/ids.ts`, `src/types.ts`):

- **Add**: `src/parse-llm-json.ts` — ~40 lines.
- **Modify**: 9 files to import and call the shared helper:
  - [src/agents/coder.ts](../../../../src/agents/coder.ts#L263-L320) (`parseTaskReport`)
  - [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L260-L313) (`parseTaskReport`)
  - [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L176-L229) (`parseTaskReport`)
  - [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L206-L259) (`parseTaskReport`)
  - [src/agents/designer.ts](../../../../src/agents/designer.ts#L191-L244) (`parseTaskReport`) — only if F01 has not yet deleted designer.
  - [src/agents/inspector.ts](../../../../src/agents/inspector.ts#L219-L256) (`parseInspectionReport`)
  - [src/agents/manager.ts](../../../../src/agents/manager.ts#L392-L436) (`parseStageSummary`)
  - [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L182-L196) (`parseModelVerdict`)
  - [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L171-L218) (`parseVerdict` + delete `parseJsonObject`)

### What the helper exposes

```ts
// src/parse-llm-json.ts
export function extractJsonObject(text: string): string | null;
export function parseLlmJson(text: string): unknown | null;
```

`extractJsonObject` strategy (one function, three escalating strategies tried in order, returns the first one that yields valid JSON):

1. Strip a single fenced ```` ```json ... ``` ```` or ```` ``` ... ``` ```` block if present and return its body.
2. Try `JSON.parse(text.trim())` whole — supports providers that already return clean JSON.
3. Balanced-brace scan: walk the string tracking `{`/`}` depth (and string literals so braces inside strings don't count), find the longest balanced top-level object. Return its substring.

`parseLlmJson` calls `extractJsonObject` and feeds the result to `JSON.parse`. Returns `null` on any failure. (Tiny convenience; lets call sites stay one-liners.)

### What gets removed

- The 8 in-file occurrences of `const jsonMatch = text.match(/\{[\s\S]*\}/);` plus their surrounding `try { JSON.parse(jsonMatch[0]) } catch { ... }` block.
- `src/runtime/supervisor.ts` `function parseJsonObject` ([L204-L218](../../../../src/runtime/supervisor.ts#L204-L218)) deleted; supervisor imports the shared helper.

### What stays unchanged

- The per-site **fallback synthesis** (worker `parseTaskReport` defaulting to `status: "completed"`, manager `parseStageSummary` defaulting to `result: "completed"`, etc.). Proposal A is purely about how the JSON substring is found and parsed. The "lie about success on parse failure" bug stays — F03 issue text calls it out but Proposal A does not fix it; that's an explicit Proposal B feature.
- The post-parse field-by-field `?? defaults` overlay in each caller. No schema validation added.
- Cop returns `null`; supervisor still escalates to `stuck: true`; workers still synthesise success. All preserved.

### Risk

- **Low**. Each call site's behaviour is preserved on the dominant cases (clean JSON, prose around JSON, missing JSON). Behaviour on the degenerate "two JSON objects in one response" case **improves** for all callers — the new balanced-brace scanner picks one valid object rather than the merged-invalid span.
- The fenced-code-block strip is new behaviour. It changes one edge case: a model that returns ```` ```json {...} ``` ```` will now parse correctly where the regex would have also parsed correctly (because the regex span includes the fences but `JSON.parse` actually tolerates leading/trailing whitespace and then chokes on backticks — so today this case **falls back**, with the new helper it succeeds). This is a behaviour change in the recovery direction.
- No provider behaviour change. No prompt change.

### What this enables (cross-link)

- **F09** (worker helper extraction): once the 5 worker `parseTaskReport` copies share a base via F09, the F03 helper has one consumer there instead of 5. F03 + F09 compose without conflict regardless of order; if F03 lands first, F09's consolidated worker helper just inherits the already-shared call.
- **F05** (supervisor regex undermines LLM): F05 can delete `normalizeNonStuckOperationalVerdict` on top of a `parseVerdict` that calls the shared `parseLlmJson`. F05 stays orthogonal.

### What this forbids

- Adding a third copy of the regex anywhere. New code that wants JSON out of an LLM response **must** import `parseLlmJson` / `extractJsonObject` from `src/parse-llm-json.ts`.

### Recommendation note for A

A is the minimum-viable execution of the F03 issue text. It removes the 9 duplicated call sites. It fixes the "two JSON objects in one response" case. It does **not** fix the silent-success-on-parse-failure bug that is the most-consequential symptom of F03. That bug is callable in CI today by feeding a worker LLM a response with no JSON: the task is recorded as completed-with-empty-fields and the manager believes work happened. Proposal A leaves that bug in place.

## Proposal B — Level up: schema-typed parsing with `Result<T>`

### Scope

Same physical file `src/parse-llm-json.ts`, larger surface:

```ts
// src/parse-llm-json.ts
import type { ZodTypeAny, z } from "zod";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "no_json" | "invalid_json" | "schema_mismatch"; detail: string; raw: string | null };

export function extractJsonObject(text: string): string | null;
export function parseLlmJson(text: string): unknown | null;
export function parseLlmJsonAs<S extends ZodTypeAny>(text: string, schema: S): ParseResult<z.infer<S>>;
```

`parseLlmJsonAs` runs the same extraction strategies as Proposal A, then `schema.safeParse`s the result. Failure is structured: `reason` distinguishes "model emitted no JSON" / "JSON was malformed" / "JSON parsed but did not match schema", and `detail` carries the Zod error message (truncated) or the malformed substring (truncated).

### Call-site changes versus A

All sites that today silently lie become explicit:

- **Worker `parseTaskReport`** (5 copies → 1 via F09, or 5 if F09 not yet landed):
  - Call `parseLlmJsonAs(text, TaskReportSchema.partial())`.
  - On `ok: true`, overlay the parsed partial onto the synthesised-fields template (so missing `task_id`/`stage_id`/`agent`/`started_at` still get filled in from `input` / runtime context).
  - On `ok: false`, **return a failure TaskReport** via `buildFailureReport(input, startedAt, startMs, "Worker emitted ${reason}: ${detail}")` instead of synthesising a success. This makes failed parses observable: the manager sees a real failure, not a fake success.
- **`parseInspectionReport`** (inspector): same pattern with `InspectionReportSchema.partial()`. Failure → an `InspectionReport` whose `findings` is `"Inspector emitted ${reason}: ${detail}"` — observable, not silent.
- **`parseStageSummary`** (manager): same pattern with `StageSummarySchema.partial()`. Failure → `result: "failed"` summary with a real failure reason in `summary` and `abort_reason`, instead of `result: "completed"` with truncated text.
- **`parseModelVerdict`** (cop): use a tiny inline Zod schema `z.object({verdict: z.enum(["allow","block"]), confidence: z.number().min(0).max(1), reason: z.string()})`. On failure, return `null` as today (cop's fall-back-to-heuristic semantics preserved).
- **`parseVerdict`** (supervisor): tiny inline Zod schema for the verdict shape. On failure, retain today's "escalate to stuck=true with raw text as evidence" behaviour — pass the `detail` and `raw` from `ParseResult` into the synthetic verdict's `evidence` field. Slightly better signal than today's blanket "non-JSON verdict" string.

### What gets added

- `parse-llm-json.ts`: ~80 lines (40 for extraction, 20 for `parseLlmJsonAs`, 20 for the `ParseResult` type + tiny helpers).
- A focused unit test `src/parse-llm-json.test.ts` covering the 5 error modes from the analysis (E1-E5) plus the schema-mismatch path.

### What gets removed

- Everything Proposal A removes.
- **Additionally**: the per-site "synthesise success with truncated text" branch in every worker `parseTaskReport`, in `parseInspectionReport`, and in `parseStageSummary`. The synthesised-success path was specifically the F03 silent-success bug; Proposal B deletes those branches and routes through `buildFailureReport` / its inspector / manager equivalents.
- The `?? defaults` overlays inside each caller for fields the schema's `.partial()` already drops to `undefined` — replaced by `?? defaults` overlay logic moved into the per-caller "fill in from context" step. Net LOC change: roughly neutral; the per-caller overlay shrinks and the parser grows.

### What stays unchanged

- Schemas in [src/types.ts](../../../../src/types.ts). No edits there.
- Provider layer. No structured-output requirement. No prompt change.
- Cop heuristic patterns and fall-back semantics. Supervisor's `normalizeNonStuckOperationalVerdict` (F05's territory).

### Risk

- **Moderate**. The silent-success → explicit-failure flip is a real behaviour change. Specifically: today, a worker that the model failed to summarise correctly is recorded as `status: "completed"` with the model's text in `summary`. Tomorrow it's recorded as `status: "failed"` with a `failure_reason`. Manager logic that aggregates worker reports into a stage summary changes outcome: stages that today look like "all completed, no useful findings" will tomorrow look like "some workers failed". This is the correct behaviour — F03 says exactly this — but it will trip existing test fixtures and any saivage projects whose `stages/<id>/summary.json` look "all green" because of the bug.
- The Zod-schema-driven parsing rejects responses that today were accepted. A model returning `{"summary": "did the thing"}` for a TaskReport today produces a completed-shape with every field defaulted. Tomorrow it parses successfully against `TaskReportSchema.partial()` (because `.partial()` makes every field optional) and gets overlaid onto defaults — same behaviour. Schema-mismatch only fires when the model returns a value of the wrong **type** for a field (e.g. `"status": 42`), which is itself a bug worth surfacing.

### What this enables (cross-link)

- **F09**: F09's consolidated worker `parseTaskReport` becomes a 5-line function: extract → schema-validate → overlay defaults → return. Without B, the consolidated F09 helper still embeds the "synthesise success" branch and the silent-failure behaviour stays in one place instead of five. F09's consolidation is **better** if F03/B lands first or alongside.
- **F05**: supervisor's `parseVerdict` no longer needs hand-rolled field checks; the schema does it. F05's cleanup of `normalizeNonStuckOperationalVerdict` is unblocked because `parseVerdict` now produces a verdict whose `evidence` already carries the parse failure detail — F05 can delete the regex post-processor without losing diagnostic signal.
- **F25**: cop's `parseModelVerdict` becomes a 3-line schema parse. Doesn't fix F25 (cop's heuristic false positives) but makes the model-scan path one less place F25 has to touch.
- **Future structured-output adoption**: if a future change adds provider-native JSON mode (today: zero providers support it in this repo), the shared helper is the single point where the "clean-JSON fast path" already runs (`JSON.parse(text.trim())` whole). Providers can opt in by emitting clean JSON; the helper's strategy 2 (whole-message parse) handles them with no other changes.

### What this forbids

- Reintroducing per-call-site `?? defaults` for fields that belong to the schema. The schema is authoritative.
- Silent-success-on-parse-failure anywhere. Any new LLM-output-parsing call site must use `parseLlmJsonAs` and route parse failures to a real failure path.

### Recommendation note for B

B is the level-up the F03 issue text explicitly asks for ("returning typed `Result<T>`"). It composes naturally with F09 and F05, fixes the silent-success bug, and uses schemas that already exist. The cost is acknowledging the behaviour flip in the test/fixture pass.

## Proposal C considered and rejected

The F03 issue text suggests as a possible level-up: "require providers to support structured-output mode where available, fall back only for those that don't." Inspection of [src/providers/](../../../../src/providers/) finds **zero providers** in this repo currently pass `response_format` / `json_schema` to their API. Implementing this would:

- Touch the provider abstraction in [src/providers/base.ts](../../../../src/providers/base.ts) and [src/providers/types.ts](../../../../src/providers/types.ts) to add a `responseFormat?: "json" | { schema: ZodTypeAny }` field on the request.
- Touch each of 8 provider adapters ([anthropic.ts](../../../../src/providers/anthropic.ts), [openai.ts](../../../../src/providers/openai.ts), [openai-codex.ts](../../../../src/providers/openai-codex.ts), [copilot.ts](../../../../src/providers/copilot.ts), [openrouter.ts](../../../../src/providers/openrouter.ts), [ollama.ts](../../../../src/providers/ollama.ts), [llamacpp.ts](../../../../src/providers/llamacpp.ts), [pi-ai.ts](../../../../src/providers/pi-ai.ts)) to translate to the provider's native field — and gracefully degrade for providers that don't support it (Copilot via gateway, Pi.ai, llamacpp pre-grammar, etc.).
- Still need the F03 helper as the fallback path for providers without support.

That is its own multi-file refactor and belongs in a separate issue against the provider layer, not in F03. The shared parser (Proposal B) is the correct factoring **regardless** of whether structured-output mode is later wired up — the parser becomes the fallback when the structured path fails.

## Recommendation

**Proposal B.**

Rationale:
- B is the explicit level-up suggested by the F03 issue text ("Zod schema + robust extractor + typed `Result<T>`").
- B fixes the silent-success-on-parse-failure bug; A does not.
- B's risk is bounded: the behaviour change is in the correct direction (visible failures replace silent fake-successes) and the schemas already exist.
- B's interaction with F09 and F05 is strictly positive: both downstream fixes get smaller and cleaner.
- The cost (test fixtures need to acknowledge the new "failed" path for malformed model output) is one-time and aligned with project guidelines (architecture-first, no backward compatibility for the silent-success behaviour).

The plan in [03-plan-r1.md](03-plan-r1.md) follows Proposal B.
