# F25 Design r2 — prompt-injection cop regex blocklist guarantees false positives

## Changes from r1

- Acknowledge that `PromptInjectionScanResult.scanner` is part of the MCP tool output payload (`prompt_injection_scan` field on `download_file`, `fetch_url`, `fetch_page_text` responses in [src/mcp/builtins.ts](src/mcp/builtins.ts#L121), [src/mcp/builtins.ts](src/mcp/builtins.ts#L235), [src/mcp/builtins.ts](src/mcp/builtins.ts#L819), [src/mcp/builtins.ts](src/mcp/builtins.ts#L851)). Narrowing the union from `"heuristic" | "llm" | "disabled" | "skipped"` to `"llm" | "disabled" | "skipped"` is therefore a visible, intentional breaking change to the MCP response shape, not an internal-only cleanup. Per project rules this is fine — the old enum variant is removed in the same commit, no shim — but it must be named honestly in the design.
- Add [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) to Proposal B's scope. Two existing tests construct `PromptInjectionCop` stubs whose `scan()` returns `scanner: "heuristic"` ([src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L215-L226), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L235-L246)); after the union is narrowed, those literals are no longer assignable and the tests must be updated.
- Replace the r1 two-prefix scheme with a single-prefix scheme: the `"Prompt injection blocked: "` prefix stays in `scanUntrustedText` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L160)); none of the three call sites (`downloadUrl`, `fetch_url`, `fetch_page_text`) add a second prefix. r1's plan to add a second `"prompt-injection cop blocked: "` prefix only at the `downloadUrl` catch site is dropped: it would have made the three MCP fetch paths inconsistent (only `download_file` would get the double prefix; `fetch_url` and `fetch_page_text` would still surface the bare `scanUntrustedText` message). The error string is already greppable via the single prefix already produced inside `scanUntrustedText`.

Proposal A is unchanged. Proposal B is updated as above. Recommendation is still Proposal B.

## Proposal A — Focused: regex set becomes a routing signal, only LLM may block

(Unchanged from r1. Repeated here only for self-containment of the r2 design doc.)

**Scope.** [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts), [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts).

**What changes.**

1. Delete `SUSPICIOUS_PATTERNS` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L40-L49)) and `shouldAskModel` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L178-L180)).
2. Keep `BLOCK_PATTERNS` but make `scanHeuristically` return a `suspicious: boolean` hint instead of an `allowed: false` verdict.
3. In `scan()`: when the scanner is enabled and content is non-empty, ALWAYS run the LLM. The heuristic signal is only used to enrich the `reason` string.
4. If the LLM scan is unavailable the cop returns `allowed: true` with `scanner: "llm"` and a fail-open reason.

**Removed.** The regex-as-blocker path. The `"heuristic"` enum variant (since it can never be reached).

**Risk.** Low. Every text fetch incurs one LLM call (vs. r1's gated heuristic).

**What it enables.** Same as Proposal B for F03/F04/F29.

**What it forbids.** Reintroducing pattern-based blocking.

**Recommendation note.** Minimum-change variant; keeps `scanHeuristically` as an internal hint but doesn't simplify the file. Proposal B removes more dead weight.

## Proposal B — Level up: regex deleted entirely, cop is "LLM or nothing"

**Scope.** [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts), [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts).

(Note: [src/mcp/builtins.ts](src/mcp/builtins.ts) is **not** modified by Proposal B. The single-prefix decision means the three fetch catch sites and `scanUntrustedText` stay byte-for-byte as they are today. Only the cop module, its test, and the MCP test file change.)

**What changes.**

1. Delete `BLOCK_PATTERNS` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L28-L38)), `SUSPICIOUS_PATTERNS` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L40-L49)), `scanHeuristically` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L156-L176)), `shouldAskModel` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L178-L180)).
2. Rewrite `DefaultPromptInjectionCop.scan()` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L82-L94)): if scanner disabled → `allow`. Otherwise call `scanWithModel`. If `scanWithModel` returns `null` → fail-open `allow` with `scanner: "llm"`, `reason: "llm unavailable; allowing"`, `confidence: 0`. The fail-open choice is intentional: a security layer whose failure mode is "block everything" produces the same silent-failure cascade as the regex did.
3. Narrow `PromptInjectionScanResult.scanner` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L13-L20)) to `"llm" | "disabled" | "skipped"`. Remove `"heuristic"`.
4. Update existing tests that produce `scanner: "heuristic"` literals:
   - [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts) — rewritten entirely to test the LLM path against a stub `ModelRouter`.
   - [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L215-L226) and [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L235-L246) — change the stub-cop literals from `scanner: "heuristic"` to `scanner: "llm"`. The test intent ("a blocking cop causes the fetch to throw and prevents writes") is unchanged; only the enum value used to construct the fake `PromptInjectionScanResult` shifts.
5. The `"Prompt injection blocked: "` prefix stays in `scanUntrustedText` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L160)) as the single source of the error string. The three MCP fetch handlers continue to surface `err.message` verbatim. The MCP-level test assertions that match `/Prompt injection blocked/` ([src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L231), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L253)) keep working unchanged.

**Removed.** All regex-based detection. The `"heuristic"` `scanner` enum value (visible in MCP tool output payloads). `scanHeuristically`.

**Visible API impact (intentional, no shim).** The `prompt_injection_scan.scanner` field returned by `download_file`, `fetch_url`, and `fetch_page_text` will never again be the string `"heuristic"`. Any external consumer that branched on that string will need to treat it as `"llm"`. Per project guidelines this is removed in the same commit without a transitional alias.

**Risk.** Low-to-medium. One LLM call per text-shaped fetch (vs. today, where most text fetches with no `SUSPICIOUS_PATTERNS` match skip the LLM). One observable response-shape change (`scanner` enum). User can still disable the cop via `config.security.injectionScanner = false`.

**What it enables.** F03 simplification (the JSON parser becomes the only verdict source). F04 (single model spec, no regex floor). F29 typing cleanup against the narrower union.

**What it forbids.** Adding any string-pattern shortcut to the cop. Future detection improvements must go through the LLM.

**Recommendation note.** This is the architecturally correct clean-slate fix. Single-prefix error contract means the three MCP fetch paths surface blocks identically; no inconsistent catch-site formatting.

## Recommendation

**Proposal B.** Once the regex cannot block, keeping it as a routing hint is dead code — project guidelines forbid keeping abstractions used only for transition. The r2 update reaffirms B but corrects scope (MCP tests are in) and the error-prefix strategy (one prefix in `scanUntrustedText`, no second prefix at any call site).

Cross-issue ordering:

- Independent of F03 (JSON parser tightening): land in either order.
- Independent of F04 (default model spec): land in either order.
- Must land before F29 (PI scan `as any` typing): F29 retypes the consumer of `PromptInjectionScanResult.scanner`; F25 narrows the union first.
