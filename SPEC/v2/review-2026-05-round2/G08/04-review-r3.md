# G08 - Review r3

**Reviewed**: [SPEC/v2/review-2026-05-round2/G08/01-analysis-r3.md](./01-analysis-r3.md), [SPEC/v2/review-2026-05-round2/G08/02-design-r3.md](./02-design-r3.md), [SPEC/v2/review-2026-05-round2/G08/03-plan-r3.md](./03-plan-r3.md)

## Summary

Round 3 addresses the three r2 blockers and keeps the right architectural direction: Proposal B, schema-driven seeding, with no compatibility seed or migration branch. The plan now removes the handwritten runtime-config literal in [src/store/project.ts#L136-L162](../../../../src/store/project.ts#L136-L162), routes the new saivage.json write through the same validated write path used for config.json in [src/store/project.ts#L133](../../../../src/store/project.ts#L133), and exports the runtime schema currently private in [src/config.ts#L62](../../../../src/config.ts#L62) for use by the seeder and tests.

I found no blocking correctness, architecture, or project-rule issues in r3.

## R2 Required Change Coverage

1. **Secret-handling claim corrected.** R3 now accurately distinguishes fresh schema defaults from operator-owned saivage.json files. The schema permits provider apiKey, baseUrl, and authProfile at the account level in [src/config.ts#L14-L17](../../../../src/config.ts#L14-L17), carries those fields into provider config via [src/config.ts#L31-L36](../../../../src/config.ts#L31-L36), stores providers under the runtime config in [src/config.ts#L76](../../../../src/config.ts#L76), and allows telegram.botToken directly in [src/config.ts#L129-L132](../../../../src/config.ts#L129-L132). R3's guidance to preserve the existing operational rule for sensitive saivage.json files is correct, and removing the r2 memory-note relaxation closes the security-sensitive review objection.

2. **Provider-default scope corrected.** R3 no longer claims G08 removes all provider availability or localhost policy. It correctly narrows the fix to the persisted seed literal in [src/store/project.ts#L136-L162](../../../../src/store/project.ts#L136-L162), while acknowledging that the router still registers Ollama unconditionally in [src/providers/router.ts#L749](../../../../src/providers/router.ts#L749), constructs it with an unset base URL in [src/providers/router.ts#L804](../../../../src/providers/router.ts#L804), and relies on provider-class localhost fallbacks in [src/providers/ollama.ts#L20-L36](../../../../src/providers/ollama.ts#L20-L36) and [src/providers/llamacpp.ts#L19](../../../../src/providers/llamacpp.ts#L19). The external surfaces are also correctly identified: [src/server/server.ts#L219-L226](../../../../src/server/server.ts#L219-L226), [src/server/cli.ts#L291-L296](../../../../src/server/cli.ts#L291-L296), and [src/server/bootstrap.ts#L141](../../../../src/server/bootstrap.ts#L141). Filing that router/provider behavior as a follow-up is acceptable for G08 because this finding is specifically the seedProject schema bypass.

3. **Raw-default test contract corrected.** R3 replaces the r2 dynamic comparison with a committed EXPECTED_SEED literal asserted against both the raw seed output and SaivageConfigSchema.parse({}). That now matches the stated review-on-change contract: writeDoc validates before writing in [src/store/documents.ts#L75-L82](../../../../src/store/documents.ts#L75-L82), readDoc validates on read in [src/store/documents.ts#L20-L23](../../../../src/store/documents.ts#L20-L23), and the literal assertion means edits to default chains in [src/config.ts#L62-L192](../../../../src/config.ts#L62-L192) will fail tests until the expected tree is intentionally updated. The named assertions for empty providers and mcpServers also directly cover the original policy-leak regressions.

## Source Verification

- The proposed schema export is mechanically sound: the private configSchema is declared in [src/config.ts#L62](../../../../src/config.ts#L62), the inferred type currently references it in [src/config.ts#L194](../../../../src/config.ts#L194), and loadConfig parses through it in [src/config.ts#L274](../../../../src/config.ts#L274).
- The old seed literal is the only producer of the hardcoded provider placeholders and Playwright mcp server in seedProject: [src/store/project.ts#L136-L162](../../../../src/store/project.ts#L136-L162).
- Existing project tests only assert loaded default behavior around notifications and the missing orchestrator model in [src/store/project.test.ts#L77-L91](../../../../src/store/project.test.ts#L77-L91), so adding raw-file tests is the right regression surface.
- The producer-side audit scope is right: config.providers is stored as an arbitrary record in [src/providers/router.ts#L93](../../../../src/providers/router.ts#L93), and the known config fixture in [src/config.test.ts#L70-L84](../../../../src/config.test.ts#L70-L84) is independent of seedProject.

## Non-blocking Implementation Notes

The local CLI verification in [SPEC/v2/review-2026-05-round2/G08/03-plan-r3.md#L118-L186](./03-plan-r3.md#L118-L186) duplicates the EXPECTED_SEED literal from the unit test. That is acceptable as an operator check, but the unit test should remain the canonical review gate; if implementation makes the CLI snippet too cumbersome to keep in sync, prefer a small built-test helper or rely on the focused vitest gate rather than letting two literals drift. This is not a required change to the plan.

## Recommendation

Proceed with the r3 plan. It fixes the root cause at the seeder/schema boundary, avoids backward-compatibility shims, preserves the sensitive-file operational rule, and explicitly separates the independent router/provider localhost-default behavior into follow-up work.

VERDICT: APPROVED