# G10 — APPROVED

**Chosen proposal**: Proposal C (per [02-design-r2.md](02-design-r2.md)) — delete `appendDoc` and its tests entirely. The function has a real read-modify-write race at [src/store/documents.ts](../../../../src/store/documents.ts#L107-L126), but no production caller exists; the only call sites are its own tests in [src/store/documents.test.ts](../../../../src/store/documents.test.ts). The public barrel at [src/index.ts](../../../../src/index.ts#L28-L36) does not export it. Proposal A (in-function lock) is rejected: it preserves dead API surface. Proposal B (shared `withDocLock` primitive) is rejected: it would generalize across mismatched consistency boundaries already deliberately split by G36 (cross-process lockfile for auth), G38 (per-scope/per-record knowledge lifecycle locks), and G06 (no shared abstraction for UUID-unique stash files).

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). Both r1 changes addressed: `npm run docs:api` regeneration is a required implementation step (per [package.json](../../../../package.json#L22) and [docs/internals/development.md](../../../../docs/internals/development.md#L68-L73)); pre-change grep baseline corrected to 5 lexical matches.

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md). Round-trip test in [src/store/documents.test.ts](../../../../src/store/documents.test.ts) is rewritten to use `writeDoc`. The generated [docs/api/store/documents/functions/appendDoc.md](../../../../docs/api/store/documents/functions/appendDoc.md) and its sidebar entry are removed via TypeDoc regeneration, not hand edits.

**Daemon impact**: None. Operator-gated daemon restart is explicitly not required by this change.
