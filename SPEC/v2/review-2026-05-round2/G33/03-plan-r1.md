# G33 — Plan r1

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Design**: [02-design-r1.md](02-design-r1.md)

**Writer**: Claude Opus 4.7 (round 1)

## 1. Scope summary

Single PR, one commit per step:

1. Add `node-html-parser` dependency.
2. Add `webSearchMaxResults` / `webSearchTimeoutMs` /
   `webSearchMaxBytes` to the `mcp` config block in
   [src/config.ts](../../../../src/config.ts).
3. Add module-level lets + `registerBuiltinServices` wiring in
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).
4. Add `extractDdgResults`, `climbToResultContainer`,
   `readBoundedTextBody`, `signatureOf` helpers in
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).
5. Rewrite the `web_search` handler case.
6. Capture the fixture
   [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html)
   (one-off operator step, not a runtime fetch in CI) and the two
   corrupted variants (`web-search.fixture.drifted.html`,
   `web-search.fixture.empty.html`).
7. Add the 9 test cases enumerated in
   [02-design-r1.md §3.9](02-design-r1.md#L1) to
   [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).
8. Update the `web_search` description in `dataTools` and refresh
   [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
   with the three new fields.

No files are deleted by G33. No backward-compat shim is
introduced; the old regex-extractor block is removed wholesale in
step 5.

## 2. File-by-file diff plan

### [package.json](../../../../package.json)

Add to `dependencies` (alphabetically):

```jsonc
"node-html-parser": "^6.1.13"
```

Run `npm install --package-lock-only` to refresh the lockfile.
Do not bump unrelated entries.

### [src/config.ts](../../../../src/config.ts) — lines 137–170

Insert three fields inside the existing `mcp` z.object literal
above `.superRefine(...)`, ordered alphabetically relative to the
existing `webSearch*` group (i.e. all three land together after
the existing `maxDownloadBytes` line). See
[02-design-r1.md §3.2](02-design-r1.md#L1) for the literal Zod
fragment. Do not touch `.superRefine`. Sequence note for G35
merge: same insertion point; alphabetical ordering of the new
fields is the merge rule.

### [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)

Edit sites, in source order:

- **Imports** (top of file, near
  [line 27](../../../../src/mcp/builtins.ts#L27)): add
  `import { parse as parseHtml, type HTMLElement } from "node-html-parser";`
  on its own line under the other third-party imports.
- **Module-level constants** (near
  [line 42](../../../../src/mcp/builtins.ts#L42)): add three
  `let` declarations under `MAX_FETCH_CHARS`.
- **Helpers** (near
  [line 91](../../../../src/mcp/builtins.ts#L91), next to
  `stripHtml`): insert `signatureOf`, `readBoundedTextBody`,
  `climbToResultContainer`, `extractDdgResults` in that order,
  before the `interface DownloadAttempt` block.
- **Handler** (lines 737–761): replace the entire `case
  "web_search":` block with the version in
  [02-design-r1.md §3.6](02-design-r1.md#L1). The new block is
  longer but stays inside the same `switch`.
- **Registration wiring** (near
  [line 1078](../../../../src/mcp/builtins.ts#L1078)): three new
  assignments under `MAX_DOWNLOAD_BYTES = mcpConfig.maxDownloadBytes;`.
- **Tool schema** (lines 657–669): update the `description`
  string of the `web_search` entry to read:
  *"Search the public web for data sources, APIs, documentation,
  and downloadable datasets. Returns candidate URLs with snippets.
  Failures return structured `code` values (`INVALID_ARGUMENT`,
  `TIMEOUT`, `NETWORK_ERROR`, `UPSTREAM_HTTP_ERROR`,
  `RESPONSE_TOO_LARGE`, `PARSE_FAILURE`, `NO_RESULTS_PARSED`).
  `max_results` is clamped to the configured ceiling."*

### [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html) (new)

One-off operator capture from
`curl 'https://duckduckgo.com/html/?q=mlflow+model+signature' -A 'Saivage/0.1 data-agent' -o src/mcp/web-search.fixture.html`,
hand-trimmed to:

- Keep ≥ 5 result blocks (anchors with `result__a` and
  `result__snippet`).
- Replace any tracking-id-like query parameters in `uddg` redirects
  with `example.com`-style placeholders.
- Keep the `<html>`/`<body>` shell intact so the parser sees a
  real document.

Two derivative fixtures (also new):

- [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html):
  same body but with `class="result__a"` renamed to
  `class="result__title"` and `result__snippet` renamed to
  `result__body`. Used by test #5 to exercise `NO_RESULTS_PARSED`.
- [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html):
  minimal HTML shell with zero `result__a` anchors. Used to
  exercise the "DDG returned the search page but with zero
  results" case.

### [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)

Append a new `describe("data: web_search", () => { ... })` block
at the bottom of the file before the closing brace of the existing
top-level suite. Use `vi.spyOn(global, "fetch")` for the network
mocks (matching the pattern at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L220-L240));
restore in `afterEach`. The 9 cases are enumerated in
[02-design-r1.md §3.9](02-design-r1.md#L1).

Fixtures are loaded with
`readFileSync(new URL("./web-search.fixture.html", import.meta.url), "utf8")`.

### [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)

Add three rows to the `mcp.*` table documenting the new fields,
their defaults, and a one-sentence rationale each. Place the rows
under the existing `mcp.maxDownloadBytes` row.

## 3. Test gates

Local gates (must all pass before opening the PR):

1. `npm run lint`
2. `npm run build` (tsup; surfaces any type error in the new
   helpers).
3. `npm test -- src/mcp/builtins.test.ts` — the 9 new cases plus
   the existing suite must pass.
4. `npm test` — full suite green, including the
   `noSyncFsScanner` regression check from G30 (G33 introduces
   no new sync-fs call sites; the scanner allow-list does not
   need to change).
5. Manual snapshot: with the harness pointed at the dev project,
   run a `web_search` against `"mlflow model signature"` from
   the data-agent and confirm:
   - success path returns ≥ 1 result with non-empty `title` +
     `url`,
   - simulated DDG outage (`curl --resolve duckduckgo.com:443:127.0.0.1 …`)
     surfaces `NETWORK_ERROR` rather than an unhandled exception.

CI gates: none beyond the existing pipeline. The fixture-driven
tests never touch the network.

## 4. Deploy

- Build: `npm run build` in the repo root.
- Bind-mount containers picking up the change: `saivage`
  (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3`
  (10.0.3.112). Restart `saivage.service` on each:

  ```bash
  ssh root@10.0.3.111 'systemctl restart saivage.service && sleep 3 && systemctl is-active saivage.service'
  ssh root@10.0.3.112 'systemctl restart saivage.service && sleep 3 && systemctl is-active saivage.service'
  ssh root@10.0.3.113 'systemctl restart saivage.service && sleep 3 && systemctl is-active saivage.service'
  ```

- `saivage-v3-getrich-v2` (10.0.3.170) is unaffected (no
  bind-mount of this repo). Skip.

- Health check after each restart:

  ```bash
  curl -fsS http://10.0.3.111:8080/health
  curl -fsS http://10.0.3.112:8080/health
  curl -fsS http://10.0.3.113:8080/health
  ```

- No on-disk config migration — defaults cover the new fields.
  Operators who want to tighten caps can edit `.saivage/saivage.json`
  on their project after deploy.

## 5. Rollback

The change is a single-PR rewrite of one handler plus three new
config fields. Rollback is a `git revert <commit>` on the PR and a
restart of `saivage.service` on the three bind-mount containers.
The new config fields default to safe values, so a forward-fix
("revert just the handler edits, keep the config schema") is also
possible but should not be necessary.

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| DDG markup drift between fixture capture and prod | medium | parser returns zero results | `NO_RESULTS_PARSED` envelope makes the regression loud; operator re-captures fixture and re-runs the test |
| DDG blocks the User-Agent | low | every call returns `UPSTREAM_HTTP_ERROR` (403/429) | structured `code` lets the agent surface a clear failure; follow-up issue (Proposal B) opens a real provider |
| `node-html-parser` upstream pulls in transitive deps in a future minor | low | bundle bloat | pin to `^6.1.13`, audit `npm ls node-html-parser` after install |
| `readBoundedTextBody` ships twice (G33 here, G34 in `fetch_url`) | high (transient) | code duplication for the window between the two PRs | sequencing note in [02-design-r1.md §4](02-design-r1.md#L1) — G34 dedups in its own PR |
| `mcp` config block conflict on merge with G35 | low | textual merge conflict | alphabetical-insertion rule documented in §2; trivial three-way merge |

## 7. Out-of-scope follow-ups

- Pluggable backend (Proposal B). Track as G33-followup; do not
  open until a second provider (Brave / SerpAPI key in hand) is
  concretely required.
- Snippet/title length sanity caps (currently each is the result
  of `.text.replace(/\s+/g, " ").trim()` with no upper bound).
  Will land naturally when G34 introduces a shared
  per-text-field cap; do not pre-empt.
- Telegraphing markup-drift via the supervisor (count
  `NO_RESULTS_PARSED` envelopes per stage and flag a stuck
  agent). Track in the supervisor backlog, not here.
