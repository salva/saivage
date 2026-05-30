# G35b — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r3.md](02-design-r3.md)) — move the credential-lexeme list and config-pointer-suffix exemption list from hardcoded module constants in src/security/secrets.ts to operator-overridable fields in the saivage.json config schema (Zod), replacing the previously-disapproved G35 design. The new project-wide principle "avoid hardcoded values; what could live in a config file should live in a config file" mandates the move.

Key shape:
- `src/config.ts` adds a `security.envScrubber` Zod object with `credentialLexemes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([...DEFAULT_CREDENTIAL_LEXEMES])` and `configPointerSuffixes: z.array(z.string().regex(/^_[A-Z][A-Z0-9_]*$/)).default([...DEFAULT_CONFIG_POINTER_SUFFIXES])`. Empty strings rejected per element; replace semantics (no merge with hidden defaults — operator-supplied list wins).
- `src/security/secrets.ts` exports `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES`, and a factory `createSecretEnvNamePredicate({credentialLexemes, configPointerSuffixes})` that compiles each lexeme by escaping metachars, then rewriting `_` to `[_-]`, then wrapping in `(?:^|[_-])${escaped}S?(?:$|[_-])` — preserves G35 r2 hyphen tolerance (matches `SOME_API-KEY` and `ACCESS-KEY`).
- `registerBuiltinServices` rebuilds the predicate once from merged config; `filterShellEnv` captures it (allocation-free spawn path).
- `SECRET_ENV_PATTERNS` and the two-arg `registerBuiltinServices` shape removed in the same commit (no shim).
- Symmetric `allowed_accounts` provider-default fix from G35 carried forward unchanged.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md). All three rounds of blockers resolved: r1 framed the config move; r2 restored hyphen tolerance in the compiler + introduced full-replacement test layers + Zod defaults; r3 added S-R-A / S-R-B schema-layer replacement assertions with explicit `toEqual([])` for empty-suffix replacement, replaced the malformed sentinel grep with shell-safe `rg -F` literals 20a/20b, and spelled out the `mkdtempSync` fixture in F15.

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md). Validation: predicate-layer tests (override + full replacement), schema-layer tests (S-R-A/S-R-B + empty-suffix + per-element empty rejection), integration tests via `loadConfig + registerBuiltinServices + filterShellEnv`, four sentinel grep gates pinning hyphen tolerance, union-rejection, empty-suffix support, and shell-safe pattern literals.

**Supersedes**: G35 (now DISAPPROVED — see [../G35/APPROVED.md](../G35/APPROVED.md)).

**Daemon impact**: Restart `saivage` (10.0.3.111), `saivage-v3` (10.0.3.112), `diedrico` (10.0.3.113) — operator-gated.
