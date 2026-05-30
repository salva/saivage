# G44 — Analysis r4

Round 4. Round 3 lives at [01-analysis-r3.md](01-analysis-r3.md); the
reviewer's findings are in [04-review-r3.md](04-review-r3.md). Round 3
fixed the source-side gate split (cross-doc-clean vs file-scoped) and
brought the `ChatLogSchema` table cell in
[docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28)
into scope. The reviewer accepted both. The only remaining blocker is
verification-side, not inventory or ownership:

1. The Round 3 dist-side gate only checks the rebuilt HTML files
   under `docs/.vitepress/dist/internals/*.html` for the file-scoped
   tokens. VitePress also commits a page-content JS chunk per page
   under `docs/.vitepress/dist/assets/internals_<page>.md.*.js` (and
   its `.lean.js` sibling) which contains the **same rendered page
   prose**, just embedded in a JS string with the same HTML entity
   encoding (`<` as `&lt;`, `>` as `&gt;`).

   Verified by direct grep against the current build:
   [docs/.vitepress/dist/assets/internals_data-model.md.BkNLsHnX.js](../../../../docs/.vitepress/dist/assets/internals_data-model.md.BkNLsHnX.js#L1)
   contains the stale flat path
   `tmp/chats/&lt;sessionId&gt;.json` exactly once, embedded inside
   the rendered persisted-shapes table row for `ChatLogSchema`. The
   matching HTML file would catch the same string, but if a future
   build re-uses a cached HTML while regenerating the asset chunk (or
   vice versa), the HTML-only gate would silently pass on a stale
   asset chunk that ships to readers.

   This is a verification-gate gap, not a new edit. The Round 3 edit
   map at
   [02-design-r3.md](02-design-r3.md#L63-L71) already lists the
   asset-chunk regeneration for all three pages; the gate just needs
   to actually check them.

2. The Round 3 cross-doc-clean dist check at
   [03-plan-r3.md](03-plan-r3.md#L181-L190) already grep -r's the
   whole `docs/.vitepress/dist` tree, which naturally includes the
   assets directory. That partition needs no change. The gap is
   strictly in the file-scoped dist check, which currently only
   names the three `.html` files.

3. No new source-of-truth code needs to be re-read. The stale-string
   inventory at
   [01-analysis-r3.md](01-analysis-r3.md#L84-L121) stands without
   change; only the dist-side scope of where to grep each
   file-scoped pattern is widened to include the matching JS chunk.

## Carried over from r3

The verified-facts section, the `sendEvent` ownership table, the
severity/impact section, the issue-level inaccuracies note, the
built-dist drift note, the cross-links section, and the partitioned
stale-string inventory (cross-doc-clean vs file-scoped) from
[01-analysis-r3.md](01-analysis-r3.md) all stand without change. The
reviewer found no fault with them in
[04-review-r3.md](04-review-r3.md) (see "What Is Solid"). Round 4
does not restate them.

## Scope (delta from r3)

Source-side scope is unchanged from
[01-analysis-r3.md](01-analysis-r3.md#L66-L74). Dist-side scope is
clarified: each rebuilt internals page is checked as a *pair* of
artifacts — the rendered HTML file and the corresponding page-content
JS chunk(s) under `docs/.vitepress/dist/assets/`. Both forms carry
the same rendered prose and so both must be free of file-scoped
stale tokens after Step 4 (docs rebuild).

Concretely, the verification pair per page is:

| Page | HTML artifact | Asset chunk artifact (hash-suffixed) |
| --- | --- | --- |
| Channels | `docs/.vitepress/dist/internals/channels.html` | `docs/.vitepress/dist/assets/internals_channels.md.*.js` (and `.lean.js`) |
| Agent chat | `docs/.vitepress/dist/internals/agent-chat.html` | `docs/.vitepress/dist/assets/internals_agent-chat.md.*.js` (and `.lean.js`) |
| Data model | `docs/.vitepress/dist/internals/data-model.html` | `docs/.vitepress/dist/assets/internals_data-model.md.*.js` (and `.lean.js`) |

The hash component changes on each build, so the gate uses a glob
(`internals_<page>.md.*.js`) rather than a pinned filename.

## Acceptance criteria (delta from r3)

Criteria 1, 2, 4, 5, and 6 from
[01-analysis-r3.md](01-analysis-r3.md#L161-L188) stand without
change. Criterion 3's third bullet is widened to cover JS chunks:

3. After the rewrite **and** the `ChatLogSchema` row fix:
   - Every token in the **cross-doc-clean** table is absent from
     `docs/**/*.md` outside `docs/.vitepress/dist/` (rebuilt in
     step 4) and outside the SPEC review tree. (Unchanged from r3.)
   - Every token in the **file-scoped** table is absent from the
     specific files listed in its "Stale in" column. (Unchanged.)
   - The same partitioned check passes against the rebuilt dist
     tree under both the rendered HTML
     (`docs/.vitepress/dist/internals/{channels,agent-chat,data-model}.html`)
     **and** the matching page-content JS chunks
     (`docs/.vitepress/dist/assets/internals_{channels,agent-chat,data-model}.md.*.js`,
     including `.lean.js`). The valid prose in
     [docs/internals/server.md](../../../../docs/internals/server.md#L48)
     and
     [docs/guide/quickstart.md](../../../../docs/guide/quickstart.md#L64)
     remains explicitly out of scope — the assets check is
     restricted to the three named page chunks, not the whole assets
     directory.

## Project rules applied (delta)

Widening the dist gate to cover JS chunks does not introduce a new
abstraction, lint, or build step: it is the same grep invocations,
re-pointed at one additional glob per file-scoped pattern. The hash
glob is the minimal additional surface to make the existing check
catch the artifact it already claimed to cover in the Round 3 edit
map.

The carried-over project-wide principles (no regex parsing of user
intent, no hardcoded values, no fragile heuristics) still do not
apply to a docs-only fix; recorded for awareness as in r3.
