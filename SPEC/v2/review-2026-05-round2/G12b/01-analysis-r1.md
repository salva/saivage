# G12b — Analysis (Round 1)

**Status:** REDO of G12. The previously-approved G12 ([G12/APPROVED.md](../G12/APPROVED.md))
hardened the LLM-based prompt-injection cop and added DebugView visibility
for its degraded path. Under the new project-wide principle
("no fragile heuristics like checking whether some agent has called some
tool or not — treat agents as adults"), the cop itself is the antipattern
and must be removed.

**Companion docs:** [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md).

## 1. Restatement of the original concern (G12)

[G12-prompt-injection-cop-fail-open-silent.md](../G12-prompt-injection-cop-fail-open-silent.md)
flagged that the LLM prompt-injection scanner at
[src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L63-L75)
returns `{ allowed: true }` on every internal error path with no event-bus
publish, no counter, and no log marker. Operators cannot tell a healthy
scan from a silently-failed one. G12's R4 design proposed:

- a structured degraded result + per-cause taxonomy
  ([G12/02-design-r4.md](../G12/02-design-r4.md));
- a new SecurityStatusRing + GET `/api/debug/security` route + DebugView
  Security tab ([G12/03-plan-r4.md](../G12/03-plan-r4.md));
- a fail-closed semantics flip at the MCP boundary for data tools.

That direction is now disapproved.

## 2. Why the cop must be deleted, not hardened

The cop is the textbook case the new principle prohibits:

1. **It is an LLM heuristic over untrusted input.** The classifier prompt
   itself ([src/security/prompt-injection-cop.ts L99-L115](../../../../src/security/prompt-injection-cop.ts#L99-L115))
   is shipped to a chat model alongside attacker-controlled bytes from
   `fetch_url`, `fetch_page_text`, and `download_file`. The verdict is
   parsed with [parseLlmJsonAs](../../../../src/parse-llm-json.ts) and
   coerced into a boolean gate.
2. **It is a fragile agent-tool-call heuristic about another agent's
   output.** It branches downstream behaviour ("did the security agent
   say allow?") on a probabilistic verdict and routes through a
   second-class model role (`security`). The new principle is exactly
   "no fragile heuristics like checking whether some agent has called
   some tool or not."
3. **Hardening it (the R4 design) makes the bad pattern more permanent.**
   R4 adds a five-cause failure taxonomy, a redaction helper full of
   regexes ([G12/02-design-r4.md §"Redaction rules"](../G12/02-design-r4.md)),
   a ring buffer, a Vue tab — all infrastructure that exists only to keep
   the heuristic alive. Project rule
   ([WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md) →
   "architecture-first, no backward compatibility") says: remove
   obsolete code, do not migrate it.
4. **It violates two more of the new principles.** The R4 redaction
   helper is a regex-based parser of error messages ("no regex for
   parsing user intent" — applies to error text too once it is rendered
   to the operator), and several knobs
   ([src/config.ts L111-L117](../../../../src/config.ts#L111-L117):
   `injectionScanner`, `injectionModel`, `maxScanLengthBytes`) are
   default-baked rather than driven by deployment policy ("avoid
   hardcoded values; prefer config" — kept satisfied here trivially by
   not having the knobs at all).

## 3. What "treat agents as adults" implies for the data boundary

The user directive carved out a non-heuristic carve-out: pure data-tool
boundary protections are still acceptable. The deletion does **not**
remove:

- URL scheme enforcement: only `http:` / `https:` accepted by
  [parseHttpUrl at src/mcp/builtins.ts L73-L79](../../../../src/mcp/builtins.ts#L73-L79).
  This is a structural check on the request, not a classifier on the
  response.
- Hard truncation: `MAX_FETCH_CHARS` for `fetch_url` /
  `fetch_page_text` ([src/mcp/builtins.ts L43](../../../../src/mcp/builtins.ts#L43))
  and `max_bytes` for `download_file` / `download_with_fallbacks`
  ([src/mcp/builtins.ts L44](../../../../src/mcp/builtins.ts#L44),
  [L825](../../../../src/mcp/builtins.ts#L825),
  [L848](../../../../src/mcp/builtins.ts#L848)). These are config-driven
  (mcpConfig.maxFetchChars, mcpConfig.maxDownloadBytes) and apply
  uniformly without inspecting content semantics.
- `assertInside` project-root containment for download paths
  ([src/mcp/builtins.ts L50-L58](../../../../src/mcp/builtins.ts#L50-L58)).
- Shell-env secret scrubbing
  ([src/mcp/builtins.ts L370-L388](../../../../src/mcp/builtins.ts#L370-L388))
  — orthogonal to the cop, stays.

What goes away is the LLM classifier and every branch that depends on
its verdict.

## 4. Live code surface to remove

Verified line numbers (2026-05-26 working tree):

### 4.1 The cop itself

- [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts) — entire file (134 lines).
  Exports: `PromptInjectionScanRequest`, `PromptInjectionScanResult`,
  `PromptInjectionCop`, `createPromptInjectionCop`, `disabledCop`,
  `DefaultPromptInjectionCop`.
- [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) — entire file.

### 4.2 MCP wiring

- [src/mcp/builtins.ts L32-L33](../../../../src/mcp/builtins.ts#L32-L33) —
  `import type { PromptInjectionCop, PromptInjectionScanResult } …; import { disabledCop } …`.
- [src/mcp/builtins.ts L44](../../../../src/mcp/builtins.ts#L44) —
  `const MAX_SCAN_DECODE_BYTES = 1_000_000;` (only consumed by the cop pipeline).
- [src/mcp/builtins.ts L116-L122](../../../../src/mcp/builtins.ts#L116-L122) —
  `prompt_injection_scan?: PromptInjectionScanResult;` field on
  `DownloadSuccess`.
- [src/mcp/builtins.ts L124-L126](../../../../src/mcp/builtins.ts#L124-L126) —
  `BuiltinServicesOptions.promptInjectionCop?: PromptInjectionCop`.
- [src/mcp/builtins.ts L128-L131](../../../../src/mcp/builtins.ts#L128-L131) —
  `isTextLikeContentType` (regex over content-type, only used by the
  cop pipeline).
- [src/mcp/builtins.ts L133-L142](../../../../src/mcp/builtins.ts#L133-L142) —
  `looksTextLike` (heuristic over byte distribution, only used by the
  cop pipeline).
- [src/mcp/builtins.ts L144-L147](../../../../src/mcp/builtins.ts#L144-L147) —
  `bufferToScannableText` (only used to decide if the cop should run).
- [src/mcp/builtins.ts L149-L160](../../../../src/mcp/builtins.ts#L149-L160) —
  `scanUntrustedText` (the gate function the original issue cited).
- [src/mcp/builtins.ts L167-L172](../../../../src/mcp/builtins.ts#L167-L172) —
  `promptInjectionCop: PromptInjectionCop` field on `downloadUrl`
  options.
- [src/mcp/builtins.ts L204-L223](../../../../src/mcp/builtins.ts#L204-L223) —
  `bufferToScannableText` + `scanUntrustedText` block inside
  `downloadUrl` plus the `prompt_injection_scan` payload assembly.
- [src/mcp/builtins.ts L734](../../../../src/mcp/builtins.ts#L734) —
  `createDataHandler(promptInjectionCop: PromptInjectionCop)` signature.
- [src/mcp/builtins.ts L768-L790](../../../../src/mcp/builtins.ts#L768-L790) —
  `fetch_url` cop call + `prompt_injection_scan` payload.
- [src/mcp/builtins.ts L800-L822](../../../../src/mcp/builtins.ts#L800-L822) —
  `fetch_page_text` cop call + `prompt_injection_scan` payload.
- [src/mcp/builtins.ts L824-L843](../../../../src/mcp/builtins.ts#L824-L843) —
  `download_file` passes `promptInjectionCop` into `downloadUrl`.
- [src/mcp/builtins.ts L866](../../../../src/mcp/builtins.ts#L866) —
  `download_with_fallbacks` passes `promptInjectionCop` into
  `downloadUrl`.
- [src/mcp/builtins.ts L1076](../../../../src/mcp/builtins.ts#L1076) —
  `const promptInjectionCop = options.promptInjectionCop ?? disabledCop();`
  in `registerBuiltinServices`.
- [src/mcp/builtins.ts L1109](../../../../src/mcp/builtins.ts#L1109) —
  `createDataHandler(promptInjectionCop)` call site.

### 4.3 Bootstrap wiring

- [src/server/bootstrap.ts L13](../../../../src/server/bootstrap.ts#L13) —
  `import { createPromptInjectionCop } …`.
- [src/server/bootstrap.ts L133](../../../../src/server/bootstrap.ts#L133) —
  `securityModel: config.security.injectionModel,` passed to
  `ModelRoutingResolver`.
- [src/server/bootstrap.ts L145-L151](../../../../src/server/bootstrap.ts#L145-L151) —
  `registerBuiltinServices(..., { promptInjectionCop: createPromptInjectionCop(...) })`.

### 4.4 Config schema

- [src/config.ts L111-L117](../../../../src/config.ts#L111-L117) — the
  whole `security` object: `injectionScanner`, `injectionModel`,
  `maxScanLengthBytes`.

### 4.5 Boot validation

- [src/config-validation.ts L61-L66](../../../../src/config-validation.ts#L61-L66) —
  the `if (config.security.injectionScanner) routing.resolve("security")`
  block in `validateModelCoverage`.

### 4.6 Routing

- [src/routing/resolver.ts L9](../../../../src/routing/resolver.ts#L9) —
  `security: "security"` entry in `ROUTING_ROLE_TO_MODEL_KEY`.
- [src/routing/resolver.ts L63](../../../../src/routing/resolver.ts#L63) —
  `securityModel?: string;` on `RuntimeRoutingConfigLike`.
- [src/routing/resolver.ts L249](../../../../src/routing/resolver.ts#L249) —
  `if (role === "security") return normalizeModelList(this.runtime.securityModel);`.

### 4.7 Tests

- [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) — entire file.
- [src/mcp/builtins.test.ts L10](../../../../src/mcp/builtins.test.ts#L10) —
  `import type { PromptInjectionCop } …`.
- [src/mcp/builtins.test.ts L220-L261](../../../../src/mcp/builtins.test.ts#L220-L261) —
  the two `"blocks fetched content rejected by the prompt-injection
  cop"` / `"does not write downloaded files …"` cases.
- [src/config-validation.test.ts L23](../../../../src/config-validation.test.ts#L23) —
  `security: { injectionScanner: true, maxScanLengthBytes: 100_000 }` in
  `makeConfig`.
- [src/config-validation.test.ts L36-L139](../../../../src/config-validation.test.ts#L36-L139) —
  all six tests that drive `security.injectionScanner` /
  `security.injectionModel`.
- [src/routing/resolver.test.ts L102-L120](../../../../src/routing/resolver.test.ts#L102-L120) —
  the `"uses shared runtime defaults for supervisor and security roles"`
  case (security half).

### 4.8 Docs

- [docs/internals/security.md](../../../../docs/internals/security.md) —
  entire file (60 lines), documents the cop.
- [docs/internals/architecture.md L99](../../../../docs/internals/architecture.md#L99) —
  the `| Security | src/security/prompt-injection-cop.ts | Optional
  content scanner. |` row in the subsystems table.
- `docs/api/**` — regenerated from source by typedoc; no manual edit
  needed but the regen must happen post-removal.

### 4.9 Confirmed absent

None of the R4 G12 deliverables (`SecurityStatusRing`,
`/api/debug/security`, `DebugView` Security tab, `SystemEvent` cop
events, `securityStatusRing` on `SaivageRuntime`) is present in the live
tree — G12 was approved but never landed. Verified by
`grep -rn 'SecurityStatusRing\|/api/debug/security\|securityStatusRing'
saivage/src saivage/web` → no matches. The plan therefore only deletes
the legacy cop surface; there is no "rollback" axis to chase.

## 5. Risks and mitigations

- **R1 — Reviewer concern that removing the cop weakens defence in
  depth.** Mitigation: the data boundary keeps its non-heuristic
  protections (URL scheme, size caps, project-root containment). Worker
  prompts already (and continue to) instruct agents to treat fetched
  content as data, not instructions — same posture the cop's "fail open"
  path already had in production. The deletion changes the **observable
  contract** of `fetch_url` / `fetch_page_text` / `download_file` /
  `download_with_fallbacks` only by removing the `prompt_injection_scan`
  field from the result payload; no tool starts to permit something it
  used to refuse for structural reasons.
- **R2 — Cascading config breakage in operator-edited
  `.saivage/saivage.json` that sets `security.injectionScanner`.**
  Project rule says no migration shims. Zod will simply reject unknown
  keys → operators must remove the block. Mitigation: the boot error
  message (`MissingModelForRoleError` / zod parse error) is enough; we
  do not add a deprecation warning.
- **R3 — Loss of the `security` model role.** The role only ever fed
  this cop. Removing it from `ROUTING_ROLE_TO_MODEL_KEY` and from
  `RuntimeRoutingConfigLike` is in-line with "remove code supporting
  old features rather than keeping migration shims."
- **R4 — `docs/api/**` typedoc output still references the dropped
  shape until regen.** Regenerating the API docs is a single command
  (`pnpm docs:api` / equivalent — confirmed by repo convention); the
  plan adds it to the validation list. Not a runtime risk.

## 6. Pin points for the design and plan rounds

1. The data tools must keep returning a stable, documented shape; the
   only field that disappears is `prompt_injection_scan`. Do not
   replace it with a new "untrusted: true" boolean — that would just be
   another lightly-typed heuristic surface.
2. Config-driven knobs we keep (`mcpConfig.maxFetchChars`,
   `mcpConfig.maxDownloadBytes`) honour the "prefer config" principle;
   no new hardcoded scan caps are introduced.
3. Tests must positively assert (a) no cop call path exists, (b) no
   `security` routing role, (c) zod rejects `security.injectionScanner`
   as unknown, (d) builtin data tools still execute end-to-end against
   a stub HTTP server with no cop installed.
