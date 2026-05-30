# F02 — Node 24 migration and dependency refresh (Saivage v2)

This is the topic file for the iterative-dual-llm-review dance.

## Goal

Migrate the Saivage v2 codebase rooted at [saivage/](saivage/) from Node `>=20.0.0` to Node `>=24` LTS, refresh runtime and dev dependencies, and remediate the open CVEs reported by `npm audit`. Land the work as a sequenced set of revertable commits so subsequent feature work (notably F01 RAG subsystem) builds on a clean, vulnerability-free baseline.

This is a prerequisite for [F01 — RAG subsystem](../rag-subsystem-design/F01-rag-subsystem.md). F01 already specifies the engine pin bump in its B01; that step is hereby moved into F02 so F01 B01 can be reduced to RAG-specific dependency additions only.

## Hard constraints

1. **Node engines pin:** [saivage/package.json](saivage/package.json) `engines.node` must be set to `>=24.0.0` (the host has 24.16.0 LTS installed at `~/.local/node-24/`; CI/container hosts must match).
2. **No backward compatibility code:** per the workspace-wide architecture-first rule, do not add Node 20 fallbacks, do not preserve Zod v3-only conditionals, do not keep transitional shims. If a dependency moves to a new API, migrate fully or stay on the old version.
3. **CVE remediation:** at the end of F02, `npm audit` must report zero high/critical and ideally zero moderate vulnerabilities. Each open advisory listed in the analysis must either be closed by an upgrade or recorded in the plan with a written justification.
4. **Test suite must remain green:** at the end of every batch, `npm run typecheck`, `npm run lint`, and `npm test` must all pass on Node 24.16.0 on the host (`~/.local/node-24/bin/node`).
5. **No source-feature changes:** dependency-driven code changes are limited to the smallest possible API migration required by the new version. No refactors, no new features. If a major-version bump requires more than a localized migration, the bump is deferred and a follow-up topic is recorded in the plan's non-goals.
6. **Per-batch commits, revertable:** each batch lands as a single commit on the master branch (no feature branch — short-lived sequence). Rollback for any batch is `git revert <hash>` followed by `npm install`.
7. **Out of scope for F02 (deferred to follow-up topics):** Zod 3 → 4 migration (workspace-wide breaking refactor), the F01 RAG dependency additions (`better-sqlite3`, `sqlite-vec`, `tree-sitter*`, `picomatch`, `proper-lockfile`, `chokidar`), and any code/config reorganization unrelated to the version bumps.

## Current state snapshot (May 27, 2026)

- Host Node available: `~/.local/node-24/bin/node` reports `v24.16.0`, `npm` reports `11.13.0`. System `/usr/bin/node` is `v20.19.4`.
- [saivage/package.json](saivage/package.json) currently pins `"engines": { "node": ">=20.0.0" }`.
- `npm audit` summary at baseline: 0 info, 0 low, 7 moderate, 0 high, 1 critical, total 8.
  - **critical:** `happy-dom` (VM Context Escape RCE; fetch-credentials origin confusion; ECMAScriptModuleCompiler unsanitized export interpolation). Direct devDependency at `^15.11.7`; vulnerable through 15.x. Fixed in 16+.
  - **moderate:** `esbuild` (dev-server path traversal — transitive via `vite`); `vite` (`.map` path traversal + esbuild); `vitepress` (via vite); `vitepress-plugin-mermaid` (via vitepress); `ws` (uninitialized memory disclosure — transitive); `qs` (DoS in `qs.stringify` with comma-format arrays — transitive); `protobufjs` (DoS via unbounded recursive JSON descriptor expansion — transitive).
- `npm outdated` highlights:
  - Safe minor/patch updates available: `@anthropic-ai/sdk` 0.95.1 → 0.99.0 (still 0.x — treat as major), `@types/node` 25.6.2 → 25.9.1, `eslint` 10.3.0 → 10.4.0, `grammy` 1.42.0 → 1.43.0, `openai` 6.37.0 → 6.39.0, `tsx` 4.21.0 → 4.22.3, `vitest` 4.1.5 → 4.1.7.
  - Major bumps available: `happy-dom` 15 → 20 (CVE-driven; required), `node-html-parser` 6 → 7 (single import site in [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts)), `zod` 3.25.76 → 4.4.3 (deferred per constraint 7).
- `zod` is imported in roughly 20 source files using v3 idioms (`z.ZodIssueCode.custom`, `z.ZodTypeAny`, `z.ZodError`). Migration to v4 is non-trivial and out of scope here.

## Required analysis topics

The analysis document must cover:

- Per-dependency upgrade decision: target version, semver risk class (patch / minor / major), CVE driver if any, surface of saivage code that imports the dependency, and the minimal migration delta required if any.
- Explicit decisions on the three majors visible today: `happy-dom`, `node-html-parser`, `zod`. For `zod`, the analysis must justify deferral, point to follow-up work, and confirm no CVE is left open by deferring.
- Transitive-CVE strategy: for each moderate advisory reachable only via a transitive (`esbuild`, `ws`, `qs`, `protobufjs`), explain whether `npm audit fix` (non-`--force`), a top-level version bump of the parent, or `npm overrides` is the chosen remediation, and what residual risk remains.
- Validation matrix: which Saivage v2 code paths most depend on each upgraded package (e.g., `web/src/composables/useWebSocket.test.ts` for happy-dom; `src/mcp/builtins.ts` for node-html-parser; the entire test suite for vitest), and how each is exercised in the existing test corpus.
- Node 24 compatibility risks: APIs removed or changed between Node 20 and 24 that are reachable from saivage source or any current dependency (focus on `node:fs`, `node:test`, native binding ABI for any pre-built artifacts in `node_modules`).
- Operational impact: containers `saivage` (10.0.3.111), `saivage-v3` (10.0.3.112), and `saivage-v3-getrich-v2` (10.0.3.170). Do they currently ship Node 24? If not, what is the rollout requirement? F02 is not responsible for container provisioning but the analysis must record the dependency.

## Required design topics

A single proposal is acceptable for F02 (this is not an architectural choice; it is a sequencing + risk strategy). The design document must specify:

- Ordering rationale: which upgrades land first and why.
- Gating: validation commands after each batch and the threshold for proceeding versus rolling back.
- Containerization note: design must state explicitly whether F02 includes container Node updates or defers them with a follow-up topic.

## Required plan topics

The implementation plan must produce a batch table with:

- One commit per batch.
- Files modified, validation commands, and rollback procedure per batch.
- A first batch that is purely the engines pin and `package-lock.json` baseline regeneration under Node 24 (no dependency changes).
- A final batch that re-runs `npm audit` and records residual advisories (if any) plus the validation transcript.
- An updated cross-reference to [F01 — RAG subsystem](../rag-subsystem-design/F01-rag-subsystem.md): F01 B01 must be amended to drop the engine pin step.

## Project rules

- Tone: factual, implementer-ready, no marketing language.
- File links: workspace-relative markdown links only. Bare paths inside fenced code blocks are exempt.
- Autonomous documents: literal interpretation — avoid words like "round", "revision", "added", "previously" that refer to the dance itself. Each document must read as a standalone artifact.
- Numbers cited from `npm audit` / `npm outdated` must match the current-state snapshot in this topic or be re-measured and explicitly re-stated.
- All shell commands shown must be runnable from [saivage/](saivage/) with `PATH=~/.local/node-24/bin:$PATH` (or equivalent on a Node-24-default host).

## Scope boundaries

In scope:
- Edits to [saivage/package.json](saivage/package.json) and [saivage/package-lock.json](saivage/package-lock.json).
- Minimal API-migration edits to saivage source files required by a chosen major-version bump.
- Validation runs.
- An amendment to [F01-rag-subsystem.md](../rag-subsystem-design/F01-rag-subsystem.md) and [F01 — plan](../rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md) recording that the engine pin lands in F02.

Out of scope (deferred to follow-up topics):
- Zod 4 migration.
- F01 RAG dependency additions.
- Container Node-24 provisioning across the three LXC hosts.
- Web frontend dependency refresh under [saivage/web/](saivage/web/) (its own `package.json` and lockfile — covered by a separate F03 topic if needed).
- Any source-feature refactor.
