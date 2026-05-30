# F02 analysis review r2

## Prior required changes

All five required changes from [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-review-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-review-r1.md) are landed.

1. `node-html-parser` facts are corrected. The revised analysis names the actual `parseHtml(html, options)` call shape, records package metadata for `node-html-parser@7.1.0`, compares the v6/v7 `Options` interface, and concludes that the current options object is compatible with a zero-source-line migration at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L177-L217).
2. Validation placeholders are replaced with concrete coverage. The happy-dom environment is tied to [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts#L1) and root vitest inclusion, while `node-html-parser` is tied to the `data: web_search (G33)` tests at [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts#L711-L920); the matrix records those paths at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L370-L378).
3. The Node 24 compatibility scan is rerun with slash-suffix and dynamic-import coverage. It now includes `node:child_process`, `node:fs/promises`, `node:net`, and `node:readline`, assesses the reachable call shapes, replaces future verification language with measured deprecated/API checks, and classifies Linux `fsevents` optional-dependency noise at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L421-L513).
4. Container impact is concrete. The revised table records `saivage` and `saivage-v3` at `v24.15.0`, `saivage-v3-getrich-v2` at `v20.19.4`, and the required Node 24 provisioning dependency before redeploying to `saivage-v3-getrich-v2` at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L542-L569).
5. Markdown links and shell-command working directories are fixed. The document states the command convention up front at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L7), uses workspace-relative markdown targets throughout the body, and marks non-`saivage/` commands with `# from /home/salva/g/ml` where needed.

## A. Coverage

No blocking findings.

The analysis covers the topic-required surfaces: direct dependency decisions, the three visible majors, transitive CVE handling, validation paths, Node 24 compatibility, and operational container impact. The `happy-dom`, `node-html-parser`, and `zod` decisions are all explicit at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L145-L268). The transitive CVE plan records both remediated and residual advisories at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L292-L360).

## B. Groundedness

No blocking findings.

Spot checks match the revised claims: `node-html-parser@7.1.0` reports `main: dist/index.js`, `types: dist/index.d.ts`, no `type`, no `exports`, and dependencies on `css-select` plus `he`; the source call shape in [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts#L210-L214) matches the analysis. A fresh module scan also returns the same 13 `node:` modules listed at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L430-L443).

Non-blocking notes:

- The statement that `fs.exists` was removed in Node 24 at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L456-L477) is stronger than the observed Node `v24.16.0` runtime, where `require("node:fs").exists` is still a function. This does not change the implementer guidance because Saivage has no `fs.exists` call sites.
- The `node:readline` assessment at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L451-L460) talks about `readline/promises`, while the source uses callback-based `createInterface` in [saivage/src/server/cli.ts](saivage/src/server/cli.ts#L376-L383). The stability conclusion remains correct for the reachable call shape.

## C. Decision Quality

No blocking findings.

The decisions are conservative and implementer-ready. `happy-dom@^20.9.0` is required by critical CVEs and constrained to one test surface. `node-html-parser@^7.1.0` is a major, but the revised analysis verifies the one call site and option compatibility before choosing the bump. `zod@3.25.76` is deferred with a clear no-open-CVE justification and a follow-up topic identifier at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L219-L268).

## D. Transitive-CVE Strategy

No blocking findings.

The `ws`, `qs`, and `protobufjs` decisions use non-force `npm audit fix`, with a narrow `protobufjs` override fallback only if the non-force fix cannot satisfy the parent range. The `esbuild`/`vite`/`vitepress` chain is documented as residual, dev-only, and blocked on upstream; the expected end state is explicit as `0 critical`, `0 high`, and up to four documented moderate advisories at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L292-L360).

## E. Node 20 to 24 Compatibility Scan

No blocking findings.

The revised scan catches the missing modules and classifies reachable call shapes rather than leaving verification to implementation time. The native-module section correctly treats Linux `fsevents` entries as optional dependency noise, and the URL audit records measured call-site classes rather than a future `VERIFY` item at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L481-L513).

## F. Style

No blocking findings.

The document is factual, standalone, and implementer-ready. A scan found no unresolved `VERIFY`, `reviewer`, `CHANGES_REQUESTED`, or sibling-document approval-marker language. Markdown links use workspace-relative targets, and shown commands are either runnable from [saivage/](saivage/) or explicitly marked with their alternate working directory.

## Required Changes

None.

VERDICT: APPROVED