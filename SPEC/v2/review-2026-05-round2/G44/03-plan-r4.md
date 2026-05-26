# G44 — Implementation plan r4

Implements Proposal A as carried forward in
[02-design-r4.md](02-design-r4.md): targeted rewrite of two internals
docs, one extra table-cell fix in
[docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28),
a docs rebuild, and a verification gate that now also covers the
rebuilt page-content JS chunks. No source code changes.

Round 3 plan is at [03-plan-r3.md](03-plan-r3.md); reviewer findings
are at [04-review-r3.md](04-review-r3.md). The substantive change in
this round is confined to verification:

1. The dist-side file-scoped gate in
   [03-plan-r3.md](03-plan-r3.md#L202-L207) only grep'd the three
   rebuilt HTML files. It now also greps the matching page-content
   JS chunks (and their `.lean.js` siblings) under
   `docs/.vitepress/dist/assets/`, per
   [02-design-r4.md](02-design-r4.md#file-scoped-check-widened-on-the-dist-side).
2. The reviewer checklist in Step 6 is widened to confirm that the
   three page-content asset chunks are regenerated, committed, and
   free of the file-scoped stale tokens.

Steps 1, 2a, 2b, 2c, 3, 4, 5a, 5c, 7, the rollback section, and the
out-of-scope section are unchanged from
[03-plan-r3.md](03-plan-r3.md). Step 5b and Step 6's reviewer
checklist are replaced.

## Pre-flight verification

Checks 1-6 from [03-plan-r2.md](03-plan-r2.md#L25-L62) and checks 7a /
7b from [03-plan-r3.md](03-plan-r3.md#L45-L91) stand unchanged. A new
check 7c is added to baseline the dist asset chunks:

7c. Dist asset-chunk baseline, run from `saivage/`:

```
ls docs/.vitepress/dist/assets/internals_channels.md.*.js docs/.vitepress/dist/assets/internals_agent-chat.md.*.js docs/.vitepress/dist/assets/internals_data-model.md.*.js
```

Expected: at least two files per page (one `.js`, one `.lean.js`).
If the glob expands to zero files for any page in scope, the local
dist tree is stale or missing — run `npm run docs:build` once
before continuing so step 5b has artifacts to grep.

If a current local build is not available, this baseline can also
be deferred until immediately after Step 4 (the rebuild). The point
is to establish a known starting glob expansion before Step 5b is
expected to pass.

## Step 1 — Rewrite docs/internals/channels.md

Unchanged from [03-plan-r2.md](03-plan-r2.md#L64-L189). Apply that
step verbatim.

## Step 2 — Update docs/internals/agent-chat.md

### Step 2a — `## Channels` list

Unchanged from [03-plan-r2.md](03-plan-r2.md#L193-L213).

### Step 2b — `## Sessions` chat-log path

Unchanged from [03-plan-r2.md](03-plan-r2.md#L215-L233).

### Step 2c — Fix the ChatLogSchema row in data-model.md

Unchanged from [03-plan-r3.md](03-plan-r3.md#L123-L155). Apply that
step verbatim.

## Step 3 — Sanity grep

Unchanged from [03-plan-r3.md](03-plan-r3.md#L157-L194). Apply both
sub-steps (3a cross-doc-clean, 3b file-scoped) verbatim against the
source tree.

## Step 4 — Rebuild the docs site

Unchanged from [03-plan-r3.md](03-plan-r3.md#L196-L200). Apply
verbatim. After the rebuild, commit both the three rebuilt HTML
files **and** the three regenerated `internals_<page>.md.*.js`
chunks (with `.lean.js` siblings) as listed in the edit map at
[02-design-r3.md](02-design-r3.md#L52-L75).

## Step 5 — Post-build verification

The partitioned gate from
[03-plan-r3.md](03-plan-r3.md#L179-L240), with Step 5b widened to
cover the rebuilt asset chunks.

### Step 5a — Cross-doc-clean check on dist

Unchanged from [03-plan-r3.md](03-plan-r3.md#L181-L194). Run
verbatim:

```
grep -rnE 'channels/(cli|oneshot|index)\.ts|publish\(event|chat-chunk|Three concrete channel implementations|start\(runtime' docs/.vitepress/dist
```

Expected: zero matches. The recursive grep already naturally
includes `docs/.vitepress/dist/assets/`, so no separate assets
invocation is needed here.

### Step 5b — File-scoped check on dist (REPLACED)

The Round 3 form of this step only grep'd the three rendered HTML
files in
[03-plan-r3.md](03-plan-r3.md#L202-L207). It is replaced by the
following set of six invocations — one HTML invocation and one
matching asset-chunk invocation per file-scoped pattern. All must
return zero matches.

Run from `saivage/`:

```
grep -nE 'interface Channel\b' docs/.vitepress/dist/internals/channels.html
grep -nE 'interface Channel\b' docs/.vitepress/dist/assets/internals_channels.md.*.js
grep -nE 'One-shot CLI' docs/.vitepress/dist/internals/agent-chat.html
grep -nE 'One-shot CLI' docs/.vitepress/dist/assets/internals_agent-chat.md.*.js
grep -nE 'tmp/chats/&lt;sessionId&gt;\.json|tmp/chats/<sessionId>\.json' docs/.vitepress/dist/internals/agent-chat.html docs/.vitepress/dist/internals/data-model.html
grep -nE 'tmp/chats/&lt;sessionId&gt;\.json|tmp/chats/<sessionId>\.json' docs/.vitepress/dist/assets/internals_agent-chat.md.*.js docs/.vitepress/dist/assets/internals_data-model.md.*.js
```

Notes:

- The `internals_<page>.md.*.js` shell globs expand to both the
  `.js` and the `.lean.js` siblings; both must be greppable and
  both must return zero matches.
- The rebuilt HTML and the rebuilt JS chunks both escape `<` and
  `>` as `&lt;` / `&gt;` inside `<code>` blocks (verified for the
  current local build at
  [docs/.vitepress/dist/assets/internals_data-model.md.BkNLsHnX.js](../../../../docs/.vitepress/dist/assets/internals_data-model.md.BkNLsHnX.js#L1)).
  The flat-path alternation `tmp/chats/&lt;sessionId&gt;\.json|tmp/chats/<sessionId>\.json`
  therefore works unchanged across both artifact classes.
- If any `internals_<page>.md.*.js` glob expands to zero files
  (`grep` reports "No such file or directory"), Step 4 did not
  produce the expected chunks — rerun `npm run docs:build` from a
  clean working tree and re-check.
- Do **not** widen any of these invocations to the whole
  `docs/.vitepress/dist/assets/` directory or to `app.*.js` /
  theme chunks — that would re-introduce the false-positive risk
  that the partitioned gate was designed to prevent (see
  [02-design-r4.md](02-design-r4.md#file-scoped-check-widened-on-the-dist-side)).

### Step 5c — Spot-checks

Unchanged from [03-plan-r3.md](03-plan-r3.md#L228-L240). Apply
verbatim against the three rebuilt HTML pages.

## Step 6 — Commit / PR

Unchanged from [03-plan-r3.md](03-plan-r3.md#L242-L252), with one
extension to the reviewer checklist:

- The PR body / reviewer checklist must additionally confirm: the
  three `internals_<page>.md.*.js` chunks
  (`channels`, `agent-chat`, `data-model`), with `.lean.js`
  siblings, are regenerated and committed; running Step 5b against
  each chunk returns zero matches for the file-scoped patterns
  it owns.

The other two checklist items from
[03-plan-r3.md](03-plan-r3.md#L242-L252) (the `data-model.md`
`ChatLogSchema` row fix mention and the no-flat-path confirmation
in source + HTML) stand without change.

## Step 7 — Cross-issue handoff

Unchanged from [03-plan-r2.md](03-plan-r2.md#L310-L315).

## Out-of-scope (delta from r3)

The non-goals list from
[03-plan-r3.md](03-plan-r3.md#L258-L270) stands without change.
Adding the three asset-chunk globs to Step 5b does **not** open the
whole dist assets directory or the client-app bundle as in-scope for
any other audit; only the three named globs are checked.

## Rollback

Unchanged from [03-plan-r2.md](03-plan-r2.md#L336-L340). A single
revert restores the prior (stale) state across all three source
files and the rebuilt dist tree (HTML + asset chunks).
