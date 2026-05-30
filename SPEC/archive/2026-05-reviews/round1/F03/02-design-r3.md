# F03 — Design (R3)

## Changes from r2

- Fixed the candidate-enumeration contract so the failure taxonomy is consistent across analysis, design, and plan. The whole-trimmed message is now contributed as a candidate **only when `text.trim().startsWith("{")`**. Prose-only input (no `{` anywhere) therefore yields `[]`, and `parseLlmJsonAs` returns `no_json` rather than `invalid_json`. This closes the r2 reviewer finding that `no_json` was unreachable.
- Restated the typed-parser selection rule consistently. `parseLlmJsonAs` picks the **last candidate that survives `JSON.parse`** and schema-checks that single value; if the schema fails, the result is `schema_mismatch`. The parser does **not** fall back to an earlier parseable candidate that happens to satisfy the schema. The r2 "Changes from r1" wording that said "the last candidate that also satisfies the schema" was incorrect and is removed. The detailed Proposal B algorithm already encoded this rule; only the prose changes.

## Changes from r1

- Reworked the extractor contract to make "later objects override earlier examples" the single, explicit rule shared by both design and plan. r1's "fenced first, then whole, then balanced" precedence could let an earlier fenced example beat a final real report (reviewer-flagged inconsistency with the r1 plan's E4 test). New contract: `extractJsonCandidates(text)` enumerates raw substrings in source order (whole-trimmed message when it starts with `{`, every fenced block body, every balanced top-level brace span); `parseLlmJson` picks the last candidate that parses; `parseLlmJsonAs` picks the last candidate that parses and schema-checks that one value, surfacing a wrong-shape last candidate as `schema_mismatch`.
- Made `ParseResult.reason = "invalid_json"` reachable. Because `extractJsonCandidates` returns **raw, unparsed** substrings, the parsing layer can distinguish "no candidate" (`no_json`) from "candidate that fails `JSON.parse`" (`invalid_json`). r1's `extractJsonObject` only returned already-parseable strings, so `invalid_json` was structurally unreachable.
- Worker validation now uses `TaskReportSchema.omit({ agent: true }).partial()` and overlays the worker's literal role afterward. This decouples F03 from F01: the parser is correct whether or not F01 widens the agent enum to include `"designer"` or deletes designer entirely.
- Corrected the fenced-block claim in the risk section. The old regex slice does not include surrounding backticks; the actual recovery benefit on a single fenced block is on the **multiple-objects** case (E4) and the **fenced-plus-trailing-stray-brace** case (E5), not on backticks.

## Proposal A — Focused fix: shared candidate-enumerating helper

### Scope

New module at top-level `src/`, matching the existing convention (`src/log.ts`, `src/ids.ts`, `src/types.ts`):

- **Add**: `src/parse-llm-json.ts` — ~60 lines.
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
export function extractJsonCandidates(text: string): string[];
export function parseLlmJson(text: string): unknown | null;
```

**Single extraction rule, stated once:** `extractJsonCandidates` walks the input and returns every plausibly-JSON substring it can identify, in source order. The three contributing sources are:

1. The whole `text.trim()` — contributed **only when `text.trim().startsWith("{")`**. This guard is what keeps a prose-only response (no `{` anywhere) from producing a spurious candidate and lets `parseLlmJsonAs` return `no_json` for that case.
2. The body of every fenced block matching `/```(?:json)?\s*\n([\s\S]*?)\n```/g`.
3. Every balanced top-level brace span: a left-to-right scan tracks `{`/`}` depth while respecting string literals (`"..."` with backslash escapes). Each maximal depth-returns-to-zero region is appended.

The list is returned **as-is** — no parsing, no deduplication. Source order matters.

`parseLlmJson(text)` calls `extractJsonCandidates`, tries `JSON.parse` on each candidate, and returns the **last** value that parses successfully. Returns `null` if none parse. The "last wins" rule is the explicit replacement for the old "first-`{`-to-last-`}` greedy span": later content in a model message is overwhelmingly the final report; earlier content is overwhelmingly an example.

### What gets removed

- The 8 in-file occurrences of `const jsonMatch = text.match(/\{[\s\S]*\}/);` plus their surrounding `try { JSON.parse(jsonMatch[0]) } catch { ... }` block.
- `src/runtime/supervisor.ts` `function parseJsonObject` ([L204-L218](../../../../src/runtime/supervisor.ts#L204-L218)) deleted; supervisor imports the shared helper.

### What stays unchanged

- The per-site **fallback synthesis** (worker `parseTaskReport` defaulting to `status: "completed"`, manager `parseStageSummary` defaulting to `result: "completed"`, etc.). Proposal A is purely about how the JSON substring is found and parsed. The "lie about success on parse failure" bug stays — F03 issue text calls it out but Proposal A does not fix it; that's an explicit Proposal B feature.
- The post-parse field-by-field `?? defaults` overlay in each caller. No schema validation added.
- Cop returns `null`; supervisor still escalates to `stuck: true`; workers still synthesise success. All preserved.

### Risk

- **Low**. Each call site's behaviour is preserved on the dominant cases (clean JSON, prose around JSON, missing JSON). Behaviour on the degenerate "two JSON objects in one response" case **improves** for all callers — the new scanner returns each balanced object as its own candidate and the parser picks the last one rather than a merged invalid span.
- The fenced-block enumeration is new behaviour and changes one edge case: a response like ```` ```json {...} ``` ```` followed by trailing prose that contains a stray `}` will now parse correctly. The old regex slice ran from the first `{` to that stray `}` and failed to parse, dropping to the silent-success fallback. (Note: a single fenced JSON block with no trailing braces parses fine under the old regex too — the slice is just `{...}`, backticks are excluded.)
- No provider behaviour change. No prompt change.

### What this enables (cross-link)

- **F09** (worker helper extraction): once the 5 worker `parseTaskReport` copies share a base via F09, the F03 helper has one consumer there instead of 5. F03 + F09 compose without conflict regardless of order.
- **F05** (supervisor regex undermines LLM): F05 can delete `normalizeNonStuckOperationalVerdict` on top of a `parseVerdict` that calls the shared `parseLlmJson`. F05 stays orthogonal.

### What this forbids

- Adding a third copy of the regex anywhere. New code that wants JSON out of an LLM response **must** import from `src/parse-llm-json.ts`.

### Recommendation note for A

A is the minimum-viable execution of the F03 issue text. It removes the 9 duplicated call sites and fixes the multiple-objects bug. It does **not** fix the silent-success-on-parse-failure bug that is the most-consequential symptom of F03. That bug is callable in CI today by feeding a worker LLM a response with no JSON: the task is recorded as completed-with-empty-fields and the manager believes work happened. Proposal A leaves that bug in place.

## Proposal B — Level up: schema-typed parsing with `Result<T>`

### Scope

Same physical file `src/parse-llm-json.ts`, larger surface:

```ts
// src/parse-llm-json.ts
import type { ZodTypeAny, z } from "zod";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "no_json" | "invalid_json" | "schema_mismatch"; detail: string; raw: string | null };

export function extractJsonCandidates(text: string): string[];
export function parseLlmJson(text: string): unknown | null;
export function parseLlmJsonAs<S extends ZodTypeAny>(text: string, schema: S): ParseResult<z.infer<S>>;
```

`parseLlmJsonAs` algorithm:

1. `const candidates = extractJsonCandidates(text)`.
2. If `candidates.length === 0`: `{ ok: false, reason: "no_json", detail: "model emitted no candidate JSON substring", raw: null }`.
3. Walk `candidates` in source order; for each, attempt `JSON.parse`. Track:
   - `lastParsedValue` and `lastParsedRaw` — the most recent candidate that survives `JSON.parse`.
   - `firstParseError` — error message of the first `JSON.parse` failure (used as `detail` if nothing parses).
4. If no candidate parsed: `{ ok: false, reason: "invalid_json", detail: firstParseError.slice(0, 300), raw: candidates[0].slice(0, 300) }`.
5. `result = schema.safeParse(lastParsedValue)` — schema-check the **last parseable candidate only**; do not retry earlier candidates.
   - On `success`: `{ ok: true, value: result.data }`.
   - On `failure`: `{ ok: false, reason: "schema_mismatch", detail: result.error.issues.map(i => i.path.join(".") + ": " + i.message).join("; ").slice(0, 300), raw: lastParsedRaw.slice(0, 300) }`.

The selection rule is "last parseable wins"; the schema check is a single yes/no on that one value, not a search across candidates. A later wrong-shape report surfaces as `schema_mismatch` rather than being masked by an earlier example that happened to satisfy the schema.

All three reasons (`no_json`, `invalid_json`, `schema_mismatch`) are now reachable. `extractJsonCandidates` is the public lower-level primitive; if a future caller needs to walk candidates manually it can do so.

### Call-site changes versus A

All sites that today silently lie become explicit:

- **Worker `parseTaskReport`** (5 copies → 1 via F09, or 5 if F09 not yet landed):
  - Define the per-worker validation schema once: `const WorkerPayloadSchema = TaskReportSchema.omit({ agent: true }).partial();` This drops `agent` from validation because each worker statically owns its role. The result: F03 is correct regardless of F01's roster decisions, designer's `"designer"` literal is never schema-checked, and the worker injects its own role into the returned `TaskReport`.
  - Call `parseLlmJsonAs(text, WorkerPayloadSchema)`.
  - On `ok: true`, overlay the parsed partial onto the synthesised-fields template, injecting `agent: "<role>"` from the worker's literal role.
  - On `ok: false`, **return a failure TaskReport** via `buildFailureReport(input, startedAt, startMs, "worker emitted ${reason}: ${detail}")` (the constructor used by other failure paths) — `agent: "<role>"` is set explicitly. This makes failed parses observable: the manager sees a real failure, not a fake success.
- **`parseInspectionReport`** (inspector): same pattern with `InspectionReportSchema.partial()`. The inspector schema does not have an `agent` enum issue. Failure → an `InspectionReport` whose `findings` is `"Inspector emitted ${reason}: ${detail}"` — observable, not silent.
- **`parseStageSummary`** (manager): same pattern with `StageSummarySchema.partial()`. Failure → `result: "failed"` summary with a real failure reason in `summary` and `abort_reason`, instead of `result: "completed"` with truncated text.
- **`parseModelVerdict`** (cop): use a tiny inline Zod schema `z.object({verdict: z.enum(["allow","block"]).default("allow"), confidence: z.number().min(0).max(1).default(0.5), reason: z.string().max(300).default("model returned no reason")})`. On failure, return `null` as today (cop's fall-back-to-heuristic semantics preserved).
- **`parseVerdict`** (supervisor): tiny inline Zod schema for the verdict shape. On failure, retain today's "escalate to stuck=true with raw text as evidence" behaviour — pass the `detail` and `raw` from `ParseResult` into the synthetic verdict's `evidence` field. Slightly better signal than today's blanket "non-JSON verdict" string.

### What gets added

- `parse-llm-json.ts`: ~100 lines (60 for `extractJsonCandidates`, 20 for `parseLlmJson`, 20 for `parseLlmJsonAs` and the `ParseResult` type).
- A focused unit test `src/parse-llm-json.test.ts` covering all five error modes from the analysis (E1-E5) plus the schema-mismatch path and the "last balanced object wins" rule.

### What gets removed

- Everything Proposal A removes.
- **Additionally**: the per-site "synthesise success with truncated text" branch in every worker `parseTaskReport`, in `parseInspectionReport`, and in `parseStageSummary`. The synthesised-success path was specifically the F03 silent-success bug; Proposal B deletes those branches and routes through the existing failure-report constructors.
- The `?? defaults` overlays inside each caller for fields the schema's `.partial()` already drops to `undefined` — replaced by `?? defaults` overlay logic moved into the per-caller "fill in from context" step. Net LOC change: roughly neutral; the per-caller overlay shrinks and the parser grows.

### What stays unchanged

- Schemas in [src/types.ts](../../../../src/types.ts). No edits there. (Specifically: F03 does NOT widen `TaskReportSchema.agent` to include `"designer"`; that is F01's territory if it lands.)
- Provider layer. No structured-output requirement. No prompt change.
- Cop heuristic patterns and fall-back semantics. Supervisor's `normalizeNonStuckOperationalVerdict` (F05's territory).

### Risk

- **Moderate**. The silent-success → explicit-failure flip is a real behaviour change. Specifically: today, a worker that the model failed to summarise correctly is recorded as `status: "completed"` with the model's text in `summary`. Tomorrow it's recorded as `status: "failed"` with a `failure_reason`. Manager logic that aggregates worker reports into a stage summary changes outcome: stages that today look like "all completed, no useful findings" will tomorrow look like "some workers failed". This is the correct behaviour — F03 says exactly this — but it will trip existing test fixtures.
- The Zod-schema-driven parsing rejects responses that today were accepted. Because `WorkerPayloadSchema` is `.partial()` over `TaskReportSchema.omit({ agent: true })`, any subset of the schema fields with correct types validates. `schema_mismatch` only fires when the model returns a value of the **wrong type** for a field (e.g. `"status": 42`), which is itself a bug worth surfacing.

### What this enables (cross-link)

- **F09**: F09's consolidated worker `parseTaskReport` becomes a small function: enumerate candidates → schema-validate → overlay defaults → inject runtime `agent` literal → return. Without B, the consolidated F09 helper still embeds the "synthesise success" branch and the silent-failure behaviour stays in one place instead of five. F09's consolidation is **better** if F03/B lands first or alongside.
- **F05**: supervisor's `parseVerdict` no longer needs hand-rolled field checks; the schema does it. F05's cleanup of `normalizeNonStuckOperationalVerdict` is unblocked because `parseVerdict` now produces a verdict whose `evidence` already carries the parse failure detail — F05 can delete the regex post-processor without losing diagnostic signal.
- **F25**: cop's `parseModelVerdict` becomes a 3-line schema parse. Doesn't fix F25 (cop's heuristic false positives) but makes the model-scan path one less place F25 has to touch.
- **F01 independence**: explicitly noted — F03 does not depend on F01's resolution of the designer/agent-enum question because it omits `agent` from validation.
- **Future structured-output adoption**: if a future change adds provider-native JSON mode (today: zero providers support it in this repo), the shared helper is the single point where the "clean-JSON fast path" already runs (the whole-trimmed-message candidate is always tried when it starts with `{`). Providers can opt in by emitting clean JSON; no other changes needed.

### What this forbids

- Reintroducing per-call-site `?? defaults` for fields that belong to the schema. The schema is authoritative.
- Silent-success-on-parse-failure anywhere. Any new LLM-output-parsing call site must use `parseLlmJsonAs` and route parse failures to a real failure path.
- Letting the model declare its own `agent` role. That field is owned by the runtime worker class, not the LLM output.

### Recommendation note for B

B is the level-up the F03 issue text explicitly asks for ("returning typed `Result<T>`"). It composes naturally with F09 and F05, fixes the silent-success bug, uses schemas that already exist, and is fully decoupled from F01 thanks to the `omit({agent:true})` choice. The cost is acknowledging the behaviour flip in the test/fixture pass.

## Proposal C considered and rejected

The F03 issue text suggests as a possible level-up: "require providers to support structured-output mode where available, fall back only for those that don't." Inspection of [src/providers/](../../../../src/providers/) finds **zero providers** in this repo currently pass `response_format` / `json_schema` to their API. Implementing this would:

- Touch the provider abstraction in [src/providers/base.ts](../../../../src/providers/base.ts) and [src/providers/types.ts](../../../../src/providers/types.ts) to add a `responseFormat?: "json" | { schema: ZodTypeAny }` field on the request.
- Touch each of 8 provider adapters ([anthropic.ts](../../../../src/providers/anthropic.ts), [openai.ts](../../../../src/providers/openai.ts), [openai-codex.ts](../../../../src/providers/openai-codex.ts), [copilot.ts](../../../../src/providers/copilot.ts), [openrouter.ts](../../../../src/providers/openrouter.ts), [ollama.ts](../../../../src/providers/ollama.ts), [llamacpp.ts](../../../../src/providers/llamacpp.ts), [pi-ai.ts](../../../../src/providers/pi-ai.ts)) to translate to the provider's native field — and gracefully degrade for providers that don't support it.
- Still need the F03 helper as the fallback path for providers without support.

That is its own multi-file refactor and belongs in a separate issue against the provider layer, not in F03. The shared parser (Proposal B) is the correct factoring **regardless** of whether structured-output mode is later wired up — the parser becomes the fallback when the structured path fails.

## Recommendation

**Proposal B.**

Rationale:
- B is the explicit level-up suggested by the F03 issue text ("Zod schema + robust extractor + typed `Result<T>`").
- B fixes the silent-success-on-parse-failure bug; A does not.
- B's risk is bounded: the behaviour change is in the correct direction (visible failures replace silent fake-successes) and the schemas already exist.
- B's interaction with F09 and F05 is strictly positive: both downstream fixes get smaller and cleaner. F01 is fully decoupled.
- The cost (test fixtures need to acknowledge the new "failed" path for malformed model output) is one-time and aligned with project guidelines (architecture-first, no backward compatibility for the silent-success behaviour).

The plan in [03-plan-r3.md](03-plan-r3.md) follows Proposal B.
