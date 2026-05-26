# F25 Plan r1 — Proposal B: regex deleted, cop is LLM-only

## Edit steps

1. **[src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts)**
   1. Narrow `PromptInjectionScanResult.scanner` ([#L13-L20](src/security/prompt-injection-cop.ts#L13-L20)) from `"heuristic" | "llm" | "disabled" | "skipped"` to `"llm" | "disabled" | "skipped"`.
   2. Delete `BLOCK_PATTERNS` ([#L28-L38](src/security/prompt-injection-cop.ts#L28-L38)) and `SUSPICIOUS_PATTERNS` ([#L40-L49](src/security/prompt-injection-cop.ts#L40-L49)) entirely.
   3. Delete `scanHeuristically` ([#L156-L176](src/security/prompt-injection-cop.ts#L156-L176)) and `shouldAskModel` ([#L178-L180](src/security/prompt-injection-cop.ts#L178-L180)).
   4. Rewrite `DefaultPromptInjectionCop.scan()` ([#L82-L94](src/security/prompt-injection-cop.ts#L82-L94)): clip content to `maxScanChars`, then call `scanWithModel`. If `scanWithModel` returns `null`, return a fail-open result:
      ```ts
      return {
        allowed: true,
        verdict: "allow",
        reason: "llm unavailable; allowing",
        confidence: 0,
        scanner: "llm",
      };
      ```
   5. Keep `scanWithModel` ([#L96-L148](src/security/prompt-injection-cop.ts#L96-L148)) unchanged in behaviour. It still returns `null` on any failure; the new `scan()` translates `null` into the fail-open result.
   6. Remove the `scanHeuristically` export. No other code imports it (verified: only `prompt-injection-cop.test.ts` does, which this plan rewrites).

2. **[src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts)**
   1. Delete the existing two tests (they import `scanHeuristically`, which no longer exists).
   2. Add tests for the LLM-backed `scan()` against a stub `ModelRouter`:
      - "blocks when the LLM returns `verdict: block`" — stub `router.chat` to return JSON `{"verdict":"block","confidence":0.9,"reason":"asks the agent to ignore instructions"}`. Expect `allowed: false`, `scanner: "llm"`, `reason` set.
      - "allows when the LLM returns `verdict: allow`" — stub returns `{"verdict":"allow","confidence":0.8,"reason":"research note"}`. Expect `allowed: true`, `scanner: "llm"`.
      - "fail-open when the LLM call throws" — stub `router.chat` to throw. Expect `allowed: true`, `scanner: "llm"`, `reason: "llm unavailable; allowing"`.
      - "fail-open when the LLM returns unparseable content" — stub returns `"not json"`. Expect `allowed: true`, `scanner: "llm"`.
      - "passes through when scanner disabled" — `config.security.injectionScanner = false`, `createPromptInjectionCop(...)` returns the disabled cop; expect `scanner: "disabled"`, `allowed: true`.
   3. Tests use a hand-rolled stub matching `ModelRouter`'s `chat`, `getProvider`, and `resolveApiKey` surface ([src/providers/router.ts](src/providers/router.ts)). Use the simplest stub that satisfies the calls in `scanWithModel`. Do not import the real router.

3. **[src/mcp/builtins.ts](src/mcp/builtins.ts)**
   1. In `downloadUrl()` ([#L211-L222](src/mcp/builtins.ts#L211-L222)), when `scanUntrustedText` throws, prefix the message before assigning to `attempt.error`:
      ```ts
      attempt.error = `prompt-injection cop blocked: ${err instanceof Error ? err.message : String(err)}`;
      ```
      This makes blocks distinguishable from network failures in logs/`attempts[]`. Single-line change. (Note: `scanUntrustedText`'s thrown message already starts with `"Prompt injection blocked: "`, so the resulting string will be `"prompt-injection cop blocked: Prompt injection blocked: <reason>"`. Tighten by also dropping the redundant prefix from `scanUntrustedText`'s thrown `Error` in [src/mcp/builtins.ts](src/mcp/builtins.ts#L155-L158): throw the bare reason; the prefix is added at the catch site.)

## Test strategy

- **Existing coverage that must keep passing.** The only direct test of the cop is [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts), which is being rewritten per step 2. No other test file references `scanHeuristically`, `BLOCK_PATTERNS`, or `SUSPICIOUS_PATTERNS` (grep confirmed).
- **No new MCP-level tests** are required for this change. The `attempt.error` prefix is a string-formatting tweak and is covered by manual inspection plus type-checking.
- **Sanity check on the cop test stub.** The stub must implement the minimum `ModelRouter` surface used by `scanWithModel`: `chat(opts)`, `getProvider(name)`, `resolveApiKey(name)`. For tests that exercise the bare-model-spec path (no `/` in `modelSpec`), the stub does not need `getProvider`; for the parsed-id path it does.

### Commands

From repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/security/prompt-injection-cop.test.ts
```

Then full suite:

```bash
npx vitest run
```

## Rollback

Single commit covering the three files. Revert via `git revert <sha>`. No on-disk schema changes, no config-shape changes, no migration step. The `scanner` union narrowing is source-level only (the JSON shape on the wire — `prompt_injection_scan` inside `DownloadSuccess` — never carried `"heuristic"` as an externalised contract; it is internal to `src/mcp/builtins.ts`).

## Cross-issue ordering

- **Independent of F03** (JSON parser tightening): may land in either order. After F25, `parseModelVerdict` is on the critical path for every scan, so F03's tightening becomes more visible — but neither is a prerequisite for the other.
- **Independent of F04** (default model spec): may land in either order.
- **Must land before F29** (PI scan `as any` typing): F29 retypes the consumer of `PromptInjectionScanResult.scanner`; doing F25 first means F29 retypes against the narrowed union, avoiding wasted work.
- **No interaction with the out-of-scope `src/skills/` area.**
