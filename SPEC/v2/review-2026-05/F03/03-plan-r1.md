# F03 — Implementation plan (R1)

Plan for **Proposal B** from [02-design-r1.md](02-design-r1.md): shared `src/parse-llm-json.ts` with `extractJsonObject`, `parseLlmJson`, and schema-typed `parseLlmJsonAs`; silent-success branches deleted from worker / inspector / manager parsers.

## Cross-issue ordering

- **Run after F01** if F01 has decided designer's fate. If F01 has deleted [src/agents/designer.ts](../../../../src/agents/designer.ts), F03 has one fewer file to touch. If F01 has not yet landed, F03 still edits designer for completeness (same diff shape as the other 4 workers).
- **Prefer to run before F09**, but order does not block. If F09 lands first, the 5 worker `parseTaskReport` copies become 1 worker base helper that F03 then edits — same end state, fewer files in F03's diff. If F03 lands first, F09's consolidation inherits the already-schema-validated parser. Either order works; no merge conflict.
- **Run before F05**. F05 deletes `normalizeNonStuckOperationalVerdict` and reshapes supervisor's verdict pipeline; F05 expects `parseVerdict` to surface parse-failure detail via the verdict's `evidence` field, which is Proposal B's behaviour.
- **Run before / independent of F25**. F25 reshapes cop's heuristic patterns; F03 only changes how the cop's model-verdict path extracts JSON.
- **Run independent of F14** (reviewer double assistant push) — disjoint code areas.

## Step-by-step edits

### Step 1 — Add `src/parse-llm-json.ts`

Create `src/parse-llm-json.ts` exporting:

- `extractJsonObject(text: string): string | null`
- `parseLlmJson(text: string): unknown | null`
- `parseLlmJsonAs<S extends ZodTypeAny>(text: string, schema: S): ParseResult<z.infer<S>>`
- `type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: "no_json" | "invalid_json" | "schema_mismatch"; detail: string; raw: string | null }`

`extractJsonObject` strategy, in order, returning the first that yields a string whose `JSON.parse` does not throw:

1. **Fenced-block strip**: if `text` matches ```` /```(?:json)?\s*\n([\s\S]*?)\n``` ```` for any fenced block, try its body.
2. **Whole-message parse**: try `text.trim()` as-is.
3. **Balanced-brace scan**: iterate `text`, tracking depth on `{`/`}` while respecting string literals (`"..."` with backslash escapes). When depth returns to 0, record the candidate `[start, end]`. Return the **last** balanced candidate (which is overwhelmingly the model's final report rather than a fenced example earlier in the message — matching the spirit of the old regex, but balanced).

If none of the three strategies produces a parseable substring, return `null`.

`parseLlmJson` = `extractJsonObject` → `JSON.parse` (which by construction will not throw because the extractor already validated). Returns `null` if extractor returned `null`.

`parseLlmJsonAs(text, schema)`:

- Call `extractJsonObject(text)`. If `null` → `{ ok: false, reason: "no_json", detail: "model emitted no parseable JSON object", raw: null }`.
- `JSON.parse` the substring. On throw (shouldn't happen given extractor contract, but defence at module boundary): `{ ok: false, reason: "invalid_json", detail: err.message.slice(0, 300), raw: substring.slice(0, 300) }`.
- `schema.safeParse` the parsed value. On failure: `{ ok: false, reason: "schema_mismatch", detail: result.error.issues.map(i => i.path.join(".") + ": " + i.message).join("; ").slice(0, 300), raw: substring.slice(0, 300) }`.
- On success: `{ ok: true, value: result.data }`.

### Step 2 — Add `src/parse-llm-json.test.ts`

Vitest. Cases:

- `extractJsonObject` recovers clean JSON, JSON-in-fenced-block, JSON-with-prose-prefix, JSON-with-prose-suffix, JSON with `}` inside a string literal (must not break the balanced scan).
- `extractJsonObject` returns `null` for "no braces at all", for "unbalanced single `{`", and for "balanced braces but the substring is not valid JSON" (e.g., `{a: 1}` with unquoted key).
- `extractJsonObject` picks the **last** balanced object when the message contains a fenced example earlier and a real object at the end.
- `parseLlmJsonAs` against a small Zod schema: success path, `no_json`, `invalid_json` (engineered by giving `extractJsonObject` a string the extractor mis-classifies — rely on the schema-mismatch path being independently exercised), `schema_mismatch` (right shape, wrong type).
- One test for the `}` -inside-string-literal case using `{"summary": "she said \"hi}\" then left", "status": "completed"}` — the old regex handles this by luck; the balanced scanner must handle it on purpose.

### Step 3 — Update worker `parseTaskReport` (5 files)

For each of [coder.ts](../../../../src/agents/coder.ts#L263-L320), [researcher.ts](../../../../src/agents/researcher.ts#L260-L313), [data-agent.ts](../../../../src/agents/data-agent.ts#L176-L229), [reviewer.ts](../../../../src/agents/reviewer.ts#L206-L259), and (if not deleted by F01) [designer.ts](../../../../src/agents/designer.ts#L191-L244):

1. Add `import { parseLlmJsonAs } from "../parse-llm-json";` and `import { TaskReportSchema } from "../types";` (the latter already imported in some files; check before adding duplicate).
2. Replace the `jsonMatch = text.match(...); if (jsonMatch) { try { JSON.parse ...; return {...success template...}; } catch {} } return {...synthesised completion...};` block with:

```ts
const result = parseLlmJsonAs(text, TaskReportSchema.partial());
if (!result.ok) {
  return buildFailureReport(input, startedAt, startMs, `worker emitted ${result.reason}: ${result.detail}`);
}
const parsed = result.value;
return {
  task_id: parsed.task_id ?? input.task.id,
  stage_id: parsed.stage_id ?? input.stageId,
  agent: "<role>", // literal stays per-file
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

3. The `summary: text.slice(0, 500)` fallback in the success path is replaced with `parsed.summary ?? ""` (empty rather than truncated raw text — if the model emitted valid JSON it owns the summary; if it didn't, we route through `buildFailureReport`).
4. Delete the trailing synthesised-completion fallback block in its entirety.

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

`tsup` builds `dist/`; `npm run build` invokes it per `package.json`. After the build, deploy verification follows the standard project flow (the `saivage` repo is the v2 codebase used by the `saivage-v3` and `diedrico` v2 harness containers per the workspace handoff). No special deployment instructions for this refactor — it's a pure source change.

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
- `npm run build` produces `dist/` without errors.
- All vitest runs green.
