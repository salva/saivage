# G31 - Review r4

**Reviewer**: GPT-5.5
**Verdict**: APPROVED

## Findings

No blocking findings.

Round 4 addresses the three r3 blockers without weakening the G31 contract. The broken native-ESM spy strategy is removed in favor of exporting the pure classifier and testing it directly; this is compatible with the package's ESM mode in [package.json](../../../../package.json#L5) and avoids the non-configurable module-namespace problem called out in [SPEC/v2/review-2026-05-round2/G31/04-review-r3.md](04-review-r3.md#L11-L13). The r4 docs also keep the live-code sequencing honest: current [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L18-L25) and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L276) are still pre-G30/synchronous, and r4 continues to require re-anchoring after G30 before implementation.

## Verification

| Requirement | r4 status |
| --- | --- |
| `classifyFsError` exported and unit-tested per branch. | Addressed. The analysis selects the export-based test boundary in [SPEC/v2/review-2026-05-round2/G31/01-analysis-r4.md](01-analysis-r4.md#L75-L99), the design exports `FsErrorCode`, `ClassifiedFsError`, and `classifyFsError` in [SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](02-design-r4.md#L41-L65), and the plan imports `classifyFsError` without `vi` mocking in [SPEC/v2/review-2026-05-round2/G31/03-plan-r4.md](03-plan-r4.md#L149-L152). The planned classifier test block covers ENOENT, ENOTDIR, EACCES, EPERM, EISDIR, EIO, close context, and non-Error fallback in [SPEC/v2/review-2026-05-round2/G31/03-plan-r4.md](03-plan-r4.md#L172-L224). |
| EISDIR branch covered by classifier unit test. | Addressed. The analysis explains why the live handler normally reaches directory paths through `!st.isFile()` before `open`, making synthetic classifier coverage the deterministic test path in [SPEC/v2/review-2026-05-round2/G31/01-analysis-r4.md](01-analysis-r4.md#L105-L123). The plan adds the explicit EISDIR case in [SPEC/v2/review-2026-05-round2/G31/03-plan-r4.md](03-plan-r4.md#L196-L203) and records that this satisfies the r3 blocker in [SPEC/v2/review-2026-05-round2/G31/03-plan-r4.md](03-plan-r4.md#L239-L245). |
| `handle.close()` failure classified with `"close"` context and only used when no primary failure exists. | Addressed. The analysis states the ordering rule in [SPEC/v2/review-2026-05-round2/G31/01-analysis-r4.md](01-analysis-r4.md#L132-L156). The design implements the rule with an in-finally `try/catch` and `if (!readFailure && !isBinary)` guard in [SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](02-design-r4.md#L163-L174), then returns binary and primary read failures ahead of any close-only failure in [SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](02-design-r4.md#L178-L194). The implementation plan carries the same replacement block in [SPEC/v2/review-2026-05-round2/G31/03-plan-r4.md](03-plan-r4.md#L74-L88). |
| No regression to r3 windowed-read accounting. | Addressed. The r4 handler reference still records `probeRead.bytesRead`, reuses the probe buffer only when the requested zero-offset window is fully inside the bytes actually read, and records `winRead.bytesRead` for independent window reads in [SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](02-design-r4.md#L128-L158). This preserves the accounting approved in [SPEC/v2/review-2026-05-round2/G31/04-review-r3.md](04-review-r3.md#L25). |
| No regression to r3 NUL-probe semantics. | Addressed. The r4 reference still probes the file head, sets `isBinary` from the actual probe bytes, skips the window read when binary, closes the handle, and returns `BINARY_CONTENT` before `readFailure` in [SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](02-design-r4.md#L135-L147) and [SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](02-design-r4.md#L178-L194). That matches the r3 semantics summarized in [SPEC/v2/review-2026-05-round2/G31/04-review-r3.md](04-review-r3.md#L26). |

## Residual Risk

The close-failure ordering is structurally specified rather than end-to-end tested, because exercising a rejecting `FileHandle.close()` would require the same filesystem-open mocking surface that r3 already proved brittle. I do not consider that a blocker: r4 tests the classifier branch directly in [SPEC/v2/review-2026-05-round2/G31/03-plan-r4.md](03-plan-r4.md#L214-L218), and the production guard is a simple local assignment rule in [SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](02-design-r4.md#L164-L174).

VERDICT: APPROVED