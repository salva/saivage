# F03 — Implementation plan (R3)

Plan for **Proposal B** from [02-design-r3.md](02-design-r3.md): shared `src/parse-llm-json.ts` with `extractJsonCandidates`, `parseLlmJson`, and schema-typed `parseLlmJsonAs`; silent-success branches deleted from worker / inspector / manager parsers.

## Changes from r2

- **Step 1 reconciled with Step 2.** The whole-trimmed message is now contributed as a candidate **only when `text.trim().startsWith("{")`**. Prose-only input with no `{` therefore makes `extractJsonCandidates` return `[]`, which is exactly what the Step 2 test for `no_json` requires. Removes the r2 contradiction where Step 1 said "even if it does not look like JSON" while Step 2 asserted prose-only input returns `[]`.
- **Step 1 wording on `parseLlmJsonAs` selection rule corrected.** The selection rule is "pick the last candidate that survives `JSON.parse`, then schema-check that single value". `parseLlmJsonAs` does not retry earlier parseable candidates if the last one fails the schema; the failure surfaces as `schema_mismatch`. r2's "Changes from r1" wording that said "pick the last that parses (and, for the typed variant, that also satisfies the schema)" was incorrect and is removed. The detailed algorithm in Step 1 already encoded "schema-check the last parseable"; only the surrounding prose changes.
- Step 2 adds an explicit assertion of the rule: a message containing an earlier well-shaped report and a later wrong-shape report parses to `schema_mismatch` (not to a successful match on the earlier object).

## Changes from r1

- **Step 1 rewritten** to match the design's single extraction rule. The helper now exposes `extractJsonCandidates(text): string[]` returning **raw** substrings (whole-trimmed when it starts with `{`, fenced bodies, balanced-brace spans) in source order, with no parse-or-skip logic inside the extractor. `parseLlmJson` and `parseLlmJsonAs` walk that list and pick the last that parses. This removes r1's contradiction where Step 1 specified fenced-first precedence while Step 2 expected the final balanced object to win.
- **`invalid_json` is now reachable**, so the Step 2 test for it is meaningful. Because candidates are raw substrings, balanced spans that don't survive `JSON.parse` (e.g. `{a: 1}` with unquoted key) flow through to `parseLlmJsonAs` and surface as `invalid_json` with the first parse-error message in `detail`.
- **Step 3 uses `TaskReportSchema.omit({ agent: true }).partial()`** for worker payloads. This decouples F03 from F01: designer's `agent: "designer"` literal is never schema-checked because `agent` is owned by the runtime worker class (each worker injects its own role into the returned `TaskReport`). r1's `TaskReportSchema.partial()` would have rejected otherwise-valid designer payloads.
- Step 2 adds explicit tests for the "last balanced object wins" rule with an earlier fenced example and for the new `invalid_json` reachability.
- Cross-issue ordering simplified: F03 is now **independent of F01** instead of "run after F01 if F01 has decided designer's fate".

## Cross-issue ordering

- **Independent of F01.** Because worker validation omits `agent` and the runtime injects it, F03 does not care whether F01 widens the `TaskReportSchema.agent` enum to include `"designer"`, deletes designer, or leaves the schema as-is.
- **Prefer to run before F09**, but order does not block. If F09 lands first, the 5 worker `parseTaskReport` copies become 1 worker base helper that F03 then edits — same end state, fewer files in F03's diff. If F03 lands first, F09's consolidation inherits the already-schema-validated parser. Either order works; no merge conflict.
- **Run before F05.** F05 deletes `normalizeNonStuckOperationalVerdict` and reshapes supervisor's verdict pipeline; F05 expects `parseVerdict` to surface parse-failure detail via the verdict's `evidence` field, which is Proposal B's behaviour.
- **Run before / independent of F25.** F25 reshapes cop's heuristic patterns; F03 only changes how the cop's model-verdict path extracts JSON.
- **Independent of F14** (reviewer double assistant push) — disjoint code areas.

## Step-by-step edits

### Step 1 — Add `src/parse-llm-json.ts`

Create `src/parse-llm-json.ts` exporting:

- `extractJsonCandidates(text: string): string[]`
- `parseLlmJson(text: string): unknown | null`
- `parseLlmJsonAs<S extends ZodTypeAny>(text: string, schema: S): ParseResult<z.infer<S>>`
- `type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: "no_json" | "invalid_json" | "schema_mismatch"; detail: string; raw: string | null }`

`extractJsonCandidates` returns a list of **raw substrings** (no parsing inside the extractor), in source order. The three contributing sources are:

1. The trimmed whole message — contributed **only when `text.trim().startsWith("{")`**. This guard is what keeps `no_json` reachable: prose-only input (no `{` anywhere) skips this source and, because sources 2 and 3 also contribute nothing, the candidate list is `[]`.
2. The body of every fenced block matching `/```(?:json)?\s*\n([\s\S]*?)\n```/g` (deduplicated against the whole-trimmed candidate by simple `!==` only if the trimmed message itself is exactly the fenced body).
3. Every maximal balanced top-level brace span. Single left-to-right pass tracking:
   - `depth: number` — starts at 0, increments on `{`, decrements on `}`.
   - `inString: boolean` and `escape: boolean` — toggled on `"` and `\` per standard JSON string-literal rules.
   - When `depth` transitions `0 -> 1` outside a string, record `start`. When it transitions back to `0`, push `text.slice(start, i + 1)`.
   - Braces inside string literals are not counted.

Source order is preserved across the three sources. No deduplication beyond the whole-trimmed-vs-fenced-equal check.

`parseLlmJson(text)`:

- `const candidates = extractJsonCandidates(text)`; if `[]`, return `null`.
- Iterate candidates in order; for each, try `JSON.parse`; remember the last successful parse.
- Return that value, or `null` if none parsed.

`parseLlmJsonAs(text, schema)` selection rule: "pick the last candidate that survives `JSON.parse`, then schema-check that single value". The schema check is a single yes/no on the last parseable candidate; the parser does **not** retry earlier parseable candidates when the schema fails. A later wrong-shape report therefore surfaces as `schema_mismatch`, not silently masked by an earlier example.

1. `const candidates = extractJsonCandidates(text)`.
2. If `candidates.length === 0`: `{ ok: false, reason: "no_json", detail: "model emitted no candidate JSON substring", raw: null }`.
3. Walk candidates, tracking `lastParsedValue` / `lastParsedRaw` (most recent `JSON.parse` success) and `firstParseError` (first `JSON.parse` failure message).
4. If no candidate parsed: `{ ok: false, reason: "invalid_json", detail: firstParseError.slice(0, 300), raw: candidates[0].slice(0, 300) }`.
5. `const result = schema.safeParse(lastParsedValue);` — last parseable only, no fallback.
   - On success: `{ ok: true, value: result.data }`.
   - On failure: `{ ok: false, reason: "schema_mismatch", detail: result.error.issues.map(i => i.path.join(".") + ": " + i.message).join("; ").slice(0, 300), raw: lastParsedRaw.slice(0, 300) }`.

### Step 2 — Add `src/parse-llm-json.test.ts`

Vitest. Cases:

- `extractJsonCandidates` returns `[]` for empty input and for prose-only input with no `{` (E1). This is the test the r3 contract makes meaningful via the `startsWith("{")` guard on the whole-trimmed source.
- `extractJsonCandidates` includes the whole-trimmed candidate for clean JSON input like `'{"ok":true}'`.
- `extractJsonCandidates` does NOT include the whole-trimmed candidate for input that begins with prose, e.g. `'I am done. {"status":"completed"}'` — the whole-trimmed source is skipped because it does not `startsWith("{")`, but source 3 still contributes the balanced span `{"status":"completed"}`.
- `extractJsonCandidates` includes the body of a ```` ```json … ``` ```` block.
- `extractJsonCandidates` includes a balanced top-level brace span found via the depth scan.
- `extractJsonCandidates` does **not** split on braces inside string literals; given `{"summary": "she said \"hi}\" then left", "status": "completed"}` the only balanced candidate is the whole object.
- `extractJsonCandidates` preserves source order when both a fenced example and a later balanced object exist.
- `parseLlmJson` picks the **last** parseable candidate when the message contains an earlier fenced example and a later real report (this is the explicit replacement for the old greedy regex).
- `parseLlmJson` returns `null` for E1 (no candidates) and for "candidates exist but none parse" (e.g. only `{a: 1}` with unquoted key).
- `parseLlmJsonAs` against a small Zod schema:
  - Success: well-formed JSON matching the schema → `{ ok: true, value: ... }`.
  - `no_json`: empty / prose-only input → `{ ok: false, reason: "no_json", ... }`.
  - `invalid_json`: input where every candidate fails `JSON.parse` (e.g. message containing only `{a: 1}`) → `{ ok: false, reason: "invalid_json", detail: <parse-error>, raw: "{a: 1}" }`. This is the reachability test the r1 reviewer flagged.
  - `schema_mismatch`: valid JSON but wrong type for a field (e.g. `{"status": 42}` against a schema requiring string `status`).
  - **Selection-rule test (new in r3):** input containing an earlier well-shaped object `{"status": "completed"}` followed by a later wrong-shape object `{"status": 42}` returns `{ ok: false, reason: "schema_mismatch", ... }`. The parser must NOT silently return the earlier matching object; the last parseable wins, and its schema check decides the result.
- "Last balanced object wins" rule: an input with a fenced example `{"example": true}` followed by a real report `{"status": "completed"}` parses to the real report under both `parseLlmJson` and `parseLlmJsonAs`.

### Step 3 — Update worker `parseTaskReport` (5 files)

For each of [coder.ts](../../../../src/agents/coder.ts#L263-L320), [researcher.ts](../../../../src/agents/researcher.ts#L260-L313), [data-agent.ts](../../../../src/agents/data-agent.ts#L176-L229), [reviewer.ts](../../../../src/agents/reviewer.ts#L206-L259), and (if not deleted by F01) [designer.ts](../../../../src/agents/designer.ts#L191-L244):

1. Add `import { parseLlmJsonAs } from "../parse-llm-json";` and `import { TaskReportSchema } from "../types";` (the latter already imported in some files; check before adding duplicate).
2. Define the per-call validation schema once at module level:

```ts
const WorkerPayloadSchema = TaskReportSchema.omit({ agent: true }).partial();
```

Because `agent` is omitted, the schema works identically for all five workers (including designer, whose `"designer"` literal is not in the `TaskReportSchema.agent` enum). Each worker still injects its own `agent: "<role>"` after validation.

3. Replace the `jsonMatch = text.match(...); if (jsonMatch) { try { JSON.parse ...; return {...success template...}; } catch {} } return {...synthesised completion...};` block with:

```ts
const result = parseLlmJsonAs(text, WorkerPayloadSchema);
if (!result.ok) {
  return buildFailureReport(input, startedAt, startMs, `worker emitted ${result.reason}: ${result.detail}`);
}
const parsed = result.value;
return {
  task_id: parsed.task_id ?? input.task.id,
  stage_id: parsed.stage_id ?? input.stageId,
  agent: "<role>", // literal stays per-file ("coder" / "researcher" / "data_agent" / "reviewer" / "designer")
  status: parsed.status ?? "completed",
  summary: parsed.summary ?? "",
  checklist_results: parsed.checklist_results ?? [],
  files_modified: parsed.files_modified ?? [],
  files_created: parsed.files_created ?? [],
  tests_added: parsed.tests_added ?? [],
  tests_run: parsed.tests_run ?? [],
  commits: parsed.commits ?? [],
  issues_found: parsed.issues_found ?? [],
  output_truncated: parsed.output_truncated,
  failure_reason: parsed.failure_reason,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  duration_ms: Date.now() - startMs,
};
```

4. The `summary: text.slice(0, 500)` fallback in the success path is replaced with `parsed.summary ?? ""` (empty rather than truncated raw text — if the model emitted valid JSON it owns the summary; if it didn't, we route through `buildFailureReport`).
5. Delete the trailing synthesised-completion fallback block in its entirety.
6. If `buildFailureReport` does not already exist as a shared helper, use the same per-file failure-report construction the workers already use for the `try/catch` around the model call (e.g. coder's existing failure path) — do not invent a new shared helper as part of F03 (that's F09 territory).

Once **F09** has consolidated the 5 worker `parseTaskReport` copies into one, this edit collapses to a single file with one literal-per-role injected via the worker base config.

### Step 4 — Update `parseInspectionReport`

In [src/agents/inspector.ts](../../../../src/agents/inspector.ts#L219-L256):

1. Import `parseLlmJsonAs` and `InspectionReportSchema`.
2. Replace the regex / parse / synthesise-from-`text.slice(0, 2000)` block with:

```ts
const result = parseLlmJsonAs(text, InspectionReportSchema.partial());
if (!result.ok) {
  return {
    id: request.id,
    requested_by: request.requested_by,
    request,
    findings: `Inspector emitted ${result.reason}: ${result.detail}`,
    recommendations: [],
    data: {},
    artifacts: [],
    created_at: new Date().toISOString(),
    expires_at: null,
    duration_ms: Date.now() - startMs,
  };
}
const parsed = result.value;
return {
  id: parsed.id ?? request.id,
  requested_by: parsed.requested_by ?? request.requested_by,
  request,
  findings: parsed.findings ?? "",
  recommendations: parsed.recommendations ?? [],
  data: parsed.data ?? {},
  artifacts: parsed.artifacts ?? [],
  created_at: new Date().toISOString(),
  expires_at: parsed.expires_at ?? null,
  duration_ms: Date.now() - startMs,
};
```

(`InspectionReportSchema` has no `agent`-enum issue, so `.partial()` is used directly.)

### Step 5 — Update `parseStageSummary`

In [src/agents/manager.ts](../../../../src/agents/manager.ts#L392-L436):

1. Import `parseLlmJsonAs` and `StageSummarySchema`.
2. Replace the regex / parse / synthesised-completed fallback with a `parseLlmJsonAs(text, StageSummarySchema.partial())` call. On `!result.ok`, return a `result: "failed"` summary with `summary: "Manager emitted ${result.reason}: ${result.detail}"` and `abort_reason: result.detail`. On success, overlay the parsed partial onto the existing defaults template (same overlay shape as today, minus the `?? text.slice(0, ...)` truncation paths).

### Step 6 — Update `parseModelVerdict` (cop)

In [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L182-L196):

1. Import `parseLlmJsonAs` and `z` from zod (already a dep).
2. Replace the function body with:

```ts
function parseModelVerdict(content: string) {
  const schema = z.object({
    verdict: z.enum(["allow", "block"]).default("allow"),
    confidence: z.number().min(0).max(1).default(0.5),
    reason: z.string().max(300).default("model returned no reason"),
  });
  const result = parseLlmJsonAs(content, schema);
  return result.ok ? result.value : null;
}
```

3. Caller at [L135](../../../../src/security/prompt-injection-cop.ts#L135) is unchanged — `null` → fall back to heuristic, preserved.

### Step 7 — Update supervisor's `parseVerdict` and delete `parseJsonObject`

In [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L171-L218):

1. Import `parseLlmJsonAs` and `z`.
2. Replace `parseVerdict` body to use a Zod schema for the supervisor verdict shape:

```ts
function parseVerdict(content: string, providerName: string): SupervisorVerdict {
  const schema = z.object({
    stuck: z.boolean().default(false),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().default("Supervisor did not provide a reason"),
    evidence: z.array(z.string()).max(5).optional(),
  });
  const result = parseLlmJsonAs(content, schema);
  if (!result.ok) {
    return {
      stuck: true,
      confidence: 0.4,
      reason: `Supervisor model (${providerName}) returned ${result.reason}`,
      evidence: [result.detail, result.raw ?? content.slice(0, 300)].filter(Boolean),
    };
  }
  const parsed = result.value;
  return {
    stuck: parsed.stuck,
    confidence: parsed.confidence,
    reason: parsed.reason,
    evidence: parsed.evidence,
  };
}
```

3. Delete `function parseJsonObject` ([L204-L218](../../../../src/runtime/supervisor.ts#L204-L218)) in its entirety. No other caller exists (`grep -RnE 'parseJsonObject' src/` → only the two hits inside `supervisor.ts`).

### Step 8 — Sanity-grep for stragglers

After all edits:

```bash
grep -RnE 'match\(/\\\{\[\\s\\S\]\*\\\}/\)' src/ --include='*.ts'
grep -RnE 'parseJsonObject' src/ --include='*.ts'
```

Both must return zero hits.

## Test strategy

### Existing tests touched

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) — exercises worker agents. Fixtures that today succeed because the regex silently lies may flip to failure under Proposal B; the affected tests should be updated to either feed valid-JSON fixtures (most cases) or assert the new failure path (one or two cases that intentionally exercise malformed output).
- [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) — exercises cop end-to-end including model verdict. Existing fixtures should keep passing because the cop's `null`-on-parse-failure behaviour is preserved.
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — supervisor coverage. Verify the synthetic "stuck=true with content as evidence" path still triggers when the model returns non-JSON.

Run each test file targeted while iterating:

```bash
npx vitest run src/parse-llm-json.test.ts
npx vitest run src/agents/agents.test.ts
npx vitest run src/security/prompt-injection-cop.test.ts
npx vitest run src/runtime/runtime.test.ts
```

### New tests

- `src/parse-llm-json.test.ts` per Step 2.

### Validation pipeline

Once edits are complete:

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run
```

`tsup` builds `dist/`; `npm run build` invokes it per `package.json`. No special deployment instructions for this refactor — it's a pure source change.

## Rollback strategy

Single commit. Revert restores the 8 regex sites and the supervisor's `parseJsonObject`. No data-format or on-disk-schema changes; rollback is purely code-level. Test fixtures that were updated to feed valid JSON keep working on revert (they are stricter than the pre-revert code required). One or two fixtures updated to assert the new failure path would need to be reverted alongside.

## Concrete validation commands

```bash
cd /home/salva/g/ml/saivage
# Confirm no straggling regex sites
grep -RnE 'match\(/\\\{\[\\s\\S\]\*\\\}/\)' src/ --include='*.ts'
grep -RnE 'parseJsonObject' src/ --include='*.ts'

# Type, build, test
npm run typecheck
npm run build
npx vitest run src/parse-llm-json.test.ts
npx vitest run src/agents/agents.test.ts
npx vitest run src/security/prompt-injection-cop.test.ts
npx vitest run src/runtime/runtime.test.ts
npx vitest run
```

Expected:
- Both `grep` commands print nothing.
- `npm run typecheck` exits clean (`tsconfig.json` strict).
