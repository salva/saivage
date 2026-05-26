# G23 - Review of round 2

## Findings

None. Round 2 resolves the two required changes from [04-review-r1.md](SPEC/v2/review-2026-05-round2/G23/04-review-r1.md#L5-L12).

## Verification

- The failure surface is now described correctly. R2 says the constructor failure occurs before fatal handlers and is caught by the CLI start action; source confirms resolver construction at [src/server/bootstrap.ts](src/server/bootstrap.ts#L130-L136), model coverage immediately after it at [src/server/bootstrap.ts](src/server/bootstrap.ts#L136), lock acquisition later at [src/server/bootstrap.ts](src/server/bootstrap.ts#L180), fatal-handler installation later at [src/server/bootstrap.ts](src/server/bootstrap.ts#L250), fatal-handler scope at [src/server/bootstrap.ts](src/server/bootstrap.ts#L705-L734), and the CLI start catch/finally at [src/server/cli.ts](src/server/cli.ts#L70-L97).
- The architectural-property test gap is closed. R2 requires the unused transitive cycle regression at [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G23/03-plan-r2.md#L172-L196), which catches A -> B -> C -> B while roles point to an acyclic profile. That is the case the existing role-driven validator at [src/config-validation.ts](src/config-validation.ts#L41-L62) cannot catch because it only resolves required roles and catches every per-role exception.
- The implementation shape matches the current resolver. Constructor-time validation is placed after profile normalization at [src/routing/resolver.ts](src/routing/resolver.ts#L93-L103), and the plan removes the current silent guard at [src/routing/resolver.ts](src/routing/resolver.ts#L173-L186) instead of adding a trace, migration shim, or compatibility flag. That fits the architecture-first, no-backward-compatibility rule.
- The stale config-path reference called out in R1 is fixed. R2 now points to the current config path and root-resolution code at [src/config.ts](src/config.ts#L198-L226).

## Notes

- Minor doc nit: the optional serve-action discussion in [01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G23/01-analysis-r2.md#L42-L42) and [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G23/03-plan-r2.md#L205-L205) cites [src/server/cli.ts](src/server/cli.ts#L100-L160), but the actual serve command is at [src/server/cli.ts](src/server/cli.ts#L306-L391). This is not a blocker for G23 because the required start path is correct at [src/server/cli.ts](src/server/cli.ts#L70-L97), and the actual serve catch still emits Fatal and exits at [src/server/cli.ts](src/server/cli.ts#L389-L391).
- Optional polish: the direct-cycle test in [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G23/03-plan-r2.md#L132-L148) checks the error type only, while the design says the direct-cycle test should also check the cycle payload at [02-design-r2.md](SPEC/v2/review-2026-05-round2/G23/02-design-r2.md#L67-L70). The self-loop and unused-transitive tests already assert payloads, including the R1-required segment at [03-plan-r2.md](SPEC/v2/review-2026-05-round2/G23/03-plan-r2.md#L194-L195), so this does not change the verdict.

VERDICT: APPROVED