# F25 Design r1 — prompt-injection cop regex blocklist guarantees false positives

## Proposal A — Focused: regex set becomes a routing signal, only LLM may block

**Scope.** [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts), [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts).

**What changes.**

1. Delete `SUSPICIOUS_PATTERNS` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L40-L49)) and `shouldAskModel` ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L178-L180)). They duplicate `BLOCK_PATTERNS` as a "should I bother asking the model" filter; once the model is the only thing that can block, that filter is obsolete.
2. Keep `BLOCK_PATTERNS` (rename to `SUSPICIOUS_PATTERNS`) but make `scanHeuristically` return a `suspicious: boolean` instead of an `allowed: false` verdict. The heuristic never blocks.
3. In `scan()`: when the scanner is enabled and content is non-empty, ALWAYS run the LLM. The heuristic signal is only used to log "regex pre-flagged this content" alongside the LLM verdict (added to the `reason` string or as an optional `heuristic_signal` field on `PromptInjectionScanResult`).
4. If the LLM scan is unavailable (provider missing, model errors, JSON unparseable, etc.) the cop returns `allowed: true` with `scanner: "llm"` and a `reason` like `"llm unavailable; allowing"`. This is the same fail-open behaviour the model path already has ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L96-L148)); the change is that the regex no longer fails closed.

**Removed.** The regex-as-blocker path. The `scanner: "heuristic"` enum variant (it is no longer reachable; remove from the union).

**Risk.** Low. The LLM cop's own system prompt is already the canonical policy. Removing the regex pre-block aligns the implementation with that policy. The one new behaviour worth noting: every fetched, text-shaped payload now incurs one LLM call. The current implementation only did so when `SUSPICIOUS_PATTERNS` matched, which was probably under-firing because the heuristic block path stole the cases that mattered. This is the correct cost: scanning is the cop's job.

**What it enables.** A clean handoff to F03 (the LLM verdict parser tightening), F04 (default model spec), and F29 (PI scan typed properly). The cop becomes "the LLM does the work, period".

**What it forbids.** Reintroducing pattern-based blocking. Future tightening must go via the LLM prompt or a structured taxonomy returned by the model, not a regex bolt-on.

**Recommendation note.** This is the minimum change that fixes the bug. It does not touch the silent-failure problem at the MCP layer (separate concern, addressable via F03 cleanup of the result schema or a sibling proposal).

## Proposal B — Level up: regex deleted entirely, cop is "LLM or nothing"

**Scope.** [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts), [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts), [src/mcp/builtins.ts](src/mcp/builtins.ts) (caller error path tightened).

**What changes.**

1. Delete `BLOCK_PATTERNS`, `SUSPICIOUS_PATTERNS`, `scanHeuristically`, `shouldAskModel` (all of [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L28-L49), [#L156-L180](src/security/prompt-injection-cop.ts#L156-L180)).
2. `scan()` becomes: if scanner disabled → `allow`. Otherwise call the LLM. If the LLM call fails (no provider, JSON unparseable, model error) → `allow` with `scanner: "llm"`, `reason: "llm unavailable; allowing"`, `confidence: 0`. This is intentional fail-open: a security layer whose failure mode is "block everything" is worse than no security layer, given the silent-failure issue.
3. Narrow `PromptInjectionScanResult.scanner` union to `"llm" | "disabled" | "skipped"`. Remove `"heuristic"`.
4. In `downloadUrl()` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L211-L222)) keep the existing throw/catch flow but ensure the cop's blocking reason is recorded in `attempt.error` with the prefix `"prompt-injection cop blocked: "` so it is greppable in logs and distinct from network errors. This is one-line cosmetic but worth doing in the same commit.

**Removed.** All regex-based prompt-injection detection. The `heuristic` enum value. The `scanHeuristically` export and its test.

**Risk.** Low-to-medium. Same cost story as Proposal A (one LLM call per text fetch). One additional behavioural change: if the configured model is unavailable, the cop now fails open instead of being a no-op detector (it was already a no-op detector in the "model never gets called" branch, so this is mostly making the existing implicit behaviour explicit). The user can still disable the cop via `config.security.injectionScanner = false`.

**What it enables.** F03 simplification (the JSON parser is the only verdict source). F04 (the default model spec is the only model spec — no regex floor). F29 typing cleanup. This proposal also makes the cop honest about what it is: an LLM-backed safety check, not a multilayer defense. Multilayer defense via shoddy regex is worse than no defense.

**What it forbids.** Adding any string-pattern shortcut to the cop. Future detection improvements must go through the LLM (prompt engineering, structured output, or a different model class entirely).

**Recommendation note.** This is the principled clean-slate fix. The level-up vs Proposal A is removing dead weight (the `heuristic` enum variant and its test), and tightening one error-message contract at the call site so blocks are not silently indistinguishable from 404s.

## Recommendation

**Proposal B.** It is the architecturally correct version of Proposal A: once the regex cannot block, keeping it as a "routing hint" is dead code (the LLM is always called anyway, so the hint changes nothing observable). Project guidelines forbid keeping abstractions used only once or only for transition. Proposal B deletes them.

Cross-issue ordering:

- Independent of F03 (JSON parser tightening). F03 can land before or after.
- Independent of F04 (default model spec). F04 can land before or after.
- Independent of F29 (PI scan `as any`). After F25, the union type is narrower, which makes F29's typing job easier; F29 should land after F25.
