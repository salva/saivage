# G08 - Review r1

**Reviewed**: [01-analysis-r1.md](./01-analysis-r1.md), [02-design-r1.md](./02-design-r1.md), [03-plan-r1.md](./03-plan-r1.md)
**Verdict**: CHANGES_REQUESTED
**Required change count**: 4

## Required changes

1. **Replace the weak schema round-trip test with a raw on-disk default contract.** The plan's new `readDoc(..., SaivageConfigSchema)` test ([03-plan-r1.md](./03-plan-r1.md#L25-L31)) is too close to a tautology: `readDoc` parses through the schema ([src/store/documents.ts](../../../../src/store/documents.ts#L18-L22)), while `writeDoc` also parses through the same schema before serializing ([src/store/documents.ts](../../../../src/store/documents.ts#L64-L82)). It also will not catch unknown keys because Zod strips them by default, which is one of the analysis concerns ([01-analysis-r1.md](./01-analysis-r1.md#L52-L55)). Add a test that reads the raw JSON file and compares it directly to `SaivageConfigSchema.parse({})`; then assert the old seeded policy is absent from the raw file: no `mcpServers.playwright`, no `providers.ollama`, no `providers.llamacpp`, and empty raw `providers` / `mcpServers`. Keep the `readDoc` parse as a secondary sanity check if useful, but do not make it the main regression guard.

2. **Broaden the stale-assumption audit beyond Playwright.** Proposal B deletes both the hardcoded MCP server and the hardcoded provider entries ([02-design-r1.md](./02-design-r1.md#L54-L58), [02-design-r1.md](./02-design-r1.md#L74-L78)), but the plan only searches for `playwright` ([03-plan-r1.md](./03-plan-r1.md#L33)). Add an explicit audit for provider-entry assumptions too: `providers.anthropic`, `providers.openai`, `providers.ollama`, `providers.llamacpp`, `config.providers.<name>`, and any tests that infer provider availability from a freshly seeded project. If a consumer assumes these records exist, fix the consumer or its test to handle the schema default `{}`; do not add a compatibility seed or fallback literal.

3. **State that full-default serialization is intentional, and cover the newly materialized fields.** B changes more than the old literal's provider/MCP policy: because `SaivageConfigSchema.parse({})` is written through `writeDoc`, fresh `saivage.json` files will now explicitly contain schema defaults that used to exist only after `loadConfig`, including `runtime`, `security`, `supervisor`, `telegram`, `mcp`, and `oauth` ([src/config.ts](../../../../src/config.ts#L89-L190)). That can be the right architecture, but the design currently calls only a subset of values "the values that matter" ([02-design-r1.md](./02-design-r1.md#L56-L58)). Update the design/plan to say that the full expanded schema default is the desired on-disk seed, including empty `telegram.botToken` and public OAuth client IDs, and add the raw-default equality test from change 1 so future schema-default edits are reviewed deliberately.

4. **Fix the validation target: prove the new seed, not an existing old project.** Restarting `saivage-v3` and checking `/health` ([03-plan-r1.md](./03-plan-r1.md#L46-L53)) mostly proves that an existing `.saivage/saivage.json` still loads; it does not exercise the new `seedProject` producer. It also touches a long-running harness for a producer-path change. Make the required validation local and seed-focused: after build, run the actual current init command ([src/server/cli.ts](../../../../src/server/cli.ts#L29-L45)) in `tmp/g08-seedcheck`, read the raw `.saivage/saivage.json`, compare it to `SaivageConfigSchema.parse({})`, and call `loadConfig(true, seedRoot)` against that seeded root. Keep the live `saivage-v3` restart only as an optional operator-approved smoke check, or remove it from this finding's required validation.

## Design A vs B

B is the right design after the required revisions. A would close the immediate write-path schema bypass at [src/store/project.ts](../../../../src/store/project.ts#L135-L164), but it keeps a second source of runtime defaults in the seeder and preserves the policy leaks that the finding is trying to remove. B makes [src/config.ts](../../../../src/config.ts#L62-L192) the only default source and aligns the producer with `loadConfig`'s parser at [src/config.ts](../../../../src/config.ts#L268-L276). That is the architecture-first choice.

The important implementation boundary is that B must be schema-driven all the way down: no helper that recreates the old literal, no special seed for provider names, and no default Playwright entry hiding in a different file.

## Completeness

The analysis is solid and correctly identifies the raw write, the private schema export problem, and the policy leakage. The design is also mostly complete, but it should be clearer that the new seed intentionally expands the on-disk file to the full schema default, not just the old literal minus Playwright/providers. The plan should also audit provider consumers as first-class fallout from B, not only MCP consumers.

## Testability

The test plan needs one stronger contract: raw seeded JSON must equal the schema default. That single assertion catches the old hand-written literal, unknown extra keys, future accidental reintroduction of provider/MCP policy, and changes to default materialization. Keep the existing notification/orchestrator tests in [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91), add explicit empty-provider and empty-MCP assertions, and add the raw equality assertion against `SaivageConfigSchema.parse({})`.

VERDICT: CHANGES_REQUESTED