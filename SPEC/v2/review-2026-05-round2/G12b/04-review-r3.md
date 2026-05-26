# G12b - Review (Round 3)

Reviewer: GitHub Copilot

Round 3 resolves the two blockers from [04-review-r2.md](04-review-r2.md). The stale-config regression is now specified through the public `loadConfig` path with a real fixture file, and the `PromptInjection` inventory now includes the live bootstrap import site.

## Findings

No blocking findings.

## Verification

- The stale `security` regression no longer depends on an unexported schema. [02-design-r3.md](02-design-r3.md#32-stale-security-block-fails-boot-via-loadconfig-replaces-round-2-32) and [03-plan-r3.md](03-plan-r3.md#validation) place the test in [src/config.test.ts](../../../../src/config.test.ts), write [src/config.test.ts](../../../../src/config.test.ts#L48-L87)-style on-disk .saivage/saivage.json fixture data, call `loadConfig(true, projectRoot)`, and assert a `ZodError` with `unrecognized_keys` including `security`. The live code supports that path: [src/config.ts](../../../../src/config.ts#L62) keeps `configSchema` module-local, while [src/config.ts](../../../../src/config.ts#L261) exports `loadConfig`, reads [src/config.ts](../../../../src/config.ts#L266-L270) from disk, and rethrows the schema parse error from [src/config.ts](../../../../src/config.ts#L273).
- The `PromptInjection` inventory now lists the bootstrap occurrence. [01-analysis-r3.md](01-analysis-r3.md#3-residue-inventory--promptinjection-row-correction) adds [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L13) to the corrected row, matching the live `createPromptInjectionCop` import at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L13).
- E3 covers the bootstrap removal. [03-plan-r3.md](03-plan-r3.md#e3--strip-cop-wiring-from-srcserverbootstrapts) explicitly removes the `createPromptInjectionCop` import, the `securityModel` runtime-routing field, and the `registerBuiltinServices` cop options from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L13-L151).
- E11 covers the invariant if E3 is incomplete. Round 3 keeps [03-plan-r2.md](03-plan-r2.md#e11--add-no-cop-invariant-test-new-in-round-2), whose `FORBIDDEN` list includes `PromptInjection`, `promptInjectionCop`, `prompt-injection-cop`, `securityModel`, and the other cop residue strings, and whose `SCAN_ROOTS` cover [src](../../../../src), [web/src](../../../../web/src), and [docs](../../../../docs). That scan would catch the live bootstrap import if it survived the edit.

## Non-blocking Notes

- [03-plan-r3.md](03-plan-r3.md#validation) still labels the data-path test as E11 in one bullet even though the edit inherited from round 2 is E7. The target file and test wording are clear, so this is only a label typo and does not affect executability.

VERDICT: APPROVED