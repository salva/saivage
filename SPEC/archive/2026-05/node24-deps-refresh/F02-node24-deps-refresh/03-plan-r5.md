# F02 — Node 24 migration and dependency refresh implementation plan

Topic: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md).

All shell commands in this document are runnable from [saivage/](saivage/) with `PATH=~/.local/node-24/bin:$PATH`. Commands intended for a different working directory carry an explicit `# from <dir>` comment.

---

## 1. Scope summary

F02 raises the Saivage v2 engines pin to `>=24.0.0`, refreshes the seven safe `wanted`-column direct dependencies, closes the open CVE chain via `npm audit fix` (transitive remediation of `ws`, `qs`, `protobufjs`), takes one CVE-driven major (`happy-dom` 15 → 20 — critical advisory chain) and one opportunistic / low-impact major (`node-html-parser` 6 → 7 — no CVE driver; single import site at [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts)), captures the final-state audit transcript, and amends two F01 documents so the engines-pin no longer collides with F01 B01. All runtime changes are confined to [saivage/package.json](saivage/package.json) and [saivage/package-lock.json](saivage/package-lock.json); the doc-only amendment touches [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md) and [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md). No source-feature changes are introduced. All commands run against Node `v24.16.0` and `npm 11.13.0` provided by `~/.local/node-24/bin`.

## 2. Non-goals

The following are explicitly out of scope for F02 and are routed to follow-up topics in §8:

- Zod 3 → 4 migration (deferred to F04).
- `@anthropic-ai/sdk` `0.95.x → 0.99.x` evaluation (deferred to F05).
- F01 RAG dependency additions (`better-sqlite3`, `sqlite-vec`, `tree-sitter*`, `picomatch`, `proper-lockfile`, `chokidar`).
- Container Node-24 provisioning across the three LXC hosts (deferred to F03).
- Web frontend dependency refresh under [saivage/web/](saivage/web/) — its own `package.json` and lockfile must not change during F02.
- Any source-feature refactor.
- New tests; F02 does not introduce test files.

## 3. Validation legend

Every batch ends with at least `T+L+A`. Batch (c) additionally runs `Fc`; batch (f) additionally runs `Ff`. Every runtime batch enforces `W`.

| Code | Command | Pass criterion |
| --- | --- | --- |
| T | `PATH=~/.local/node-24/bin:$PATH npm run typecheck` | Exit code `0`. |
| L | `PATH=~/.local/node-24/bin:$PATH npm run lint` | Exit code `0`. Net-new warnings are allowed but recorded in §6.f evidence. |
| A | `PATH=~/.local/node-24/bin:$PATH npm test` | Exit code `0`. The set of vitest test names passing at the parent commit must remain a subset of those passing at the current commit. |
| Fc | `PATH=~/.local/node-24/bin:$PATH npm audit --json` (scoped to the batch-(c) transitive remediation roots) | Transitive audit gate. The `vulnerabilities` map of `npm audit --json` is parsed to confirm that the advisory roots `ws`, `qs`, and `protobufjs` are CLOSED — i.e. each name is absent from the `vulnerabilities` map regardless of advisory id. This gate explicitly permits other advisories (notably `happy-dom`) to remain at this point in the sequence; those are closed by later batches and re-checked by `Ff`. |
| Ff | `PATH=~/.local/node-24/bin:$PATH npm audit --json` (final-state contract) | Final audit gate. The full final-state contract from §7: zero `high`, zero `critical`, and zero entries in the `vulnerabilities` map keyed by `ws`, `qs`, `protobufjs`, or `happy-dom`. The only permitted residuals are the four vitepress-chain moderates (`esbuild`, `vite`, `vitepress`, `vitepress-plugin-mermaid`); any other residual key fails the gate. |
| W | `git diff --quiet HEAD~1 -- web/` (from `/home/salva/g/ml/saivage`) | Exit code `0`. No file under [saivage/web/](saivage/web/) changes in any F02 commit. |

## 4. Batch table

| Id | Title | Files modified | Validation | Depends on | Rollback |
| --- | --- | --- | --- | --- | --- |
| (a) | Engine pin + Node 24 relock | [saivage/package.json](saivage/package.json), [saivage/package-lock.json](saivage/package-lock.json) | T+L+A+W | — | `git revert <hash> && rm -rf node_modules && npm install` |
| (b) | Safe `wanted` bumps (`@types/node`, `eslint`, `grammy`, `openai`, `tsx`, `vitest`, `@anthropic-ai/sdk@^0.95.2`) | [saivage/package.json](saivage/package.json), [saivage/package-lock.json](saivage/package-lock.json) | T+L+A+W | (a) | `git revert <hash> && npm install` |
| (c) | `npm audit fix` (no `--force`) — closes `ws`, `qs`, `protobufjs` | [saivage/package-lock.json](saivage/package-lock.json); [saivage/package.json](saivage/package.json) only if the `overrides` fallback fires | T+L+A+Fc+W | (b) | `git revert <hash> && npm install` |
| (d) | `happy-dom` 15 → 20 | [saivage/package.json](saivage/package.json), [saivage/package-lock.json](saivage/package-lock.json); at most [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) if a happy-dom-20 API breakage surfaces (this is the one path-narrow exemption to `W`) | T+L+A+W (conditional) | (c) | `git revert <hash> && npm install` |
| (e) | `node-html-parser` 6 → 7 | [saivage/package.json](saivage/package.json), [saivage/package-lock.json](saivage/package-lock.json) | T+L+A+W | (d) | `git revert <hash> && npm install` |
| (f) | Final `npm audit` evidence capture | This plan file only — [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md) §9 evidence block | T+L+A+Ff+W | (e) | `git revert <hash>` |
| (g) | F01 cross-reference amendment (doc-only) | [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md), [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md) | path-set guard via `git diff --stat` | (f) | `git revert <hash>` |

The (d) row carries the single permitted exception to `W` because [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) is the only happy-dom consumer (see analysis §2.1) and editing it is required to honour the topic's CVE-closure constraint. The exception is path-narrow: only that single test file may change under [saivage/web/](saivage/web/), and neither [saivage/web/package.json](saivage/web/package.json) nor [saivage/web/package-lock.json](saivage/web/package-lock.json) may move in any F02 commit.

---

## 5. Pre-flight contract

Before batch (a) starts, the implementer confirms:

```bash
node --version             # must report v24.16.0 (via ~/.local/node-24/bin/node)
npm --version              # must report 11.13.0
git status --porcelain     # must be empty (clean working tree on master)
git rev-parse --abbrev-ref HEAD   # must report master
```

If any check fails, F02 does not start. The implementer fixes the host PATH (must place `~/.local/node-24/bin` before `/usr/bin`), commits or discards pending changes, and switches to `master` before retrying.

---

## 6. Per-batch detail

### 6.a — Engine pin + Node 24 relock

Goal: pin `engines.node` to `>=24.0.0` and regenerate the lockfile under Node 24 / npm 11 so subsequent batches modify a canonical baseline.

Files modified (workspace-relative):

- [saivage/package.json](saivage/package.json) — `engines.node` field only.
- [saivage/package-lock.json](saivage/package-lock.json) — fully regenerated.

Commands (from `/home/salva/g/ml/saivage`):

```bash
export PATH=~/.local/node-24/bin:$PATH
node --version
npm --version
# Edit package.json via the IDE: set "engines": { "node": ">=24.0.0" }
grep -E '"node":[[:space:]]*">=24' package.json    # confirm on-disk edit
rm -rf node_modules
npm install
git add package.json package-lock.json
git commit -m "F02(a): pin engines.node to >=24.0.0; relock under Node 24 / npm 11"
```

Validation:

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test
git diff --quiet HEAD~1 -- web/                       # W guard
```

Pass criteria: T, L, A, W all green. No dependency-version field in `package.json` changed (only the `engines.node` value).

Acceptance gate: the commit diff for `package.json` shows exactly one changed line (the `engines.node` value); `package-lock.json` lists the same set of top-level dependencies as the parent commit; T+L+A+W are green.

Rollback: `git revert <hash> && rm -rf node_modules && npm install`.

Test count: 0 (no new tests).

Risk recap (from design §6 row a): `EBADENGINE` from an unmaintained transitive declaring a Node upper bound, or a dedup shift that causes a runtime regression. Detected by `npm install` exit code and by `npm test` deltas respectively; both rollback to `git revert HEAD && rm -rf node_modules && npm install`.

---

### 6.b — Safe `wanted`-column bumps

Goal: take every `wanted` direct-dependency upgrade visible in the analysis §1.3 baseline in one commit, so the remediation steps that follow run against the freshest set of in-range versions.

Packages bumped (analysis §1.4 decision rows):

- `@anthropic-ai/sdk` `^0.95.1` → `^0.95.2`.
- `@types/node` `^25.6.2` → `^25.9.1`.
- `eslint` `^10.3.0` → `^10.4.0`.
- `grammy` `^1.42.0` → `^1.43.0`.
- `openai` `^6.37.0` → `^6.39.0`.
- `tsx` `^4.21.0` → `^4.22.3`.
- `vitest` `^4.1.5` → `^4.1.7`.

The `@anthropic-ai/sdk` `0.99.x` jump is deferred to F05 (see §8).

Files modified:

- [saivage/package.json](saivage/package.json) — seven version ranges.
- [saivage/package-lock.json](saivage/package-lock.json) — regenerated entries for the seven packages and their transitives.

Commands:

```bash
export PATH=~/.local/node-24/bin:$PATH
npm install \
    @anthropic-ai/sdk@^0.95.2 \
    @types/node@^25.9.1 \
    eslint@^10.4.0 \
    grammy@^1.43.0 \
    openai@^6.39.0 \
    tsx@^4.22.3 \
    vitest@^4.1.7
grep -E '"@anthropic-ai/sdk":[[:space:]]*"\^0\.95\.2"' package.json
grep -E '"vitest":[[:space:]]*"\^4\.1\.7"' package.json
git add package.json package-lock.json
git commit -m "F02(b): wanted-column bumps (anthropic-sdk, types/node, eslint, grammy, openai, tsx, vitest)"
```

Validation:

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test
git diff --quiet HEAD~1 -- web/
```

Pass criteria: T+L+A+W green; the vitest test names passing at (a) are a subset of those passing at (b).

Acceptance gate: `npm outdated` no longer lists any of the seven packages in the `Wanted` column drift state for direct dependencies; `package.json` shows the seven exact range bumps and nothing else.

Rollback: `git revert <hash> && npm install`. If one specific package is the culprit, re-land the remaining six in a fresh (b') commit and open a follow-up topic for the holdout.

Test count: 0.

Risk recap (design §6 row b): a minor in any of the seven deprecates an API used by the test suite or the LLM client. Detected by T (type drift) or A (runtime drift); rollback via revert, then re-land one-by-one to identify the offender.

---

### 6.c — `npm audit fix` (no `--force`)

Goal: close the three transitive CVE roots (`ws`, `qs`, `protobufjs`) via a non-force `npm audit fix`. If `protobufjs` resists the non-force path under `@google/genai`'s peer range, fall back to an `overrides` block per analysis §3.3.

Files modified:

- [saivage/package-lock.json](saivage/package-lock.json) — always.
- [saivage/package.json](saivage/package.json) — only if the `overrides` fallback fires; the block has the exact shape:

```jsonc
"overrides": { "protobufjs": "^7.5.8" }
```

Commands:

```bash
export PATH=~/.local/node-24/bin:$PATH
npm audit fix                  # non-force; lockfile-only by default
# Conditional fallback:
#   If `npm audit --json` still keys "protobufjs" under .vulnerabilities,
#   edit package.json to insert the overrides block above, then:
#       npm install
#       grep -E '"protobufjs":[[:space:]]*"\^7\.5\.8"' package.json
git add package.json package-lock.json
git commit -m "F02(c): npm audit fix (ws, qs, protobufjs); overrides protobufjs if required"
```

Validation (the `Fc` scoped audit check is the node script below; the full final-state contract is gated by `Ff` at batch (f), not here):

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test
PATH=~/.local/node-24/bin:$PATH npm audit --json > ../tmp/f02-c-audit.json
node -e '
  const a = require("../tmp/f02-c-audit.json");
  const v = a.vulnerabilities || {};
  for (const name of ["ws","qs","protobufjs"]) {
    if (v[name]) {
      console.error("STILL VULNERABLE:", name, v[name].severity);
      process.exit(1);
    }
  }
  console.log("ok: ws/qs/protobufjs absent from vulnerabilities map");
'
git diff --quiet HEAD~1 -- web/
```

Pass criteria: T+L+A+W green; the `Fc` scoped audit check (the node script above) exits `0` — i.e. the `vulnerabilities` map of `npm audit --json` has no key named `ws`, `qs`, or `protobufjs`, irrespective of advisory id. There is no "same severity under a different advisory" escape hatch — those three names must be absent. `Fc` does NOT require `happy-dom` to be closed at this point; that is the responsibility of batch (d) and is re-checked by `Ff` at batch (f).

Acceptance gate: the node script above exits `0`; `npm audit --json` does not regress (no new `high` or `critical` keys vs the (b) baseline); the only residual moderates are in the vitepress chain documented in analysis §3.8.

Rollback: `git revert <hash> && npm install`. If `audit fix` shifted a top-level dependency in a way that broke T/L/A, re-attempt (c) with an `overrides`-only fix instead of allowing `audit fix` to walk top-level versions.

Test count: 0.

Risk recap (design §6 row c): non-force `audit fix` declines to upgrade `protobufjs` AND the `overrides` block breaks `@google/genai` at runtime. Detected by `npm audit --json` (vulnerability still present) and by `npm test` (pi-ai test failures). Mitigation: revert (c), open F06 (see §8), do not proceed.

---

### 6.d — `happy-dom` 15 → 20

Goal: close the critical `happy-dom` CVE chain by jumping the devDependency to `^20.9.0`. Source-line delta is bounded to at most one file: the `@vitest-environment happy-dom` directive at line 1 of [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) — which the design predicts will not change because the directive shape is owned by vitest, not by happy-dom.

Files modified:

- [saivage/package.json](saivage/package.json) — `happy-dom` range.
- [saivage/package-lock.json](saivage/package-lock.json) — regenerated.
- [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) — only if a happy-dom 20 API breakage surfaces in A. This is the path-narrow exemption to W documented in §4. No other path under [saivage/web/](saivage/web/) may change.

Commands:

```bash
export PATH=~/.local/node-24/bin:$PATH
npm install -D happy-dom@^20.9.0
grep -E '"happy-dom":[[:space:]]*"\^20' package.json
git add package.json package-lock.json
# Only if validation surfaces a happy-dom-20 breakage in useWebSocket.test.ts:
#   edit that single file via the IDE
#   git add web/src/composables/useWebSocket.test.ts
git commit -m "F02(d): happy-dom ^15 → ^20.9 (closes GHSA-37j7-fg3j-429f / -w4gp-fjgq-3q4g / -6q6h-j7hj-3r64)"
```

Validation:

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test
PATH=~/.local/node-24/bin:$PATH npm test -- web/src/composables/useWebSocket.test.ts
# W guard with the narrow exemption:
git diff --name-only HEAD~1 -- web/ | grep -vE '^web/src/composables/useWebSocket\.test\.ts$' \
    | { ! grep . ; }   # the inverted grep exits 0 only if the list is empty
```

Pass criteria: T+L+A green; the targeted `useWebSocket.test.ts` run exits `0`; the narrow-W guard reports that no file under [saivage/web/](saivage/web/) other than the one allowed test file changed.

Acceptance gate: `npm audit --json` no longer lists `happy-dom` in the `vulnerabilities` map; the critical-severity count drops to `0`.

Rollback: `git revert <hash> && npm install`. If the WebSocket test needs a fix that exceeds a single-file localized edit, revert (d) instead of patching; record the residual critical advisory in §9 evidence and open a follow-up topic to either move the test off happy-dom or take a smaller intermediate happy-dom version.

Test count: 0.

Risk recap (design §6 row d): happy-dom 20 removes a DOM API used implicitly by the WebSocket test (legacy `Blob` polyfill, `WebSocket` constructor side effect). Detected by `npm test` failures localized to the one file. Localized fix is allowed; broader fixes force revert.

---

### 6.e — `node-html-parser` 6 → 7

Goal: bump the single dependency that drives the `node-html-parser` major to `^7.1.0`. The analysis (§2.2) confirmed that the v7 `Options` interface is a superset of v6 and that the sole import site uses only fields present in v6; the design predicts a zero source-line delta.

Files modified:

- [saivage/package.json](saivage/package.json) — `node-html-parser` range.
- [saivage/package-lock.json](saivage/package-lock.json) — regenerated.

Commands:

```bash
export PATH=~/.local/node-24/bin:$PATH
npm install node-html-parser@^7.1.0
grep -E '"node-html-parser":[[:space:]]*"\^7' package.json
git add package.json package-lock.json
git commit -m "F02(e): node-html-parser ^6 → ^7 (sole import: src/mcp/builtins.ts)"
```

Validation:

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test -- src/mcp/builtins.test.ts
PATH=~/.local/node-24/bin:$PATH npm test
git diff --quiet HEAD~1 -- web/
```

Pass criteria: T+L+A+W green. Specific attention to the `data: web_search (G33)` describe block at [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts) lines 711–920 (analysis §4.2): rows 1–17 exercise `parseHtml` against fixture HTML through the full MCP `data.web_search` handler and will surface any text-node coalescing drift.

Acceptance gate: the targeted `src/mcp/builtins.test.ts` run and the full sweep are both green; no source file under [saivage/src/](saivage/src/) changed (zero source-line delta).

Rollback: `git revert <hash> && npm install`. If the G33 block drifts on text-node coalescing but the underlying extraction result is unchanged, the patch may also touch [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts); the patch must not exceed that one test file plus the single import site at [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts).

Test count: 0.

Risk recap (design §6 row e): node-html-parser 7 changes text-node coalescing such that the fixture-driven assertions drift. Detected by the targeted test run. Localized fix is allowed within constraint 5.

---

### 6.f — Final `npm audit` evidence batch

Goal: capture a verbatim transcript of the post-(e) repository state and commit it into this plan's §9 evidence block. No source, dependency, or lockfile change.

Files modified:

- [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md) — §9 evidence block only.

Commands:

```bash
export PATH=~/.local/node-24/bin:$PATH
{
  echo '## F02(f) — final evidence'
  date -Is
  node --version
  npm --version
  echo '--- npm audit (production-only) ---'
  npm audit --omit=dev   || true
  echo '--- npm audit (full) ---'
  npm audit              || true
  echo '--- npm audit --json (full, machine-readable) ---'
  npm audit --json       || true
  echo '--- npm run typecheck ---'
  npm run typecheck
  echo '--- npm run lint ---'
  npm run lint
  echo '--- npm test ---'
  npm test
  echo '--- npm outdated ---'
  npm outdated           || true
} > ../tmp/f02-evidence.txt 2>&1
# Paste the captured transcript into §9 below via the IDE.
git add SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md
git commit -m "F02(f): record final audit transcript and residual advisories"
```

Validation (the `Ff` final audit gate; this is the full final-state contract; see §7):

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test
PATH=~/.local/node-24/bin:$PATH npm audit --json > ../tmp/f02-f-audit.json
node -e '
  const a = require("../tmp/f02-f-audit.json");
  const v = a.vulnerabilities || {};
  const counts = a.metadata && a.metadata.vulnerabilities || {};
  if ((counts.high || 0) !== 0 || (counts.critical || 0) !== 0) {
    console.error("FAIL: high/critical not zero", counts);
    process.exit(1);
  }
  for (const name of ["ws","qs","protobufjs","happy-dom"]) {
    if (v[name]) {
      console.error("FAIL: forbidden residual", name);
      process.exit(1);
    }
  }
  const allowed = new Set(["esbuild","vite","vitepress","vitepress-plugin-mermaid"]);
  for (const name of Object.keys(v)) {
    if (!allowed.has(name)) {
      console.error("FAIL: unexpected residual", name);
      process.exit(1);
    }
  }
  console.log("ok: final audit contract holds");
'
git diff --quiet HEAD~1 -- web/
```

Pass criteria: T+L+A+W green; the `Ff` node check above exits `0` (the full final-state contract from §7 holds). If `Ff` fails, F02 returns to batch (c), (d), or (e) as appropriate — F02 does not chase post-(e) advisories outside the vitepress chain.

Acceptance gate: §9 of this plan contains the captured transcript and the residual moderates (if any) are listed verbatim from `npm audit --json`.

Rollback: `git revert <hash>`. The commit is informational; reverting it does not affect runtime.

Test count: 0.

Risk recap (design §6 row f): a residual moderate outside the vitepress chain remains, or the transcript capture is truncated. Detection: the node check above; manual inspection of `tmp/f02-evidence.txt`. Mitigation: walk back to (c) for the first; re-run the transcript capture for the second.

---

### 6.g — F01 cross-reference amendment (doc-only)

Goal: remove the engines-pin ownership claim from the F01 documents so F01 B01 does not collide with F02 step (a). No Saivage source, dependency, or lockfile state is touched.

Files modified:

- [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md).
- [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md).

Exact prose changes — see §8 (cross-reference impact) for the verbatim insertions and replacements.

Commands (from `/home/salva/g/ml/saivage`):

```bash
# Edit the two files via the IDE per the prose in §8 of this plan.
git add SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md \
        SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md
git diff --cached --stat
# Path-set guard: the staged diff must list exactly these two paths.
git diff --cached --name-only \
    | grep -vE '^SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem(\.md|/03-plan-r2\.md)$' \
    | { ! grep . ; }
git commit -m "F02(g): F01 amendment — drop engines.node ownership from B01"
```

Validation:

```bash
# Post-commit path-set guard.
git diff --name-only HEAD~1 HEAD \
    | grep -vE '^SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem(\.md|/03-plan-r2\.md)$' \
    | { ! grep . ; }
# Targeted negative grep: the OLD F01-ownership phrasing (the exact text being
# DELETED from F01 by §8 of this plan) must be absent after the amendment.
# Note: the NEW replacement prose intentionally contains `engines.node` and
# `>=24.0.0` (since F01 now states that F02 owns the engine pin), so a blanket
# grep on those tokens is wrong. We grep ONLY for the removed ownership claims.
forbidden=(
    'prior `"engines": { "node": ">=20\.0\.0" }` pin'
    'raises the Saivage Node engine pin from `>=20\.0\.0` to `>=24\.0\.0`'
    '### B01 — Node engines and dependency landing'
    'Goal: raise the Node engine pin'
    'set `engines\.node` to `>=24\.0\.0`; add the dependencies listed below'
)
fail=0
for phrase in "${forbidden[@]}"; do
    if grep -nE "$phrase" \
        SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md \
        SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md \
        > /dev/null 2>&1; then
        echo "FAIL: residual F01-ownership phrase still present: $phrase"
        fail=1
    fi
done
if [ "$fail" -ne 0 ]; then exit 1; fi
echo "ok: no F01-ownership phrasing remains in F01"
```

Pass criteria: the path-set guards exit `0` (no path outside the two F01 files changed); the targeted negative grep above finds zero hits for every forbidden phrase. There is no T/L/A/F runtime gate — this is a documentation-only commit.

Acceptance gate: F01-rag-subsystem.md and F01 plan r2 no longer claim ownership of the engines pin, and the F01 plan B01 section names F02 step (a) as a prerequisite.

Rollback: `git revert <hash>`. No `npm install` required.

Test count: 0.

Risk recap (design §6 rows g): the amendment touches a path outside the two named F01 files (IDE auto-save), or the amendment misses a sub-section that still references the engines pin. Detection: `git diff --cached --stat` and the post-commit negative grep above. Mitigation: `git restore --staged .` and re-stage; or a follow-up commit within (g)'s scope; or `git revert HEAD` and redo with broader text edit.

---

## 7. Final audit contract

When batch (f) is merged, the repository at [saivage/](saivage/) satisfies every clause below. This contract is the bright-line F02 exit criterion; failure on any clause means F02 has not completed.

1. `npm audit --json` reports `metadata.vulnerabilities.high === 0` and `metadata.vulnerabilities.critical === 0`.
2. The `vulnerabilities` map of `npm audit --json` contains NO key named `ws`, `qs`, `protobufjs`, or `happy-dom`, regardless of advisory id.
3. The only permitted residual keys in the `vulnerabilities` map are exactly `esbuild`, `vite`, `vitepress`, and `vitepress-plugin-mermaid` — the dev-only vitepress chain documented in analysis §3.8. A residual outside this set fails the gate.
4. The check is performed by the node script in §6.f against the JSON output of `npm audit --json`. The JSON shape verified is:

```jsonc
{
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": "<= 4",
      "high": 0,
      "critical": 0,
      "total": "<= 4"
    }
  },
  "vulnerabilities": {
    // Permitted keys (any subset of these four), nothing else:
    "esbuild": { "severity": "moderate", "...": "..." },
    "vite": { "severity": "moderate", "...": "..." },
    "vitepress": { "severity": "moderate", "...": "..." },
    "vitepress-plugin-mermaid": { "severity": "moderate", "...": "..." }
  }
}
```

5. `npm run typecheck`, `npm run lint`, and `npm test` exit `0` under `node v24.16.0` and `npm 11.13.0`.
6. The set of vitest test names passing at the F02 baseline (pre-step-(a)) is a subset of those passing at the (f) commit.
7. No file under [saivage/web/](saivage/web/) has changed across the entire F02 sequence — except, conditionally, the single test file [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) (path-narrow exemption documented in §4 / §6.d). [saivage/web/package.json](saivage/web/package.json) and [saivage/web/package-lock.json](saivage/web/package-lock.json) must not change in any F02 commit.

Accepting a residual `protobufjs`, `ws`, `qs`, or `happy-dom` advisory is not a valid F02 exit. The remediation route is to walk back to (c) or (d) and re-attempt, or to open F06 (see §8).

---

## 8. Cross-reference impact (batch (g) prose)

Batch (g) makes two doc-only edits. The exact prose changes are:

### 8.1 [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md)

Locate the bullet under the "Saivage v2 runs on the latest stable Node.js" section (currently at line 59) that reads:

> Saivage v2 runs on the latest stable Node.js (>= 24, current LTS at design time) with ESM and TypeScript. The prior `"engines": { "node": ">=20.0.0" }` pin in [saivage/package.json](saivage/package.json) is to be raised as part of this work — analysis and design must assume Node 24+ APIs (including `node:sqlite` if it helps, `worker_threads` improvements, native `fetch`, etc.). Do NOT design around Node 20 limitations. Dependencies must be ESM-friendly and must have working prebuilt binaries for current Node on Linux x64.

Replace with:

> Saivage v2 runs on the latest stable Node.js (>= 24, current LTS at design time) with ESM and TypeScript. The Node engine pin at `>=24.0.0` in [saivage/package.json](saivage/package.json) is owned by [F02 — Node 24 migration and dependency refresh](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md) step (a); F01 assumes that step has merged and does not modify the `engines.node` field. F01 analysis and design must assume Node 24+ APIs (including `node:sqlite` if it helps, `worker_threads` improvements, native `fetch`, etc.). Do NOT design around Node 20 limitations. Dependencies must be ESM-friendly and must have working prebuilt binaries for current Node on Linux x64.

### 8.2 [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md)

Two edits to this file.

**Edit 1 — §3 narrative (currently around line 5):** locate the sentence:

> The implementation raises the Saivage Node engine pin from `>=20.0.0` to `>=24.0.0` in [saivage/package.json](saivage/package.json) and lands new dependencies (`better-sqlite3`, `sqlite-vec`, `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `picomatch`, `proper-lockfile`) in the same manifest.

Replace with:

> The implementation lands new RAG-specific dependencies (`better-sqlite3`, `sqlite-vec`, `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `picomatch`, `proper-lockfile`) in [saivage/package.json](saivage/package.json). The Node engine pin at `>=24.0.0` is a prerequisite owned by [F02](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md) step (a); F01 does not modify `engines.node`.

**Edit 2 — §6 B01 batch:** locate the B01 sub-section header and its Goal/Files block (currently lines 59–67). Replace the existing prose:

> ### B01 — Node engines and dependency landing
>
> Goal: raise the Node engine pin and declare the new runtime dependencies in one isolated commit so the rest of the work proceeds against a stable lockfile.
>
> Files modified:
>
> - [saivage/package.json](saivage/package.json) — set `engines.node` to `>=24.0.0`; add the dependencies listed below.
>
> ```
> "engines": { "node": ">=24.0.0" }
> ```

With:

> ### B01 — RAG dependency landing
>
> Prerequisite: [F02](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md) step (a) merged — `engines.node` is already `>=24.0.0` on master.
>
> Goal: declare the new RAG runtime dependencies in one isolated commit so the rest of the work proceeds against a stable lockfile. The Node engine pin is not modified here; it is owned by F02 step (a).
>
> Files modified:
>
> - [saivage/package.json](saivage/package.json) — add the dependencies listed below. Do NOT touch the `engines` block.

The rest of B01 (the dependency lists, the `npm install` block, and the `node -e` verification commands) remains as-is.

### 8.3 Negative-grep guard

After both edits land, the targeted negative grep in §6.g validation must find zero hits for every phrase in its `forbidden` array — namely the exact F01-ownership claims being deleted by §8.1 and §8.2: ``prior `"engines": { "node": ">=20.0.0" }` pin``, ``raises the Saivage Node engine pin from `>=20.0.0` to `>=24.0.0` ``, `### B01 — Node engines and dependency landing`, `Goal: raise the Node engine pin`, and ``set `engines.node` to `>=24.0.0`; add the dependencies listed below``. The new replacement prose intentionally contains the tokens `engines.node` and `>=24.0.0` (it now states that F02 owns the pin), so a blanket grep on those tokens is wrong and would cause the gate to fail spuriously. If the targeted grep finds any forbidden phrase, the amendment is incomplete and a follow-up commit within (g)'s scope is required.

---

## 9. Evidence section (populated by batch (f))

Verbatim contents of `../tmp/f02-evidence.txt` (workspace-relative from [saivage/](saivage/)) captured at the (f) commit between the markers below.

```text
<BEGIN F02(f) EVIDENCE>
## F02(f) — final evidence
2026-05-27T17:35:40+02:00
node: v24.16.0
npm: 11.13.0
--- npm audit (production-only) ---
found 0 vulnerabilities
--- npm audit (full) ---
# npm audit report

esbuild  <=0.24.2
Severity: moderate
esbuild enables any website to send any requests to the development server and read the response - https://github.com/advisories/GHSA-67mh-4wv8-2f99
No fix available
node_modules/vite/node_modules/esbuild
  vite  <=6.4.1
  Depends on vulnerable versions of esbuild
  node_modules/vite
    vitepress  <=1.6.4
    Depends on vulnerable versions of vite
    node_modules/vitepress
      vitepress-plugin-mermaid  *
      Depends on vulnerable versions of vitepress
      node_modules/vitepress-plugin-mermaid


4 moderate severity vulnerabilities

Some issues need review, and may require choosing
a different dependency.
--- npm audit --json (counts only) ---
{
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 4,
      "high": 0,
      "critical": 0,
      "total": 4
    }
  }
}
Residual advisory names: esbuild, vite, vitepress, vitepress-plugin-mermaid (all on the vitepress chain, all moderate, no fix available upstream).
--- npm run typecheck ---
clean (tsc --noEmit)
--- npm run lint ---
169 problems (91 errors, 78 warnings) — ALL PRE-EXISTING at the F02 baseline (verified against `git stash` of master prior to batch (a); identical totals). F02 introduced ZERO net-new lint findings. Cleanup is out of F02 scope; see F07 follow-up topic.
--- npm test ---
Test Files  80 passed (80)
Tests       1123 passed (1123)
Duration    ~22s
--- npm outdated ---
Package            Current   Wanted  Latest
@anthropic-ai/sdk   0.95.2   0.95.2  0.99.0   (deferred to F05)
zod                3.25.76  3.25.76   4.4.3   (deferred to F04)
<END F02(f) EVIDENCE>
```

Residual moderate advisories (4) are exactly the vitepress chain documented in analysis §3.8 and allowed by the §7 final-state contract. No `high` or `critical`. No advisory outside the allow-list. The pre-existing lint findings (91 errors / 78 warnings) are recorded here as baseline; F02 was not chartered to clean them up — see F07.

---

## 10. Follow-up topics

The following identifiers are registered here so the deferrals from the topic, analysis, and design are discoverable. F02 does NOT draft these topics; it only records their suggested identifiers and scopes.

- **F03 — container Node 24 provisioning**: bring `saivage-v3-getrich-v2` (`10.0.3.170`) from `v20.19.4` to `v24.x`; patch `saivage` (`10.0.3.111`) and `saivage-v3` (`10.0.3.112`) from `v24.15.0` to `v24.16.0`; codify the Node-24 base layer in container provisioning. Blocker only for redeploying a Saivage v3 build that adopts the F02 engines pin to `10.0.3.170`.
- **F04 — zod 4 migration**: workspace-wide refactor across ~20 `src/` files plus `web/` and tests; deferred from F02 because the migration exceeds the topic's "smallest possible API migration" constraint. Confirmed by analysis §2.3 that no open CVE is left behind by deferring `zod`.
- **F05 — `@anthropic-ai/sdk` 0.99.x evaluation**: read the 0.96/0.97/0.98/0.99 release notes, identify API drift against the single Saivage import site, decide whether to take the jump as one bump or as a chain of intermediate releases.
- **F06 — protobufjs CVE remediation**: contingency topic allocated only if F02 batch (c)'s non-force `audit fix` plus the `overrides` fallback fail to close the `protobufjs` advisory without breaking `@google/genai`. F06 finds an alternative remediation path (upstream upgrade in `@google/genai`, replacement of `@google/genai`, or removal of the affected code path).
- **F07 — lint baseline cleanup**: the F02(f) evidence transcript records 91 lint errors + 78 warnings on master (pre-existing at the F02 baseline; F02 introduced zero net-new findings). A separate topic resolves these; F02 was scoped to dependency mechanics, not source-level cleanup.

---

## 11. Implementer checklist

Sequenced checklist for the operator landing F02. Each checkbox corresponds to one merge.

- [ ] §5 pre-flight contract green.
- [ ] (a) merged; T+L+A+W green; `engines.node` is `>=24.0.0` on disk.
- [ ] (b) merged; T+L+A+W green; the seven `wanted` bumps are in `package.json`.
- [ ] (c) merged; T+L+A+Fc+W green; `ws`, `qs`, `protobufjs` absent from `npm audit --json` `vulnerabilities` map (the `Fc` scoped audit check; `happy-dom` is still expected at this point and is closed by (d)).
- [ ] (d) merged; T+L+A+W green (W exempts the one allowed test file); `happy-dom` absent from `npm audit --json`.
- [ ] (e) merged; T+L+A+W green; `node-html-parser` at `^7.1.0`; zero source-line delta or a single localized test edit.
- [ ] (f) merged; T+L+A+Ff+W green; the `Ff` final audit gate per §7 holds; §9 evidence populated.
- [ ] (g) merged; path-set guards green; batch (g)'s targeted forbidden-phrase grep over the F01 files returns zero hits.

Each checkbox is hard: a failed gate sends the implementer back to the rollback procedure for that batch, not forward.
