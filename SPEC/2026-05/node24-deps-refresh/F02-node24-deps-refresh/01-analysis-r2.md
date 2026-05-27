# F02 — Node 24 migration and dependency refresh: functional analysis

Topic: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md).

Scope of this document: factual decomposition of the upgrade surface for the Saivage v2 codebase at [saivage/](saivage/). Decisions are recorded per dependency, per CVE advisory, and per Node-24 compatibility concern. No design or batching choices are made here.

All measurements were taken on `2026-05-27` from `/home/salva/g/ml/saivage` with Node `v24.16.0` from `~/.local/node-24/bin/node` and `npm` `11.13.0`. Numeric claims are grounded by the commands shown in fenced blocks immediately above them. Every shell command shown is runnable from `/home/salva/g/ml/saivage` with `PATH=~/.local/node-24/bin:$PATH`; commands intended to be run from a different working directory carry an explicit `# from <dir>` comment.

---

## 1. Per-dependency decision table

### 1.1 Inputs

Direct dependencies and devDependencies, from [saivage/package.json](saivage/package.json):

```bash
jq '.dependencies,.devDependencies' package.json
```

Dependencies (14): `@anthropic-ai/sdk`, `@fastify/static`, `@fastify/websocket`, `@mariozechner/pi-ai`, `@modelcontextprotocol/sdk`, `commander`, `fastify`, `grammy`, `he`, `js-tiktoken`, `node-html-parser`, `openai`, `telegramify-markdown`, `zod`.

DevDependencies (17): `@eslint/js`, `@types/node`, `@types/ws`, `eslint`, `happy-dom`, `mermaid`, `tsup`, `tsx`, `typedoc`, `typedoc-plugin-markdown`, `typedoc-vitepress-theme`, `typescript`, `typescript-eslint`, `vitepress`, `vitepress-plugin-mermaid`, `vitest`.

### 1.2 Import-site surface (measured)

The following per-package import counts were obtained with:

```bash
for pkg in <list>; do
  grep -RIl --include='*.ts' --include='*.tsx' \
    -e "from [\"']${pkg}[\"']" \
    -e "from [\"']${pkg}/" src 2>/dev/null | wc -l
done
```

Counts (number of source files under `src/` that import the package directly):

| Package | Files importing |
| --- | --- |
| `@anthropic-ai/sdk` | 1 |
| `@fastify/static` | 1 |
| `@fastify/websocket` | 1 |
| `@mariozechner/pi-ai` | 3 |
| `@modelcontextprotocol/sdk` | 1 |
| `commander` | 1 |
| `fastify` | 2 |
| `grammy` | 1 |
| `he` | 0 |
| `js-tiktoken` | 1 |
| `node-html-parser` | 1 |
| `openai` | 2 |
| `telegramify-markdown` | 1 |
| `zod` | 18 (raised to ~20 by `web/` and tests below) |
| `vitest` | 76 |

Type-only / build-only devDependencies (`@eslint/js`, `@types/node`, `@types/ws`, `eslint`, `happy-dom`, `mermaid`, `tsup`, `tsx`, `typedoc*`, `typescript-eslint`, `vitepress*`) report 0 source-file import sites; they are consumed via tooling configs or directly by other devDependencies, not via `import` from `src/`.

### 1.3 Baseline `npm outdated`

```bash
PATH=~/.local/node-24/bin:$PATH npm outdated
```

```text
Package            Current   Wanted  Latest
@anthropic-ai/sdk   0.95.1   0.95.2  0.99.0
@types/node         25.6.2   25.9.1  25.9.1
eslint              10.3.0   10.4.0  10.4.0
grammy              1.42.0   1.43.0  1.43.0
happy-dom          15.11.7  15.11.7  20.9.0
node-html-parser    6.1.13   6.1.13   7.1.0
openai              6.37.0   6.39.0   6.39.0
tsx                 4.21.0   4.22.3   4.22.3
vitest               4.1.5    4.1.7    4.1.7
zod                3.25.76  3.25.76    4.4.3
```

Packages not listed are at `latest`.

### 1.4 Decision table

Risk classes follow semver: **patch** (no API change expected), **minor** (additive), **major** (breaking).
The CVE column lists only advisories that directly drive a decision; transitive CVEs are handled in §3.

| Package | Current | Target | Risk | CVE driver | Import sites | Migration delta |
| --- | --- | --- | --- | --- | --- | --- |
| `@anthropic-ai/sdk` | `^0.95.1` | `^0.95.2` (wanted) | patch within 0.x | none | [saivage/src](saivage/src) (1 file) | none |
| `@fastify/static` | `^9.1.0` | unchanged (at latest 9.x) | n/a | none | 1 file | none |
| `@fastify/websocket` | `^11.2.0` | unchanged (at latest) | n/a | exposes vulnerable `ws@8.20.0`; remediated via `ws` bump (§3) | 1 file | none |
| `@mariozechner/pi-ai` | `^0.73.1` | unchanged | n/a | pulls vulnerable `protobufjs`, `ws` transitively (§3) | 3 files | none |
| `@modelcontextprotocol/sdk` | `^1.12.1` | unchanged (installed `1.29.0`) | n/a | pulls vulnerable `qs` via `express@5.2.1` (§3) | 1 file | none |
| `commander` | `^14.0.3` | unchanged | n/a | none | 1 file | none |
| `fastify` | `^5.8.4` | unchanged | n/a | none | 2 files | none |
| `grammy` | `^1.42.0` | `^1.43.0` | minor | none | 1 file | none expected (release notes are additive) |
| `he` | `^1.2.0` | unchanged | n/a | none | 0 source imports — separate cleanup task, out of scope for F02 | none |
| `js-tiktoken` | `^1.0.21` | unchanged | n/a | none | 1 file | none |
| `node-html-parser` | `^6.1.13` | `^7.1.0` | **major** | none (decision driven by sole import site simplicity) | 1 file: [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts) | see §2.2 |
| `openai` | `^6.37.0` | `^6.39.0` | minor | none | 2 files | none |
| `telegramify-markdown` | `^1.3.3` | unchanged | n/a | none | 1 file | none |
| `zod` | `^3.25.76` | unchanged (defer to follow-up) | **major** if bumped | none open against 3.x (§2.3) | ≥18 files in `src/`, plus tests and `web/` | deferred (see §2.3) |
| `@eslint/js` | `^10.0.1` | unchanged (at latest) | n/a | none | tooling | none |
| `@types/node` | `^25.6.2` | `^25.9.1` | minor | none; tracks Node 24 surface | tooling | none |
| `@types/ws` | `^8.18.1` | unchanged (at latest) | n/a | none | tooling | none |
| `eslint` | `^10.3.0` | `^10.4.0` | minor | none | tooling | none |
| `happy-dom` | `^15.11.7` | `^20.9.0` | **major** | **critical** GHSA-37j7-fg3j-429f + GHSA-w4gp-fjgq-3q4g + GHSA-6q6h-j7hj-3r64 (§2.1) | 1 test file: [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) | see §2.1 |
| `mermaid` | `^11.15.0` | unchanged (at latest) | n/a | none | docs only | none |
| `tsup` | `^8.4.0` | unchanged (installed 8.5.1) | n/a | none | build tooling | none |
| `tsx` | `^4.21.0` | `^4.22.3` | patch/minor | none | dev runner only | none |
| `typedoc` | `^0.28.19` | unchanged | n/a | none | docs only | none |
| `typedoc-plugin-markdown` | `^4.11.0` | unchanged | n/a | none | docs only | none |
| `typedoc-vitepress-theme` | `^1.1.2` | unchanged | n/a | none | docs only | none |
| `typescript` | `^6.0.3` | unchanged | n/a | none | toolchain | none |
| `typescript-eslint` | `^8.60.0` | unchanged | n/a | none | lint | none |
| `vitepress` | `^1.6.4` | unchanged (no fixed release yet; see §3) | n/a | depends on vulnerable `vite`/`esbuild` (§3) | docs only | none |
| `vitepress-plugin-mermaid` | `^2.0.17` | unchanged | n/a | inherits from `vitepress` | docs only | none |
| `vitest` | `^4.1.5` | `^4.1.7` | patch | none | 76 test files | none |

### 1.5 Aggregate

- Direct upgrades that change a major: 2 — `happy-dom` (CVE-driven, required), `node-html-parser` (opportunistic, decided here).
- Direct upgrades that change a minor or patch: 7 — `@anthropic-ai/sdk`, `@types/node`, `eslint`, `grammy`, `openai`, `tsx`, `vitest`.
- Direct dependencies deferred: 1 — `zod` (§2.3).
- Direct dependencies untouched: 21.

---

## 2. Decisions on visible majors

### 2.1 `happy-dom` 15 → 20 — **REQUIRED**

CVE driver (from `npm audit`):

```text
happy-dom  <=20.8.8
Severity: critical
- GHSA-37j7-fg3j-429f  VM Context Escape → RCE
- GHSA-w4gp-fjgq-3q4g  fetch credentials origin confusion
- GHSA-6q6h-j7hj-3r64  ECMAScriptModuleCompiler unsanitized export interpolation
Fix available: happy-dom@20.9.0 (breaking).
```

Import surface (single test file):

```bash
# from /home/salva/g/ml
grep -RIln "happy-dom" saivage 2>/dev/null \
    | grep -v node_modules | grep -v dist/
```

```text
saivage/SPEC/...                                   # spec/document hits, not code
saivage/web/src/composables/useWebSocket.test.ts   # only runtime user
saivage/package-lock.json
saivage/package.json
```

`useWebSocket.test.ts` selects the happy-dom environment via the `@vitest-environment happy-dom` directive on line 1 of [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts), not via a separate vitest config. The root [saivage/vitest.config.ts](saivage/vitest.config.ts) (lines 11–17) includes `web/src/**/*.test.ts` in the run set but does not declare a default environment. Risk assessment:

- happy-dom 16 removed several legacy DOM behaviours and tightened CSP/cookies; 17–20 introduce further spec-compliance and refactor the VM bridge that fixes the RCE.
- The single Saivage test file exercises `WebSocket` and basic DOM nodes. No usage of `IFrame`, `eval`, `Worker`, or `MutationObserver` shims that are the major-version breakage hot spots.

Decision: bump to `^20.9.0`. Migration delta limited to the test file (if any change is needed at all). No source-code changes expected outside [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts) and the `@vitest-environment` directive at the head of that file.

### 2.2 `node-html-parser` 6 → 7 — **PROCEED**

Sole import site:

```bash
grep -RIn "node-html-parser" --include='*.ts' src
```

```text
src/mcp/builtins.ts:38:import { parse as parseHtml, type HTMLElement } from "node-html-parser";
```

The actual call shape at [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts) lines 210–214 is:

```ts
const root = parseHtml(html, {
  lowerCaseTagName: false,
  comment: false,
  blockTextElements: { script: false, style: false, noscript: false, pre: false },
});
```

Upstream package facts for `node-html-parser@7.1.0` (captured `2026-05-27`):

```bash
PATH=~/.local/node-24/bin:$PATH npm view node-html-parser@7.1.0 main type exports types
```

```text
main  = 'dist/index.js'
types = 'dist/index.d.ts'
```

No `type: "module"`, no `exports` map, no `engines` constraint. The same fields for `6.1.13` are identical (`main = 'dist/index.js'`, `types = 'dist/index.d.ts'`), so v7 is not an ESM-only repackaging — it is a CommonJS dist with TypeScript declarations, same as v6. Direct dependencies of v7 are `{ "css-select": "^5.1.0", "he": "1.2.0" }`.

Type-level option-shape check. The v7 tarball was unpacked to `/tmp/nhp7/package` via `npm pack node-html-parser@7.1.0`, and `package/dist/nodes/html.d.ts` declares the `Options` interface:

```text
export interface Options {
    lowerCaseTagName?: boolean;
    comment?: boolean;
    fixNestedATags?: boolean;
    parseNoneClosedTags?: boolean;
    preserveTagNesting?: boolean;
    blockTextElements: { [tag: string]: boolean; };
    voidTag?: { tags?: string[]; closingSlash?: boolean; };
    closeAllByClosing?: boolean;
}
```

The same interface in the installed v6.1.13 (`saivage/node_modules/node-html-parser/dist/nodes/html.d.ts`) carries `lowerCaseTagName`, `comment`, `blockTextElements`, and `voidTag` with identical signatures; v7 only **adds** the four optional fields `fixNestedATags`, `parseNoneClosedTags`, `preserveTagNesting`, `closeAllByClosing`. The Saivage call site uses only `lowerCaseTagName`, `comment`, and `blockTextElements`, all of which are unchanged.

Conclusion: case (a) — the v7 option shape is compatible with the existing call. Migration delta is zero source-code lines; the bump is a `package.json`/`package-lock.json` change only. The implementer must still run [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts) (rows 1–17 of the `data: web_search (G33)` describe block at lines 711–920) to confirm runtime behaviour against v7.

### 2.3 `zod` 3.25.76 → 4.4.3 — **DEFER**

CVE status (verified against the GitHub Advisory Database via `npm audit` on `2026-05-27`):

- `npm audit` reports no advisory against any installed `zod@3.25.76`. The vulnerability surface is empty for the pinned version. Therefore deferring carries no open CVE risk.

Surface size of a v4 migration (grounded counts in `src/` only):

```bash
grep -RIl "from ['\"]zod['\"]" --include='*.ts' src | wc -l
```

```text
18
```

```bash
grep -RIc "ZodIssueCode\.custom\|ZodTypeAny\|ZodError\|ZodSchema" \
    --include='*.ts' src | grep -v ':0'
```

```text
src/channels/ws-schema.ts:3
src/runtime/shutdown-handoff.ts:2
src/store/documents.ts:4
src/knowledge/eagerLoader.ts:3
src/knowledge/lifecycle.ts:2
src/knowledge/store.ts:3
src/parse-llm-json.ts:2
src/types.ts:5
src/config.ts:2
src/types.test.ts:2
```

10 files in `src/` use v3-specific idioms (`ZodIssueCode.custom`, `ZodTypeAny`, `ZodError`, `ZodSchema`). All four idioms broke or moved in v4:

- `z.ZodIssueCode.custom` → `z.core.$ZodIssueCode` / `z.issueCodes.custom` semantics; `.refine()` callback signature changed.
- `z.ZodTypeAny` → `z.ZodType` (the `Any` alias is removed in v4).
- `z.ZodError` keeps the constructor but `.issues[i].path` is now `(string|number|symbol)[]` and several discriminator-error subclasses were unified.
- `z.ZodSchema` is renamed to `z.ZodType` (alias removed).

In addition, `web/` and the in-repo `dance` schemas at [saivage/SPEC/](saivage/SPEC) (planning data, not application data) consume zod; web/dance migration is not part of F02 either way.

Decision: **defer**. Justification:

1. No CVE is open against `zod@3.25.76`.
2. The 18-file surface plus v4 idiomatic changes exceed the "smallest possible API migration" guardrail from the topic's constraint 5.
3. v4 was released after the `pi-ai` and `MCP SDK` ecosystem stabilized on v3; bumping zod independently risks a multi-day type-error cleanup that is unrelated to Node-24 readiness.

Follow-up topic identifier: **F04 — zod 4 migration** (to be opened against [saivage/SPEC/2026-05/](saivage/SPEC/2026-05) when F02 and F01 are merged). F04 will own the workspace-wide refactor; F02's plan must record this id in non-goals.

---

## 3. Transitive-CVE strategy

Baseline audit (re-measured `2026-05-27` on Node 24.16.0):

```bash
PATH=~/.local/node-24/bin:$PATH npm audit
```

```text
8 vulnerabilities (7 moderate, 1 critical)
```

`happy-dom` is the only critical and is addressed directly in §2.1. The remaining seven moderates are all transitive. Per-advisory analysis:

Parent chains obtained from:

```bash
PATH=~/.local/node-24/bin:$PATH npm ls qs ws protobufjs esbuild vite vitepress
```

### 3.1 `ws` — GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure)

- Installed: `ws@8.20.0` everywhere (deduped).
- Parents: `@fastify/websocket@11.2.0`, `@google/genai@1.52.0` (via `pi-ai`), `@mistralai/mistralai@2.2.1` (via `pi-ai`), `openai@6.26.0` (via `pi-ai`) and `openai@6.37.0` (top-level).
- Advisory range: `8.0.0 – 8.20.0`. Fix available at `8.20.1+` (also `8.21+`).
- `npm audit fix` (non-`--force`) is sufficient — the advisory's `fix available` flag is `true`.

Decision: **`npm audit fix` (non-force).** No top-level change. Residual risk: none.

### 3.2 `qs` — GHSA-q8mj-m7cp-5q26 (DoS via `qs.stringify` comma-format arrays)

- Installed: `qs@6.15.1` via `express@5.2.1` (pulled by `@modelcontextprotocol/sdk@1.29.0` → `body-parser@2.2.2` and `express`).
- Advisory range: `6.11.1 – 6.15.1`. Fix `6.15.2+`.
- `npm audit fix` (non-force) reports a clean upgrade.

Decision: **`npm audit fix` (non-force).** Residual: none.

### 3.3 `protobufjs` — GHSA-jggg-4jg4-v7c6 (DoS via recursive JSON descriptor expansion)

- Installed: `protobufjs@7.5.7` via `@google/genai@1.52.0` (pulled by `pi-ai`).
- Advisory range: `<=7.5.7`. Fix `7.5.8+`.
- `npm audit fix` reports it as fixable without `--force`.

Decision: **`npm audit fix` (non-force).** Residual: none.

If the non-force fix declines to update because `@google/genai` constrains the range, fall back to an `overrides` entry in [saivage/package.json](saivage/package.json):

```jsonc
"overrides": { "protobufjs": "^7.5.8" }
```

### 3.4 `esbuild` — GHSA-67mh-4wv8-2f99 (dev-server SOP bypass)

- Two installed versions:
  - `esbuild@0.27.7` — used by `tsup`, `tsx`, and `vitest`'s `vite@8.0.11`. **Not vulnerable.**
  - `esbuild@0.21.5` — pinned by `vite@5.4.21`, which is pinned by `vitepress@1.6.4`. **Vulnerable.**
- Advisory: `<=0.24.2`. No fix that satisfies the `vite@5.x` range is published in the `vitepress` ecosystem yet; `vitepress` itself has not released a version that pulls `vite@6+`/`esbuild@0.25+`.
- `npm audit fix` reports "No fix available" for this chain.

Options considered:

1. **`overrides`** to force `esbuild@^0.25.0` under `vitepress` → `vite@5.4.21`: `vite@5.4.21` was built against `esbuild@0.21.x`; forcing 0.25+ has been reported to break `vitepress build` due to drop of CJS-side APIs. Not safe to apply blind.
2. **Top-level bump of `vitepress`**: no `vitepress` release yet bundles a non-vulnerable `vite`; the next major (`2.x`) is in pre-release. Adopting a pre-release for docs build violates constraint 5 (no source-feature changes; treat docs build as production-equivalent).
3. **Accept residual risk**: the advisory is a dev-server-only SOP bypass. It is exploitable only against a developer running `vitepress dev` on a network the attacker can reach. CI/CD and shipped runtime do not run `vitepress dev`; only `vitepress build` is run during release, and `vitepress build` does not start the dev server. Production Saivage containers do not run vitepress at all.

Decision: **accept residual risk for `esbuild` (transitive via `vitepress`).** Justification: dev-only, never reachable from the shipped runtime, no upstream fix yet. The plan must record this advisory in its final audit transcript and the choice to accept.

Residual: 1 advisory (`esbuild` via `vitepress` → `vite`).

### 3.5 `vite` — same advisory chain as §3.4

- `vite@5.4.21` is the vulnerable instance under `vitepress`.
- `vite@8.0.11` under `vitest` is current.

Decision: **accept**, tied to §3.4. Same justification (docs build only). Residual: 1 advisory (counted with §3.4 — `npm audit` lists vite and esbuild as separate entries in the same dependency chain).

### 3.6 `vitepress` — depends on vulnerable `vite`

Decision: **accept**, tied to §3.4. Residual: 1 (same chain).

### 3.7 `vitepress-plugin-mermaid` — depends on vulnerable `vitepress`

Decision: **accept**, tied to §3.4. Residual: 1 (same chain).

### 3.8 Aggregate post-remediation expectation

If §3.1–§3.3 land as `npm audit fix` (non-force), and §2.1 lands as `happy-dom@^20.9.0`, the remaining advisories at end of F02 are the four entries in the `esbuild → vite → vitepress → vitepress-plugin-mermaid` chain — counted by `npm audit` as 4 moderates against one underlying root cause (`esbuild`).

Target end-state: **0 critical, 0 high, ≤4 moderate (all dev-only, all in vitepress chain).** This satisfies constraint 3 of the topic ("zero high/critical and ideally zero moderate"); the "ideally" allows the documented residuals.

---

## 4. Validation matrix

For each upgraded direct dependency, identify the code paths exercised by the existing test corpus and any additional manual check.

### 4.1 `happy-dom@^20.9.0`

- Test surface: [saivage/web/src/composables/useWebSocket.test.ts](saivage/web/src/composables/useWebSocket.test.ts). The environment is selected by the `@vitest-environment happy-dom` directive at line 1 of that file. The root [saivage/vitest.config.ts](saivage/vitest.config.ts) lines 11–17 include `web/src/**/*.test.ts` in the run set, so the file is executed by `npm test` without any extra opt-in.
- Exercise: `npm test` runs the full vitest suite; the `useWebSocket` test instantiates a mocked `WebSocket` against a happy-dom window and asserts state transitions and lifecycle hooks.
- Additional check: `npm run build:web` (vite/vue build) does not use happy-dom, so it is unaffected.

### 4.2 `node-html-parser@^7.1.0`

- Code surface: [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts) line 38 (`import { parse as parseHtml, type HTMLElement } from "node-html-parser"`) and the parser call at lines 210–214.
- Test surface: [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts) lines 711–920 — the `data: web_search (G33)` describe block. Rows 1–7 exercise `extractDdgResults` directly against fixture HTML (`web-search.fixture.html`, `.drifted.html`, `.empty.html`); rows 8–17 drive the same parser through the full MCP `data.web_search` handler against a local fixture server. Both groups depend on `parseHtml` returning a tree compatible with the `HTMLElement` querySelector API and on `lowerCaseTagName: false` / `comment: false` / `blockTextElements` honoring the call-site flags.
- Exercise: `npm test -- src/mcp/builtins.test.ts` is the targeted smoke; `npm test` is the full sweep.

### 4.3 `vitest@^4.1.7`

- Surface: all 76 files in `src/` that import vitest.

```bash
grep -RIl --include='*.ts' \
    -e "from ['\"]vitest['\"]" \
    -e "from ['\"]vitest/" src | wc -l
```

```text
76
```

- Exercise: `npm test` is exhaustive by definition.

### 4.4 `eslint@^10.4.0`, `typescript-eslint`, `@eslint/js`

- Exercise: `npm run lint`. Any new rules introduced by 10.4 are surfaced as warnings or errors; constraint 4 of the topic requires they resolve before the batch lands.

### 4.5 `@types/node@^25.9.1`

- Exercise: `npm run typecheck`. Type-only effect; the rest of the suite is unaffected at runtime.

### 4.6 `@anthropic-ai/sdk`, `openai`, `grammy`, `tsx`

- These are minor/patch bumps in non-critical paths (LLM clients, telegram bot, dev runner).
- Exercise: `npm test` plus a manual `npm run dev` smoke is sufficient. The full Saivage harness against an LLM provider is **not** part of F02 validation; it is the operator's separate acceptance step after the host is on Node 24.

### 4.7 Audit assertion

Final batch must capture:

```bash
PATH=~/.local/node-24/bin:$PATH npm audit
```

with output recorded verbatim in the plan's evidence section.

---

## 5. Node 24 compatibility risk surface

### 5.1 Source-level `node:` core module usage

```bash
rg -nP "from\s+[\"']node:[a-z_/]+[\"']|require\(\s*[\"']node:[a-z_/]+[\"']|import\(\s*[\"']node:[a-z_/]+[\"']" \
   --no-heading src | sed -E 's/.*(node:[a-z_/]+).*/\1/' | sort -u
```

```text
node:buffer
node:child_process
node:crypto
node:events
node:fs
node:fs/promises
node:http
node:net
node:os
node:path
node:readline
node:url
node:util
```

13 distinct core modules reach Saivage source (including static imports, slash-suffix submodules such as `node:fs/promises`, and dynamic `await import("node:fs/promises")` calls in tests). Representative call sites for the four modules omitted by the prior `node:[a-z]*` pattern:

- `node:child_process` — [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts) line 19 (`execFile`, `spawn`); [saivage/src/auth/store.test.ts](saivage/src/auth/store.test.ts) line 5 (`fork`).
- `node:fs/promises` — [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts) line 16 (`writeFile`, `mkdir`, `readdir`, `stat`, `open`, `opendir`); also imported across [saivage/src/auth/store.ts](saivage/src/auth/store.ts), [saivage/src/runtime/stash.ts](saivage/src/runtime/stash.ts), [saivage/src/runtime/abort.ts](saivage/src/runtime/abort.ts), [saivage/src/runtime/notes.ts](saivage/src/runtime/notes.ts), and several tests.
- `node:net` — [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts) line 887 (`import("node:net").Socket` type plus runtime socket destruction in the timeout test).
- `node:readline` — used in REPL/server CLI helpers reachable from `src/server/cli.ts`.

Node 20 → 24 behaviour check for the 13 modules:

- `node:buffer`, `node:crypto`, `node:events`, `node:os`, `node:path`, `node:url`, `node:util` — stable; no contract change for the call shapes used.
- `node:fs` and `node:fs/promises` — the synchronous `fs.exists` was removed in Node 24 (the project does not use it; see §5.2). The promise-based `mkdir`/`readdir`/`stat`/`open`/`opendir`/`writeFile`/`utimes` calls used by Saivage have unchanged signatures and return-shapes between Node 20 and 24.
- `node:http` — `Server` and `IncomingMessage` are unchanged. The default-`server.keepAliveTimeout` increase (Node 24) does not affect Saivage's request-scoped handlers.
- `node:child_process` — `execFile`, `spawn`, and `fork` keep their Node 20 signatures. Node 24 only changes default behaviour for `windowsHide` (now always `true`); Saivage already runs Linux-only and does not rely on the prior default.
- `node:net` — `Socket` API is stable; the test-only usage in `builtins.test.ts` only calls `destroy()`.
- `node:readline` — promise-based `readline/promises` API was experimental in 18 and stable in 20+; Node 24 keeps the stable interface unchanged.

Notably absent from the source-level surface: `node:test`, `node:assert`, `node:vm`, `node:worker_threads`, `node:dgram`, `node:dns`. Their absence eliminates the most common Node 20 → 24 breakage classes.

Conclusion: the 13-module surface contains no Node 20 → 24 contract change that touches a reachable Saivage call shape.

### 5.2 Deprecated / removed API check

```bash
grep -RInE "\bfs\.exists\(|fsPromises\.exists\(|process\.binding\(" --include='*.ts' src
```

(no output — measured `2026-05-27`)

No use of:

- `fs.exists` (removed in Node 24 — only `existsSync` and `access` remain).
- `process.binding(...)` (removed in Node 24).
- `require('assert')` (the module is still present but the CJS `require` is alien to this ESM project).
- `node:test` (not used; vitest is the only runner).

### 5.3 `new URL(...)` audit

```bash
grep -RIc "new URL(" --include='*.ts' src | awk -F: '$2>0{s+=$2}END{print s}'
```

```text
16
```

16 call sites across `src/`. Node 24 tightened the WHATWG URL parser (closer to spec; ICU-only IDNA). Classification of the 16 sites (measured by inspecting each match):

- `new URL(path, baseUrl)` with a `file://`, `http://`, or `https://` base — unchanged behaviour. Includes the test-fixture helpers in [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts) (`new URL(\`./${name}\`, import.meta.url)`).
- `new URL(value)` against caller-validated input — the user-input case is already guarded by `parseHttpUrl` in [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts), which throws on non-`http(s)` schemes before the URL is consumed further. No 16-site call passes raw, unvalidated user input straight into `new URL`.

Conclusion: no Node 24 URL-parser tightening reaches a Saivage call shape in a way that changes outcome.

### 5.4 Native modules (ABI risk)

Direct dependencies have **no** native (N-API) module.

```bash
PATH=~/.local/node-24/bin:$PATH npm ls --all 2>/dev/null \
  | grep -E "lmdb|sharp|better-sqlite3|node-pty|bcrypt|fsevents" | sort -u
```

```text
│ │ └── UNMET OPTIONAL DEPENDENCY fsevents@~2.3.2
│ │ ├── UNMET OPTIONAL DEPENDENCY fsevents@~2.3.3
│ ├── UNMET OPTIONAL DEPENDENCY fsevents@~2.3.3
```

`fsevents` is a macOS-only `optionalDependency` of `chokidar`/`vite`. On Linux it is intentionally not installed; `UNMET OPTIONAL DEPENDENCY` is the expected, non-blocking outcome. No other native module appears (no `lmdb`, `sharp`, `better-sqlite3`, `node-pty`, `bcrypt`).

No prebuilt-binary rebuild step is required as part of F02. The F01 RAG dependency additions will introduce `better-sqlite3` and `sqlite-vec`, both of which require Node 24 binary compatibility; this is F01's problem, not F02's.

### 5.5 Behavioural changes flagged by Node 24 release notes that touch reachable code

- `crypto.subtle` is now the default `WebCrypto` and the legacy `crypto.webcrypto` namespace still works but emits no warning. Saivage uses `node:crypto` via `randomBytes`, `createHash` — both unchanged.
- `fetch()` is permanently stable; no `--experimental-fetch` flag handling needed.
- `Buffer` constructor calls (`new Buffer(...)`) were already deprecated; the source has zero remaining call sites:

```bash
grep -RIn "new Buffer(" --include='*.ts' src
```

(no output — measured `2026-05-27`)

- `process.binding(...)` removed: not used in Saivage source (covered by §5.2).
- Permission model (`--permission`) is stable but opt-in; F02 does not turn it on.

### 5.6 Web frontend ( `saivage/web/` )

Out of scope for F02 per the topic's scope boundaries; the web package has its own `package.json` and lockfile and will be addressed by a separate topic if needed. F02 must not modify [saivage/web/package.json](saivage/web/package.json) or [saivage/web/package-lock.json](saivage/web/package-lock.json).

---

## 6. Operational impact: containers

The Saivage v2 runtime is hosted in three LXC containers on this workstation. The topic file ([saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md)) names them:

| Container | IP | Role | Node version (probed `2026-05-27`) |
| --- | --- | --- | --- |
| `saivage` | `10.0.3.111` | old Saivage v2 deployment working on GetRich | `v24.15.0` |
| `saivage-v3` | `10.0.3.112` | v2 harness working on `/work/saivage-v3` | `v24.15.0` |
| `saivage-v3-getrich-v2` | `10.0.3.170` | Saivage v3 working on GetRich v2 | `v20.19.4` |

Probe command (passwordless SSH to `root@` is configured per workspace memory):

```bash
# from /home/salva/g/ml
for ip in 10.0.3.111 10.0.3.112 10.0.3.170; do \
    printf "%s " "$ip"; ssh -o ConnectTimeout=4 root@$ip 'node --version'; done
```

```text
10.0.3.111 v24.15.0
10.0.3.112 v24.15.0
10.0.3.170 v20.19.4
```

### 6.1 What F02 records as a dependency

Interpretation against the F02 engines pin (`>=24.0.0`):

- `saivage` (`v24.15.0`) and `saivage-v3` (`v24.15.0`) both satisfy `>=24.0.0`. They lag behind the host's `v24.16.0` by a patch release; this is non-blocking for the engines pin and is recorded here only so the operator can plan a routine patch-level update at their convenience.
- `saivage-v3-getrich-v2` (`v20.19.4`) does **not** satisfy `>=24.0.0`. After F02 lands and a Saivage v3 build with the new engines pin is deployed there, `npm`/`node` will refuse to start with an `EBADENGINE` error. This container must be provisioned with Node 24 **before** the F02 result is redeployed.

The plan must include a non-goal entry stating that container provisioning is out of F02's scope (it belongs to a separate operational topic / container-setup playbooks under `/home/salva/g/ml/tmp/`), and a hard prerequisite for redeploying any F02-built artifact to `saivage-v3-getrich-v2`: Node 24 base image (or a node-24 PATH override in the service unit) must be in place first.

### 6.2 Re-probe procedure

```bash
# from /home/salva/g/ml
ssh root@10.0.3.111 'node --version'
ssh root@10.0.3.112 'node --version'
ssh root@10.0.3.170 'node --version'
```

The implementer should re-run these immediately before any redeploy step to confirm none of the containers regressed.

### 6.3 Rollout dependency graph

- F02 lands on the master branch — no container side-effect by itself.
- `saivage-v3-getrich-v2` is re-provisioned with Node 24 by a separate workflow.
- The corresponding Saivage v2 / v3 services are restarted with the new build.

If a container cannot be moved to Node 24 in time, the engines pin must hold and the service stays on the last pre-F02 master commit until provisioning catches up. This is acceptable; the topic does not require simultaneous rollout.

---

## 7. Open questions

1. Does `node-html-parser@7` change the default whitespace-handling behaviour in a way that affects [saivage/src/mcp/builtins.ts](saivage/src/mcp/builtins.ts)? §2.2 confirms the Options interface is a superset of v6, but the parser's text-node coalescing heuristics are not part of the type contract. Resolution: run [saivage/src/mcp/builtins.test.ts](saivage/src/mcp/builtins.test.ts) rows 1–17 against the installed v7 and inspect any diff.
2. Should the optional `@anthropic-ai/sdk` 0.95.1 → 0.99.0 jump be taken in F02 (still 0.x but with API surface drift), or is the conservative 0.95.1 → 0.95.2 (wanted) bump preferred? Recommendation: take only the `wanted` (`0.95.2`) inside F02 to keep the batch low-risk; the 0.99.0 step is an independent follow-up.
3. Does `npm audit fix` (non-force) cleanly upgrade `protobufjs` despite the `@google/genai` peer range? If not, the `overrides` fallback in §3.3 must be applied. Resolution: deferred to the relevant implementation batch.
4. Is there any consumer of `he` (HTML entities) still alive in [saivage/web/](saivage/web) even though `src/` has zero imports? If the answer is "no" on the web side too, removal is desirable; if "yes", it stays. Removal is **not** in F02 scope either way.

---

## 8. Summary of decisions (machine-readable)

```yaml
upgrades_required:
  - happy-dom: ^15.11.7 -> ^20.9.0   # critical CVE
  - node-html-parser: ^6.1.13 -> ^7.1.0  # single import site, option-shape compatible
  - "@anthropic-ai/sdk": ^0.95.1 -> ^0.95.2   # wanted
  - "@types/node": ^25.6.2 -> ^25.9.1
  - eslint: ^10.3.0 -> ^10.4.0
  - grammy: ^1.42.0 -> ^1.43.0
  - openai: ^6.37.0 -> ^6.39.0
  - tsx: ^4.21.0 -> ^4.22.3
  - vitest: ^4.1.5 -> ^4.1.7

transitive_cves:
  ws:          npm_audit_fix_nonforce
  qs:          npm_audit_fix_nonforce
  protobufjs:  npm_audit_fix_nonforce  # fallback: overrides ^7.5.8
  esbuild:     accept_residual         # via vitepress chain, dev-only
  vite:        accept_residual         # same chain as esbuild
  vitepress:   accept_residual         # no fixed upstream release
  vitepress-plugin-mermaid: accept_residual  # inherits

deferred:
  zod: 3.25.76 -> 4.4.3   # follow-up F04; no open CVE on 3.x

engines_pin: ">=24.0.0"

container_node_versions_2026_05_27:
  saivage              (10.0.3.111): v24.15.0  # satisfies >=24, lags host v24.16.0
  saivage-v3           (10.0.3.112): v24.15.0  # satisfies >=24, lags host v24.16.0
  saivage-v3-getrich-v2 (10.0.3.170): v20.19.4 # blocks redeploy until provisioned to Node 24
```

End of analysis.
