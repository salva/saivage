# G35b - Review r3

**Reviewer**: GitHub Copilot
**Round reviewed**: [SPEC/v2/review-2026-05-round2/G35b/01-analysis-r3.md](01-analysis-r3.md), [SPEC/v2/review-2026-05-round2/G35b/02-design-r3.md](02-design-r3.md), [SPEC/v2/review-2026-05-round2/G35b/03-plan-r3.md](03-plan-r3.md)
**Prior review**: [SPEC/v2/review-2026-05-round2/G35b/04-review-r2.md](04-review-r2.md)

## Blocking Findings

None.

## Verification

- The schema-layer full-replacement blocker from r2 is closed. Round 3 adds S-R-A for credentialLexemes resolving exactly to ["PII"] and S-R-B for configPointerSuffixes resolving exactly to ["_BUILDFILE"] in the analysis and design [SPEC/v2/review-2026-05-round2/G35b/01-analysis-r3.md](01-analysis-r3.md#L61-L68), [SPEC/v2/review-2026-05-round2/G35b/02-design-r3.md](02-design-r3.md#L156-L186), and carries both into F15 in the implementation plan [SPEC/v2/review-2026-05-round2/G35b/03-plan-r3.md](03-plan-r3.md#L257-L293). The empty-suffix replacement case now explicitly includes expect(got).toEqual([]) before the length and not.toContain checks [SPEC/v2/review-2026-05-round2/G35b/03-plan-r3.md](03-plan-r3.md#L235-L251).
- The malformed r2 sentinel gate is fixed. Gates 20a and 20b use fixed-string rg -F checks for replace(/_/g, "[_-]") and (?:^|[_-]) respectively, with grep -F fallbacks, so brackets and parentheses are no longer parsed as regex metacharacters by the search tool [SPEC/v2/review-2026-05-round2/G35b/03-plan-r3.md](03-plan-r3.md#L381-L424). Those literals correspond to the compiler anchors documented in the round-3 design [SPEC/v2/review-2026-05-round2/G35b/02-design-r3.md](02-design-r3.md#L43-L55).
- The fixture cleanup note from r2 is handled. The plan no longer claims that [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1) already has a temp-project fixture; it spells out a block-local mkdtempSync plus .saivage/saivage.json fixture and points to the existing [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L66) pattern as the reference [SPEC/v2/review-2026-05-round2/G35b/03-plan-r3.md](03-plan-r3.md#L93-L168). This matches the live tree: [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1) is still a pure validateModelCoverage test file, while [src/config.ts](../../../../src/config.ts#L261-L275) supports the proposed loadConfig(true, projectRoot) call shape.
- Principle 2, config over hardcoded behavior, is preserved end-to-end. The design keeps the env scrubber defaults in [src/security/secrets.ts](../../../../src/security/secrets.ts), imports them into [src/config.ts](../../../../src/config.ts), applies them through security.envScrubber without a Zod transform or union step [SPEC/v2/review-2026-05-round2/G35b/02-design-r3.md](02-design-r3.md#L57-L79), and the plan requires [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) to have zero SECRET_ENV_PATTERNS references while reading security.envScrubber.credentialLexemes from config [SPEC/v2/review-2026-05-round2/G35b/03-plan-r3.md](03-plan-r3.md#L338-L367). That correctly replaces the current hardcoded live scrubber surface [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L428) rather than preserving it as a parallel fallback.

## Residual Risk

- Gate numbering in the prose says the two schema sentinels are gates 21 and 22, while the rendered ordered list numbers them as 22 and 23 after 20a/20b [SPEC/v2/review-2026-05-round2/G35b/03-plan-r3.md](03-plan-r3.md#L334-L456). This is editorial only; the actual commands and required assertions are clear and shell-safe.

VERDICT: APPROVED