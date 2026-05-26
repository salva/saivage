# G08 — APPROVED

**Chosen proposal**: Proposal B (schema-driven seed; per [02-design-r3.md](02-design-r3.md)) — export `SaivageConfigSchema`, delete the 28-line handwritten runtime-config literal in [src/store/project.ts](../../../../src/store/project.ts#L135-L163), and replace it with `await writeDoc(saivageJsonPath, SaivageConfigSchema.parse({}), SaivageConfigSchema)`. Seed producer and loader validator are the same schema, so drift between emitted seed and accepted config is structurally impossible. Full schema-default serialization (including `telegram.botToken: ""`, public OAuth client IDs, runtime/security/supervisor/mcp defaults) is the intended on-disk seed.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md). All three r2 changes addressed.

**Scope clarifications enforced by r3**:
- `saivage.json` remains operator-owned and sensitive (may carry `apiKey`, `baseUrl`, `authProfile`, `telegram.botToken`); G08 only governs the empty-default seed, not existing operator files. Reset workflows must still preserve `saivage.json`.
- G08 closes the seeded-provider-policy leak only. Unconditional Ollama registration in [src/providers/router.ts](../../../../src/providers/router.ts#L731-L749) and localhost fallbacks in [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L20-L36) / [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L10-L19) are explicitly out of scope and cross-linked to a new G08-followup.

**Test contract**: the snapshot test uses an inline `EXPECTED_SEED` literal committed in the test file (not `SaivageConfigSchema.parse({})` on both sides), so future schema-default edits force a deliberate snapshot update.

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md). Required validation: local `tmp/g08-seedcheck` `node dist/cli.js init` + `loadConfig(true, seedRoot)`.

**Daemon impact**: Operator-gated. Live harness restart on `saivage-v3` (10.0.3.112) optional only; `saivage` (10.0.3.111) and `diedrico` (10.0.3.113) untouched.
