# F25 Plan r2 — Proposal B: regex deleted, cop is LLM-only

## Changes from r1

- Added step 3: update [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) to replace `scanner: "heuristic"` literals with `scanner: "llm"` in the two stub-cop tests. r1 incorrectly claimed no MCP-level tests needed changes; they do, because the narrowed union makes the old literal a TypeScript error.
- Dropped the r1 catch-site prefix edit in `downloadUrl`. The `"Prompt injection blocked: "` prefix stays exclusively in `scanUntrustedText`; the three MCP fetch handlers (`downloadUrl`, `fetch_url`, `fetch_page_text`) keep their current `err.message` surfacing. This avoids the inconsistency the reviewer flagged: in r1, only `download_file` would have received a second prefix while `fetch_url`/`fetch_page_text` would not have. Single prefix in one place is the consistent contract.
- Corrected the rollback note: `prompt_injection_scan.scanner` IS visible in MCP tool output. The narrowing is an intentional response-shape change, not a source-only refactor. Rollback by `git revert` still works (single commit), and per project guidelines no compatibility shim is added.
- Updated test strategy to call out the two MCP-level assertions that match `/Prompt injection blocked/` — these continue to pass because the prefix stays in `scanUntrustedText`.

## Edit steps

1. **[src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts)**
   1. Narrow `PromptInjectionScanResult.scanner` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L13-L20)) from `"heuristic" | "llm" | "disabled" | "skipped"` to `"llm" | "disabled" | "skipped"`.
   2. Delete `BLOCK_PATTERNS` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L28-L38)) and `SUSPICIOUS_PATTERNS` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L40-L49)) entirely.
   3. Delete `scanHeuristically` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L156-L176)) and `shouldAskModel` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L178-L180)).
   4. Rewrite `DefaultPromptInjectionCop.scan()` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L82-L94)): clip content to `maxScanChars`, call `scanWithModel`. If `scanWithModel` returns `null`, return:
      ```ts
      return {
        allowed: true,
        verdict: "allow",
        reason: "llm unavailable; allowing",
        confidence: 0,
        scanner: "llm",
      };
      ```
   5. `scanWithModel` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L96-L148)) keeps current behaviour (returns `null` on any failure); new `scan()` translates `null` into the fail-open result.
   6. Remove the `scanHeuristically` export. No production code imports it; only [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts) does, which is rewritten in step 2.

2. **[src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts)**
   1. Delete the existing tests that import `scanHeuristically`.
   2. Add tests for the LLM-backed `scan()` against a stub `ModelRouter`:
      - "blocks when the LLM returns `verdict: block`" — stub `router.chat` returns JSON `{"verdict":"block","confidence":0.9,"reason":"asks the agent to ignore instructions"}`. Expect `allowed: false`, `scanner: "llm"`, `reason` set.
      - "allows when the LLM returns `verdict: allow`" — stub returns `{"verdict":"allow","confidence":0.8,"reason":"research note"}`. Expect `allowed: true`, `scanner: "llm"`.
      - "fail-open when the LLM call throws" — stub `router.chat` throws. Expect `allowed: true`, `scanner: "llm"`, `reason: "llm unavailable; allowing"`.
      - "fail-open when the LLM returns unparseable content" — stub returns `"not json"`. Expect `allowed: true`, `scanner: "llm"`.
      - "passes through when scanner disabled" — `config.security.injectionScanner = false`; `createPromptInjectionCop(...)` returns the disabled cop; expect `scanner: "disabled"`, `allowed: true`.
   3. Stub matches the minimum `ModelRouter` surface used by `scanWithModel` (`chat`, plus `getProvider`/`resolveApiKey` only for the parsed-id model-spec path). No import of the real router.

3. **[src/mcp/builtins.test.ts](src/mcp/builtins.test.ts)** (NEW in r2)
   1. In the "blocks fetched content rejected by the prompt-injection cop" test ([src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L215-L226)), change the stub cop's returned `scanner: "heuristic"` to `scanner: "llm"`.
   2. In the "does not write downloaded files rejected by the prompt-injection cop" test ([src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L235-L246)), change the stub cop's returned `scanner: "heuristic"` to `scanner: "llm"`.
   3. The assertion strings `.rejects.toThrow("Prompt injection blocked")` ([src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L231), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L253)) are NOT changed — the prefix stays in `scanUntrustedText`, so the thrown error message is unchanged.

4. **[src/mcp/builtins.ts](src/mcp/builtins.ts)** — no edits. `scanUntrustedText` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L160)) and the three call sites (`downloadUrl` at [src/mcp/builtins.ts](src/mcp/builtins.ts#L211-L222), `fetch_url` at [src/mcp/builtins.ts](src/mcp/builtins.ts#L800-L819), `fetch_page_text` at [src/mcp/builtins.ts](src/mcp/builtins.ts#L832-L851)) keep their current behaviour. The single `"Prompt injection blocked: "` prefix in `scanUntrustedText` is the consistent error contract across all three MCP fetch paths.

## Test strategy

- **Existing coverage that must keep passing.**
  - [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts) is rewritten per step 2.
  - [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) keeps both prompt-injection tests; only the `scanner` literal in the stub return value changes (step 3). The `/Prompt injection blocked/` assertion strings stay byte-identical.
  - No other test file references `scanHeuristically`, `BLOCK_PATTERNS`, `SUSPICIOUS_PATTERNS`, or `scanner: "heuristic"` (verify with `grep -rn 'heuristic' src/ SPEC/v2/skills 2>/dev/null` before merging; expect zero matches in `src/` after the change).
- **No new MCP-level tests required.** The two existing stub-cop tests already exercise the block path for `fetch_url` and `download_file`. The behaviour they assert (throw with `"Prompt injection blocked"`, no file written) is unchanged by Proposal B; only the construction of the fake scan result changes.

### Commands

From repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/security/prompt-injection-cop.test.ts
npx vitest run src/mcp/builtins.test.ts
```

Then full suite:

```bash
npx vitest run
```

## Rollback

Single commit covering [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts), [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts), and [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts). Revert via `git revert <sha>`. No on-disk schema, config, or persisted-data changes. The `scanner` union narrowing IS observable in MCP tool output (`prompt_injection_scan.scanner` on `download_file`, `fetch_url`, `fetch_page_text` responses) — this is the intentional breaking cleanup, removed in the same commit with no compatibility alias per project guidelines.

## Cross-issue ordering

- **Independent of F03** (JSON parser tightening): either order. After F25, `parseModelVerdict` is on the critical path for every scan, so F03's tightening becomes more visible — neither is a prerequisite.
- **Independent of F04** (default model spec): either order.
- **Must land before F29** (PI scan `as any` typing): F29 retypes the consumer of `PromptInjectionScanResult.scanner` against the narrowed union; doing F25 first avoids wasted F29 work.
- **No interaction with the out-of-scope `src/skills/` area.**
