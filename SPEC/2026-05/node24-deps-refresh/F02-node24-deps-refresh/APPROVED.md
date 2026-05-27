# F02 — Node 24 migration & dependency refresh — APPROVED

Approved deliverables for the iterative-dual-llm-review dance:

| Stage | File | Verdict |
| --- | --- | --- |
| Topic | [F02-node24-deps-refresh.md](../F02-node24-deps-refresh.md) | — |
| Analysis | [01-analysis-r2.md](01-analysis-r2.md) | APPROVED ([review](01-analysis-review-r2.md)) |
| Design | [02-design-r3.md](02-design-r3.md) | APPROVED ([review](02-design-review-r3.md)) |
| Implementation plan | [03-plan-r5.md](03-plan-r5.md) | APPROVED ([review](03-plan-review-r5.md)) |

## Headline contract

- **Engine pin:** `engines.node` rises from `>=20.0.0` to `>=24.0.0` in [saivage/package.json](../../../../package.json).
- **CVE remediation end-state:** zero high/critical advisories; `ws`, `qs`, `protobufjs`, and `happy-dom` advisory roots closed; only the four dev-only vitepress-chain moderate advisories (`esbuild`, `vite`, `vitepress`, `vitepress-plugin-mermaid`) permitted as residuals.
- **Direct dependency targets:** `happy-dom` 15 → 20.9 (critical CVE), `node-html-parser` 6 → 7.1 (opportunistic, single import site), `@anthropic-ai/sdk` 0.95.1 → 0.95.2 (wanted), plus safe wanted bumps for `@types/node`, `eslint`, `grammy`, `openai`, `tsx`, `vitest`. `zod` 3 → 4 deferred to a follow-up topic.
- **Batch sequence (7 commits):** (a) engine pin + Node 24 relock; (b) safe wanted bumps; (c) `npm audit fix` (no `--force`) closing `ws`/`qs`/`protobufjs`; (d) `happy-dom` 15 → 20; (e) `node-html-parser` 6 → 7; (f) final audit evidence capture; (g) F01 cross-reference amendment (doc-only). Rollback for any batch is `git revert <hash> && npm install`.
- **Validation per batch:** `T` typecheck, `L` lint, `A` `npm test`, plus `Fc` (scoped audit) for batch (c), `Ff` (final audit contract) for batch (f), and `W` (web lockfile guard) for every runtime batch.

## Cross-references

- [F01 — RAG subsystem](../../rag-subsystem-design/F01-rag-subsystem.md) and its [implementation plan](../../rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md) are amended by batch (g): the engine-pin step moves out of F01 B01, leaving B01 with only the RAG-specific dependency additions.
- Follow-up topics registered by the plan: `F03` container Node 24 provisioning, `F04` zod 4 migration, `F05` `@anthropic-ai/sdk` 0.99.x evaluation, `F06` `protobufjs` CVE remediation (only if the audit-fix path in batch (c) fails).

No source code has been changed by F02 design work; implementation pause point is the same as before — explicit user go-ahead is needed to begin executing batches (a)..(g).
