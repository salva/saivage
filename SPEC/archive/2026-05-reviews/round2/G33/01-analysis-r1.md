# G33 — Analysis r1

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Writer**: Claude Opus 4.7 (round 1)

**Subsystem**: mcp (built-in data-acquisition tools).

## 1. What the code does today

The `web_search` built-in tool is registered as a data-tool in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L658-L669)
and handled at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761).
The handler:

1. Reads `args.query` and clamps `max_results` into `[1, 20]`.
2. Issues a single `fetch` to `https://duckduckgo.com/html/?q=...`
   with no timeout, no response-size cap, and no abort signal.
3. Reads the entire response body with `response.text()` — the
   process can hold an unbounded HTML string in memory.
4. Runs the regex
   `/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi`
   across the whole body
   ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L747)),
   pushes up to `maxResults` matches, and decodes the `uddg`
   redirect parameter when the anchor points at DuckDuckGo's
   click-tracker.
5. Returns `{ query, results, status }` on success and a
   one-field `{ error: "query is required" }` on the empty-query
   branch — the only structured error path in the handler.

Everything else (network failure, non-2xx upstream, parser
returning zero matches, malformed `uddg`, oversized payload,
upstream timeout) propagates either as an empty `results` array or
as an unhandled exception that the dispatcher surfaces as a raw
`Error` to the calling agent.

No fixture-driven test exercises the parser. The single test that
mentions `web_search` is the registration check at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L84),
which only asserts the tool name is present in the registry.

## 2. Root cause

Three independent defects compound into the "silently dumber
agent" failure mode the finding describes:

1. **Regex over HTML**: the class-attribute regex assumes the
   exact ordering `class="result__a" ... href="..."` on a single
   `<a>` element and the snippet on a sibling `<a class="result__snippet">`.
   DuckDuckGo's HTML endpoint rotates between several A/B
   variants (`result__title`, `result__body`, anti-bot
   interstitials, JavaScript-driven layouts) where one or both
   classes are missing or reordered. Each rotation drops the
   match count to zero with no error.
2. **Empty-results = success**: the handler emits
   `isError: false` whenever `results.length === 0`. There is no
   way for the agent (or the supervisor) to distinguish "query
   genuinely matched nothing" from "parser stopped recognising
   DDG markup". The supervisor's heuristic-free design after F05
   means the regression never escalates.
3. **No upstream-failure envelope**: a 200 response with a
   challenge page, a 202/302 redirect, a Cloudflare 403, and a
   TCP reset all collapse into the same shape — empty `results`
   plus whatever `response.status` was. There is no `code` field,
   so agents cannot branch on cause and retries are blind.

The "level-up" direction from the finding (pluggable provider, or
a real DOM parser plus a pinned-fixture test) is the only way to
make the failure mode observable: every other change is a
rearrangement of the same broken signal.

## 3. Blast radius

- **Direct callers**: data-agent + researcher; both depend on
  `web_search` to discover unfamiliar APIs and library
  documentation. Their downstream task reports go to the planner
  and into knowledge memory — a stale-knowledge feedback loop.
- **Indirect**: chat slash commands that surface `web_search`
  through the LLM-routed tool catalog.
- **Same-file co-touch**: G31 (read_file) edits the `filesystem`
  service block plus a new `classifyFsError` helper. G32
  (search_files) edits the `filesystem` service block plus a new
  `globToRegExp` helper. G34 (fetch_url streaming cap) edits the
  `data` service block — specifically `fetch_url`,
  `fetch_page_text`, `download_file`, `download_with_fallbacks`.
  G35 (secret-env regex) does not touch
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) directly
  but does edit
  [src/config.ts](../../../../src/config.ts) (the `mcp` config
  block is the shared seam). G33's scope is the `web_search` case
  plus a new DDG-HTML extractor helper; it does not touch the
  filesystem cases (G31/G32), nor the other data cases (G34), and
  its config additions are disjoint field names from G34/G35.
- **Operational**: the DDG outbound call is the only network
  side-effect of the tool. Caps must not lock out long-running
  data-agent sessions on slow networks; defaults must align with
  the existing `mcp.maxFetchChars` (200 KB) family.

## 4. Project-rule check (architecture-first, no compat shim)

The finding's "fallback search provider" remark could be read as a
hedge ("add a layer in case DDG breaks again"). Per the
workspace's architecture-first / no-migration-shim rule, the
correct framing is:

- Build one good extractor against the DDG-HTML upstream — the
  same upstream the tool already uses.
- Surface the failure mode loudly (structured `NO_RESULTS_PARSED`
  error, fixture test pinned to a captured response).
- Add the **internal seam** that would let a future operator swap
  the upstream out, but do not ship a second provider until there
  is concrete demand. No config switch, no abstract base class
  with one implementation, no dead code.

This is what the recommendation in
[02-design-r1.md](02-design-r1.md) commits to.

## 5. Constraints carried into design

- Envelope must be the G31/G32 shape: every failure returns
  `{ content: { error, code, ...context }, isError: true }`; every
  success returns `{ content: { ...payload }, isError: false }`.
- Caps live on `SaivageConfig.mcp` next to `maxFetchChars`,
  `maxDownloadBytes`, `shellTimeoutMs`. Field names must be
  disjoint from G34's planned `mcp.fetchTimeoutMs` /
  `mcp.fetchMaxBytes` additions and from any G35 additions to the
  same block.
- No new runtime dependency beyond a single small HTML parser.
- No regex over HTML for structural extraction; regex remains
  acceptable only for the existing `stripHtml` text-stripping
  helper, which already operates on already-extracted strings.
- Fixture test must fail loudly when the parser produces zero
  results from a known-good fixture.

## 6. Open questions deferred to design

- Which HTML parser to add? Candidates: `node-html-parser`
  (zero-dep, ~50 KB, sync, supports `querySelector`),
  `linkedom`, `parse5` + `parse5-htmlparser2-tree-adapter`,
  `cheerio` (heavy). Resolved in
  [02-design-r1.md §3.1](02-design-r1.md#L1).
- Should we keep the `uddg` redirect-decoding step? Yes —
  preserving the existing semantic. Resolved in
  [02-design-r1.md §3.4](02-design-r1.md#L1).
- Should empty-results be an error code? Yes — when the parser
  finds no matching result anchors, return
  `NO_RESULTS_PARSED` (operator-visible markup-drift signal),
  not `isError: false`. Resolved in
  [02-design-r1.md §3.5](02-design-r1.md#L1).
