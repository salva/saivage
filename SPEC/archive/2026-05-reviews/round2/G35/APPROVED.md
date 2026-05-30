# G35 — DISAPPROVED (superseded by G35b)

**Status**: DISAPPROVED on user directive (2026-05-26). The user added the project-wide principle "avoid hardcoded values as much as possible; what could live in a config file should live in a config file". The approved design encoded the credential lexeme set, force-prefix list (later removed), and config-pointer suffix exemptions as hardcoded module constants in src/security/secrets.ts; per the new principle those lists must live in the config file. See [../G35b/](../G35b/) for the redo.

The original record follows for reference only.

---

# G35 — APPROVED (superseded)

**Chosen proposal**: Proposal A (per [02-design-r2.md](02-design-r2.md)) — replace the four unanchored substring patterns in `SECRET_ENV_PATTERNS` with a single exported `isSecretEnvName(name)` predicate co-located in a new [src/security/secrets.ts](../../../../src/security/secrets.ts). The predicate is two layers only: a word-anchored credential lexeme check against a small set of tokens (e.g. `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `API_KEY`, `APIKEY`, `TOKEN`, `ACCESS_KEY`, `PRIVATE_KEY`) plus an `ENV_CONFIG_POINTER_SUFFIXES` exemption covering `_URL`, `_URI`, `_ENDPOINT`, `_PATH`, `_DIR`, `_FILE`, `_PROMPT`, `_TEMPLATE`. The previous force-prefix layer (e.g. `ANTHROPIC_*`, `OPENAI_*`) is deleted because it defeated the config-pointer exemption; the audit table in r2 design proves every real provider credential still classifies via the lexeme layer. The original `SECRET_ENV_PATTERNS` regex array is deleted in full. Proposal B (runtime-configurable list + value-entropy heuristic) is rejected as over-engineered and as colliding with the G31/G32/G33/G34 mcp config-block negotiation.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md). Adds [src/security/secrets.ts](../../../../src/security/secrets.ts) and [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts) with full FP corpus (`PASSWORD_PROMPT`, `RESET_PASSWORD_URL`, `MY_SECRETARY`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GITHUB_API_BASE_URL`, `GITHUB_API_BASE_URL_TEMPLATE`) and FN corpus (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `SLACK_TOKEN`, `AWS_ACCESS_KEY_ID`); edits [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) to delete `SECRET_ENV_PATTERNS` and call the predicate. Static gates: `grep -c SECRET_ENV_PATTERNS src/mcp/builtins.ts == 0` and `grep -c isSecretEnvName src/mcp/builtins.ts >= 2`.

**Sequencing**: Orthogonal to G30; disjoint same-file edits with G31/G32/G33/G34 in the L400-L432 env-filter region. No mcp config-block changes.

**Daemon impact**: Variables that look like credentials but are config pointers (e.g. `RESET_PASSWORD_URL`, `OPENAI_BASE_URL`) are no longer redacted, removing operational pain for legitimate env-var observability. Real credentials remain redacted. Any saivage-v3 restart remains operator-gated.
