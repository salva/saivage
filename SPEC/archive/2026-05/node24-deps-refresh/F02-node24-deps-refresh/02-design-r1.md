# F02 — Node 24 migration and dependency refresh: design

Topic: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md).
Binding analysis: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md).

A single proposal is presented. F02 is a sequencing-and-risk strategy, not an architectural choice; the analysis fixes the per-dependency targets and the CVE remediation routes. This document specifies the order in which those upgrades land, the gate that each step must pass before the next one starts, the containerization boundary, the impact on adjacent feature topics, and the per-step risk matrix.

All shell commands in this document are runnable from [saivage/](saivage/) with `PATH=~/.local/node-24/bin:$PATH` (`node v24.16.0`, `npm 11.13.0`). Commands intended to be run from a different working directory carry an explicit `# from <dir>` comment.

---

## 1. Sequencing strategy

### 1.1 Step list

The work is decomposed into seven sequential steps. Each step is a single commit on the master branch; rollback for any step is `git revert <hash>` followed by `npm install` on the parent commit.

| Step | Title | Touches | Single-commit revert |
| --- | --- | --- | --- |
| a | Engine pin + lockfile re-baseline under Node 24 | `package.json` (engines field only), `package-lock.json` | yes |
| b | Safe minor/patch `wanted` bumps | `package.json`, `package-lock.json` | yes |
| c | Transitive-CVE remediation via `npm audit fix` (no `--force`) | `package-lock.json` only (plus an `overrides` block in `package.json` if the fallback in analysis §3.3 fires) | yes |
| d | `happy-dom` 15 → 20 (critical CVE) | `package.json`, `package-lock.json`, and at most the `@vitest-environment` directive in [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) | yes |
| e | `node-html-parser` 6 → 7 | `package.json`, `package-lock.json` (per analysis §2.2, zero source-line delta expected) | yes |
| f | `@anthropic-ai/sdk` 0.95.1 → 0.99.0 | `package.json`, `package-lock.json`, plus any minimal call-site change required by the 0.95 → 0.99 API drift in the single importing file under [saivage/src/](saivage/src) | yes |
| g | Final audit + residual record | no source/dependency change; this commit adds the verbatim `npm audit` transcript and the validation evidence to the plan's evidence section | yes |

### 1.2 Why this order

1. **Step (a) first — engine pin + lockfile re-baseline.** The engines field is the gate that every later step is validated against. Pinning `>=24.0.0` and regenerating `package-lock.json` under Node 24 / npm 11 produces the canonical lockfile that step (b)–(f) will modify. If any dependency in the existing lockfile is incompatible with Node 24's npm 11, this step surfaces it in isolation — with zero dependency-version changes to confuse the diagnosis.
2. **Step (b) before (c).** The `npm outdated` `wanted` column lists upgrades that are inside the existing semver ranges. Taking them before `npm audit fix` means audit-fix runs against the freshest set of compatible direct versions, which minimizes the chance of `audit fix` reverting a `wanted` bump or vice versa.
3. **Step (c) before (d).** The transitive-CVE remediation moves `ws`, `qs`, `protobufjs` and (if the non-force path declines) any `overrides` for `protobufjs`. Running `audit fix` before the major-version bumps isolates lock-file churn caused by audit-fix from lock-file churn caused by a major upgrade, which makes the diffs reviewable.
4. **Step (d) before (e), (f).** `happy-dom` is the only critical CVE on the board. Landing it as early as possible after the safe bumps minimizes the window in which the master branch carries a critical advisory.
5. **Step (e) before (f).** `node-html-parser` 6 → 7 is the lower-impact major: single import site, options surface confirmed as a superset of v6 (analysis §2.2), zero source-line delta expected. Landing it before the SDK bump keeps the SDK step focused on whatever API drift the SDK actually requires.
6. **Step (f) last among code-touching steps.** `@anthropic-ai/sdk` is still on `0.x`; even patch-suffix releases can drift the public surface. By landing it last, any test failure isolates cleanly to that step without contaminating the prior batches' validation.
7. **Step (g) closes the sequence.** A purely-evidential commit (no source change) makes the final `npm audit` state the artifact that the plan's evidence section references.

### 1.3 Independence of revertability

Each step is independently revertable in the sense that `git revert <step-hash>` restores the state immediately before that step without requiring any later step to be reverted first. This is true even though step (b) lands before step (c): if step (c) turns out to be broken in production, reverting only (c) restores the post-(b) state. Cross-step dependencies are limited to the lockfile being internally consistent, which `npm install` rebuilds from `package.json` after the revert.

Two narrow exceptions:

- Reverting step (a) while keeping any of (b)–(f) is undefined; the later steps assume the engines pin and a Node-24-built lockfile. If step (a) must be reverted, all later steps must be reverted first (LIFO).
- Reverting step (c) (the `overrides` block) is safe to do in isolation; reverting step (d), (e), or (f) is safe in isolation in any order relative to each other.

---

## 2. Step detail

Each step is specified by its preconditions, change set, validation block, and rollback.

### 2.1 Step (a) — engine pin + lockfile re-baseline

Preconditions: working tree clean on `master`; `node --version` reports `v24.16.0`.

Change set:
- [saivage/package.json](saivage/package.json) `engines.node`: `>=20.0.0` → `>=24.0.0`.
- [saivage/package-lock.json](saivage/package-lock.json): regenerated by `npm install` under Node 24 / npm 11. No dependency-version field in `package.json` changes.

Commands:

```bash
PATH=~/.local/node-24/bin:$PATH
node --version              # must report v24.x
npm --version               # must report 11.x
# edit package.json: engines.node = ">=24.0.0"
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
```

Pass criterion: all three commands exit `0`. Rollback: `git revert HEAD && rm -rf node_modules && npm install`.

### 2.2 Step (b) — safe minor/patch `wanted` bumps

Preconditions: step (a) merged; validation green.

Change set: bump each direct dependency to the `wanted` column reported in analysis §1.3. The seven packages are `@types/node`, `eslint`, `grammy`, `openai`, `tsx`, `vitest`. The `@anthropic-ai/sdk` `wanted` bump from `0.95.1` to `0.95.2` is **subsumed by step (f)** (which jumps to `0.99.0`), so it does not appear here.

Commands:

```bash
PATH=~/.local/node-24/bin:$PATH
npm install \
    @types/node@^25.9.1 \
    eslint@^10.4.0 \
    grammy@^1.43.0 \
    openai@^6.39.0 \
    tsx@^4.22.3 \
    vitest@^4.1.7
git add package.json package-lock.json
git commit -m "F02(b): minor/patch bumps (types/node, eslint, grammy, openai, tsx, vitest)"
```

Validation: same three commands as step (a). Pass criterion: all three exit `0`; the set of vitest test names that pass under step (a) must remain a subset of those that pass under step (b). Rollback: `git revert HEAD && npm install`.

### 2.3 Step (c) — `npm audit fix` (no `--force`)

Preconditions: step (b) merged; validation green.

Change set: `npm audit fix` updates the lockfile to upgrade transitive `ws` (8.20.0 → 8.20.1+), `qs` (6.15.1 → 6.15.2+), and `protobufjs` (7.5.7 → 7.5.8+). If the non-force run reports that `protobufjs` cannot be upgraded under the `@google/genai` peer range (analysis §3.3), add an `overrides` block to [saivage/package.json](saivage/package.json):

```jsonc
"overrides": { "protobufjs": "^7.5.8" }
```

then rerun `npm install`.

Commands:

```bash
PATH=~/.local/node-24/bin:$PATH
npm audit fix                    # non-force; lockfile-only by default
# If protobufjs is still vulnerable in `npm audit` output:
#   1. edit package.json, add the overrides block above
#   2. npm install
git add package.json package-lock.json
git commit -m "F02(c): npm audit fix (ws, qs, protobufjs); overrides protobufjs if required"
```

Validation:

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test
PATH=~/.local/node-24/bin:$PATH npm audit --omit=dev    # informational
```

Pass criterion: typecheck, lint, and test exit `0`; `npm audit` reports that `ws`, `qs`, and `protobufjs` no longer appear (or, if they still appear under a different advisory, that the count of advisories has not grown). Rollback: `git revert HEAD && npm install`.

### 2.4 Step (d) — `happy-dom` 15 → 20

Preconditions: step (c) merged; validation green.

Change set:
- `happy-dom` devDependency: `^15.11.7` → `^20.9.0`.
- At most: the `@vitest-environment happy-dom` directive at line 1 of [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts), if the directive syntax changed between happy-dom 15 and 20 (analysis §2.1 confirms only the runtime semantics change; the directive shape is owned by vitest, not by happy-dom, and is therefore unchanged).

Commands:

```bash
PATH=~/.local/node-24/bin:$PATH
npm install -D happy-dom@^20.9.0
git add package.json package-lock.json
# Only if the WebSocket test surfaces a happy-dom 16+ API breakage:
#   edit web/src/composables/useWebSocket.test.ts to use the v20 shim
#   git add web/src/composables/useWebSocket.test.ts
git commit -m "F02(d): happy-dom ^15 → ^20.9 (closes GHSA-37j7-fg3j-429f / -w4gp-fjgq-3q4g / -6q6h-j7hj-3r64)"
```

Validation:

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test
PATH=~/.local/node-24/bin:$PATH npm test -- web/src/composables/useWebSocket.test.ts
```

Pass criterion: all four commands exit `0`. The targeted test run is a redundant smoke; if the full sweep is green the targeted run will also be green. Rollback: `git revert HEAD && npm install`.

### 2.5 Step (e) — `node-html-parser` 6 → 7

Preconditions: step (d) merged; validation green.

Change set: `node-html-parser` dependency `^6.1.13` → `^7.1.0`. Per analysis §2.2, the v7 `Options` interface is a superset of v6 and the single call site at [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts) lines 210–214 uses only fields present in v6. Zero source-line delta expected.

Commands:

```bash
PATH=~/.local/node-24/bin:$PATH
npm install node-html-parser@^7.1.0
git add package.json package-lock.json
git commit -m "F02(e): node-html-parser ^6 → ^7 (sole import: src/mcp/builtins.ts)"
```

Validation:

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test -- src/mcp/builtins.test.ts
PATH=~/.local/node-24/bin:$PATH npm test
```

Pass criterion: all four commands exit `0`. Special attention to the `data: web_search (G33)` describe block at [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts) lines 711–920 (analysis §4.2): rows 1–17 exercise `parseHtml` against fixture HTML and through the full MCP `data.web_search` handler, and they will surface any text-node coalescing diff (analysis open question 1). Rollback: `git revert HEAD && npm install`.

### 2.6 Step (f) — `@anthropic-ai/sdk` 0.95.1 → 0.99.0

Preconditions: step (e) merged; validation green.

The analysis recorded this jump as **open question 2** and recommended the conservative `0.95.1 → 0.95.2` (wanted) path. This design takes the more aggressive `0.95.1 → 0.99.0` jump because:

- Both versions are in `0.x`, where every release is permitted to break the API surface; a `0.95 → 0.99` jump is therefore not categorically more dangerous than a `0.95.1 → 0.95.2` jump.
- The Saivage import surface is a single source file. The blast radius of a `0.99.0` regression is the same as a `0.95.2` regression: one file's worth of compile/lint/test signal.
- Landing the larger jump now defers the inevitable `0.95 → 0.99` follow-up; choosing the conservative path would force a duplicate review-and-validation cycle later for no incremental safety.

If the validation gate fails on step (f), the rollback path is the standard `git revert HEAD`. The fallback — taking only the `0.95.2` wanted bump — is recorded as a contingency, not the default.

Commands:

```bash
PATH=~/.local/node-24/bin:$PATH
npm install @anthropic-ai/sdk@^0.99.0
# Run typecheck immediately to surface any API drift in the sole import site:
PATH=~/.local/node-24/bin:$PATH npm run typecheck
# If typecheck fails, inspect the diff between 0.95 and 0.99 release notes and
# patch the single importing file under src/ accordingly. If the patch exceeds
# ~10 lines or touches more than one file, revert and fall back to ^0.95.2.
git add package.json package-lock.json
# Only if a code patch was required:
#   git add <the-one-file>
git commit -m "F02(f): @anthropic-ai/sdk ^0.95 → ^0.99 (single import site, validated)"
```

Validation:

```bash
PATH=~/.local/node-24/bin:$PATH npm run typecheck
PATH=~/.local/node-24/bin:$PATH npm run lint
PATH=~/.local/node-24/bin:$PATH npm test
```

Pass criterion: all three commands exit `0`. If the patch needed to keep the single import site compiling exceeds approximately ten lines or grows to more than one file, the change has overshot the "smallest possible API migration" guardrail in the topic's constraint 5; in that case, revert and re-land as `^0.95.2` (the wanted bump). Rollback: `git revert HEAD && npm install`.

### 2.7 Step (g) — final audit + residuals

Preconditions: step (f) merged; validation green.

Change set: no `package.json` or `package-lock.json` edit. This step appends to the plan's evidence section the verbatim transcripts of:

- `node --version` and `npm --version`.
- `npm audit` (production-only and full).
- `npm run typecheck`, `npm run lint`, `npm test`.
- `npm outdated` (to record any new `wanted`/`latest` drift that arose during the sequence).
- The container Node-version probe (analysis §6.2).

Commands:

```bash
PATH=~/.local/node-24/bin:$PATH
{
  echo '## F02(g) — final evidence'
  date -Is
  node --version
  npm --version
  npm audit --omit=dev   || true
  npm audit              || true
  npm run typecheck
  npm run lint
  npm test
  npm outdated           || true
} > /home/salva/g/ml/tmp/f02-evidence.txt 2>&1
# Copy the captured transcript into the plan's evidence section.
git add SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-*.md
git commit -m "F02(g): record final audit transcript and residual advisories"
```

Pass criterion: `npm audit` reports `0 critical, 0 high, ≤4 moderate` and the residual moderates are all in the `esbuild → vite → vitepress → vitepress-plugin-mermaid` chain (analysis §3.8). Any non-vitepress residual moderate fails the gate and forces a return to step (c) or earlier. Rollback: `git revert HEAD` (purely informational; reverting (g) does not affect runtime).

---

## 3. Gating: per-step proceed / roll-back thresholds

The same three-command core (`typecheck`, `lint`, `test`) gates every step. The thresholds are uniform:

| Threshold | Definition |
| --- | --- |
| **Proceed** | `npm run typecheck` exits `0`; `npm run lint` exits `0`; `npm test` exits `0`; the set of test names that passed at the parent commit is a subset of those that pass at the current commit. |
| **Investigate** | Any of the three commands exits non-zero, **or** a test that passed at the parent commit is now failing. Investigation is bounded by constraint 5 of the topic ("smallest possible API migration"): if the fix exceeds a localized, single-file edit, the step is reverted instead of patched. |
| **Roll back** | Investigation cannot localize the fix to a single-file edit consistent with constraint 5, **or** the step has been re-attempted and still fails. Roll back via `git revert <step-hash>` and reopen the step with a narrower change (e.g., fall back to the `wanted` target in step (f) instead of the `latest` target). |

Additional rules:

1. **No new tests in F02.** F02 does not introduce test files. Any test that passes under the pre-step-(a) baseline must continue to pass at every subsequent step; any test that was already failing at the baseline must be recorded in the plan's evidence section, but it does not block any step.
2. **`npm audit` is gated at step (c) and step (g) only.** Steps (a), (b), (d), (e), (f) do not require `npm audit` to be clean; they require `npm audit` to not have grown in count or severity.
3. **Lint warning policy.** The project's `npm run lint` is configured to exit non-zero on errors only. Warnings introduced by `eslint@^10.4.0` (step (b)) are allowed in F02 if and only if they do not block step (b)'s typecheck/test gate. Net-new warnings are recorded in the plan's evidence section.
4. **Web frontend invariance.** [saivage/web/package.json](saivage/web/package.json) and [saivage/web/package-lock.json](saivage/web/package-lock.json) must not change in any F02 step. A guard `git diff --quiet HEAD~1 -- web/package.json web/package-lock.json` after each commit confirms this.

---

## 4. Containerization

F02 does **not** re-provision Node inside any LXC container. The engines-pin change in step (a) is a repository-level contract; deploying a build that honours that contract is the responsibility of the operator and of a separate follow-up topic.

### 4.1 Follow-up topic

A new topic will be opened under [saivage/SPEC/2026-05/](saivage/SPEC/2026-05) with the suggested identifier **F03 — container Node 24 provisioning**. Its scope:

- Bring `saivage-v3-getrich-v2` (`10.0.3.170`) from `v20.19.4` to `v24.x`. This is a redeploy blocker for any Saivage v3 service that adopts the F02 engines pin.
- Bring `saivage` (`10.0.3.111`) and `saivage-v3` (`10.0.3.112`) from `v24.15.0` to the host's `v24.16.0`. This is a routine patch-level update; both containers already satisfy `>=24.0.0` and are non-blocking.
- Codify the Node-24 base layer in the container provisioning script under [tmp/diedrico-container-setup/setup-container.sh](tmp/diedrico-container-setup/setup-container.sh) (and any equivalent the operator chooses to extract).

### 4.2 What F02 records

The F02 plan's non-goals section lists "container Node 24 provisioning" as deferred to F03 and links to it. The F02 plan's prerequisite list (for downstream deploys, not for F02 itself) states: redeploying a Saivage v3 build to `saivage-v3-getrich-v2` after F02 lands requires F03 to have completed on that container.

### 4.3 Container-state snapshot (binding for F02)

Per analysis §6:

```text
10.0.3.111  saivage                  v24.15.0   satisfies >=24.0.0
10.0.3.112  saivage-v3               v24.15.0   satisfies >=24.0.0
10.0.3.170  saivage-v3-getrich-v2    v20.19.4   does NOT satisfy >=24.0.0
```

Saivage v2 does not deploy to `saivage-v3-getrich-v2`. That container hosts Saivage v3 only. F02 therefore lands cleanly on master without forcing an immediate F03; the redeploy gate only fires when a Saivage v3 build that has adopted the engines pin is rolled out to `10.0.3.170`.

---

## 5. Cross-reference impact

### 5.1 F01 — RAG subsystem

[F01 — RAG subsystem](../rag-subsystem-design/F01-rag-subsystem.md) currently owns the Node 24 engines pin inside its first plan batch (B01). Once F02 lands step (a), B01 is reduced to RAG-specific dependency additions only (`better-sqlite3`, `sqlite-vec`, `tree-sitter*`, `picomatch`, `proper-lockfile`, `chokidar`). Without this reduction, F01 B01 and F02 step (a) would conflict on the same field of [saivage/package.json](saivage/package.json).

The F02 plan must therefore include an amendment task that updates two files in the F01 spec:

- [F01-rag-subsystem.md](../rag-subsystem-design/F01-rag-subsystem.md) — the topic file. Strike the sentence that hands the engines pin to F01 B01 (or note that F02 has assumed it).
- [F01 plan, current revision](../rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md) — drop the engines-pin step from B01 and add a "Prerequisite: F02 step (a) merged" line.

The amendment is a single F02 commit, distinct from any of steps (a)–(g), landed at the same time as step (g) or as a follow-up commit attached to (g). It changes only the two F01 markdown files; no Saivage source code or dependency state is touched.

### 5.2 F04 (placeholder) — zod 4 migration

Per analysis §2.3, `zod` is deferred. The F02 plan's non-goals section names the follow-up topic identifier **F04 — zod 4 migration** so the deferral is discoverable. F02 does not draft F04 here.

### 5.3 Web frontend refresh

[saivage/web/](saivage/web) has its own `package.json` and lockfile. F02 does not touch them. A separate topic owns that refresh; the topic identifier is not allocated here.

---

## 6. Risk matrix

The matrix is per step. "Detection" names the command in the validation block that surfaces the failure. "Rollback" names the recovery action.

| Step | Worst-case failure | Detection mechanism | Rollback action |
| --- | --- | --- | --- |
| a | `npm install` under Node 24 / npm 11 fails to resolve the existing dependency tree because an unmaintained transitive declares an `engines.node` upper bound. | `npm install` exits non-zero with `EBADENGINE` listing the offending package. | `git restore package.json package-lock.json && rm -rf node_modules`. Then identify the blocker, decide whether to wait for an upstream release or open a targeted override, and re-attempt step (a). The rest of F02 cannot start until step (a) is green. |
| a | All three of `typecheck`, `lint`, `test` pass under the pure engines-pin commit, but a previously-deduped transitive shifts in the relocked tree and changes runtime behaviour. | `npm test` surfaces a regression that was not present at the parent commit. | `git revert HEAD && rm -rf node_modules && npm install`. Re-run with `npm install --prefer-dedupe` or, if the shifted transitive is identified, pin it via `overrides`. |
| b | A minor in `vitest@^4.1.7`, `eslint@^10.4.0`, `grammy@^1.43.0`, `openai@^6.39.0`, `@types/node@^25.9.1`, or `tsx@^4.22.3` deprecates an API used by the test suite or the LLM client. | `npm run typecheck` (for types/node, eslint, vitest type drift) or `npm test` (for runtime drift in vitest/openai/grammy) exits non-zero. | `git revert HEAD && npm install`. Re-land the bumps one-by-one to identify the offending package, then either pin that one back at its prior `wanted` target or open a follow-up topic for it. |
| c | `npm audit fix` (non-force) declines to upgrade `protobufjs` because of the `@google/genai` peer-range constraint. | `npm audit` after `audit fix` still lists `protobufjs` in the moderate set. | Apply the analysis §3.3 fallback: add `"overrides": { "protobufjs": "^7.5.8" }` to [saivage/package.json](saivage/package.json) and rerun `npm install`. If the override breaks `@google/genai` at runtime (surfaced by `npm test` against the pi-ai-driven paths), revert and accept the residual `protobufjs` advisory with a written justification appended to the plan's evidence. |
| c | `npm audit fix` shifts a top-level dependency to a version that breaks `npm run lint` or `npm test`. | Standard validation block exits non-zero. | `git revert HEAD && npm install`. Re-attempt with an `overrides`-only fix instead of allowing `audit fix` to walk top-level versions. |
| d | `happy-dom@^20.9` removes a DOM API used implicitly by [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) (e.g., the legacy `Blob` polyfill behaviour, or a `WebSocket` constructor side effect). | `npm test` fails inside the `web/src/composables/useWebSocket.test.ts` file specifically. | Localized fix: update the test to use the v20 API. The fix must remain inside the single test file per constraint 5. If it does not, revert and open a follow-up topic to either move the test off happy-dom or to take a smaller intermediate happy-dom version. The critical CVE then remains open; the residual must be recorded. |
| e | `node-html-parser@7` changes text-node coalescing such that the fixture-driven assertions in [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts) rows 1–17 (`data: web_search (G33)` describe block, lines 711–920) drift. | The targeted `npm test -- src/mcp/builtins.test.ts` run fails on those rows. | Adjust the assertions in the test file to the new (still-correct) coalescing behaviour if the underlying extraction result is unchanged; otherwise revert. Constraint 5 caps the patch at the single test file plus the single import site. |
| f | `@anthropic-ai/sdk@^0.99` drifts the request/response shapes used by the single Saivage import site beyond a localized patch. | `npm run typecheck` exits non-zero with errors in the importing file; `npm test` surfaces the runtime regression. | If the patch fits within roughly ten lines in one file, apply it. Otherwise revert and re-land as `^0.95.2` (the conservative `wanted` target). The 0.99 path remains the design's first attempt; the 0.95.2 path is the documented fallback. |
| g | A residual moderate outside the `esbuild → vite → vitepress` chain remains. | `npm audit` lists an unexpected package. | Walk back to step (c). If the new advisory was published between step (c) and step (g), open a follow-up topic; F02 does not chase post-(c) advisories. |
| g | The transcript capture in [tmp/f02-evidence.txt](tmp/f02-evidence.txt) is missing or truncated. | Manual inspection of the file before committing. | Re-run the transcript capture; the step is informational and carries no production risk. |

### 6.1 Cross-cutting risk: VS Code buffer drift on `package.json`

Per workspace memory, VS Code edit buffers can silently revert disk content on long-lived sessions. For every step that edits [saivage/package.json](saivage/package.json), the implementer must verify the on-disk state via a terminal `grep` (or `cat`) before running `npm install` and before committing. Example:

```bash
grep -E '"node":\s*">=24' package.json    # expected after step (a)
```

If the grep does not find the expected line, `git checkout package.json` and redo the edit through the IDE; do not bypass with `cat > package.json`.

---

## 7. End-state contract

When step (g) is merged, the repository at [saivage/](saivage/) satisfies all of the following:

1. [saivage/package.json](saivage/package.json) `engines.node` is `>=24.0.0`.
2. `npm run typecheck`, `npm run lint`, `npm test` exit `0` under `node v24.16.0` / `npm 11`.
3. `npm audit` reports `0 critical, 0 high`, and any remaining moderates are exactly the `esbuild → vite → vitepress → vitepress-plugin-mermaid` chain documented in analysis §3.8.
4. `happy-dom` is at `^20.9.0`; `node-html-parser` is at `^7.1.0`; `@anthropic-ai/sdk` is at `^0.99.0` (or, in the contingency path, `^0.95.2`); `@types/node`, `eslint`, `grammy`, `openai`, `tsx`, `vitest` are at their step-(b) targets.
5. `zod` is unchanged at `^3.25.76`; the deferral and the follow-up topic id `F04` are recorded in the plan's non-goals.
6. [F01-rag-subsystem.md](../rag-subsystem-design/F01-rag-subsystem.md) and [F01 plan](../rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md) no longer claim ownership of the engines pin.
7. The follow-up topic id `F03 — container Node 24 provisioning` is recorded as the owner of cross-container Node-24 rollout.
