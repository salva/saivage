# G44 — Design r4

Round 4. Round 3 design is at [02-design-r3.md](02-design-r3.md); the
reviewer's findings are in [04-review-r3.md](04-review-r3.md). Round 3
adopted Proposal A, partitioned the verification gate into
cross-doc-clean vs file-scoped, and added the `ChatLogSchema` table
cell in
[docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28)
to scope. The reviewer accepted the proposal shape, the wording rules,
the edit map, and the source-side gate split. The only blocker was
that the dist-side file-scoped gate as written in
[03-plan-r3.md](03-plan-r3.md#L202-L207) only checks the rebuilt HTML
files, while VitePress also commits a page-content JS chunk per page
that carries the **same rendered prose** (verified for the data-model
chunk at
[docs/.vitepress/dist/assets/internals_data-model.md.BkNLsHnX.js](../../../../docs/.vitepress/dist/assets/internals_data-model.md.BkNLsHnX.js#L1)).

The substantive change in this round is confined to:

1. The file-scoped half of the dist verification gate is widened
   from `dist/internals/*.html` to also include the matching
   `dist/assets/internals_<page>.md.*.js` chunks (and their
   `.lean.js` siblings) for the three pages in scope: channels,
   agent-chat, data-model.
2. The reviewer checklist in the PR template is widened to confirm
   that the rebuilt asset chunks for the three pages are
   regenerated, committed, and free of the file-scoped stale
   tokens.

Everything else in [02-design-r3.md](02-design-r3.md) — Proposal A's
shape, the cross-doc-clean partition, the file-scoped partition, the
edit map (including the asset-chunk rows that were already listed for
regeneration), the wording rules, the non-goals — stands without
change.

## Goal (unchanged from r3)

See [02-design-r3.md](02-design-r3.md#L34-L46).

## Decision (unchanged from r3)

Adopt Proposal A from
[02-design-r2.md](02-design-r2.md#L29-L130). No re-evaluation of
Proposals B or C in round 4.

## Edit map (unchanged from r3)

The edit map at [02-design-r3.md](02-design-r3.md#L52-L75) already
lists the three rebuilt HTML files **and** the three rebuilt asset
chunks
(`internals_channels.md.*.js`,
`internals_agent-chat.md.*.js`,
`internals_data-model.md.*.js`)
as artifacts to be regenerated and committed. No edit-map row is
added, removed, or modified in round 4. The widening is strictly to
the verification gate that checks those artifacts.

## Wording rules (unchanged from r3)

See [02-design-r3.md](02-design-r3.md#L77-L82).

## Verification gate (delta from r3)

The Round 3 gate at [02-design-r3.md](02-design-r3.md#L84-L135) is
kept in full. The only widening is to the dist-side **file-scoped**
check.

### Cross-doc-clean check (unchanged from r3)

See [02-design-r3.md](02-design-r3.md#L100-L116). The tree-wide
`grep -r ... docs/.vitepress/dist` already naturally covers the
assets directory, so this partition needs no change.

### File-scoped check (widened on the dist side)

The source-side file-scoped check at
[02-design-r3.md](02-design-r3.md#L118-L131) stands without change.

On the dist side, each file-scoped pattern is checked against **two**
artifact classes per page in scope: the rendered HTML file and the
matching page-content JS chunk(s). Round 3's note "applied to both
HTML and JS chunks" at [02-design-r3.md](02-design-r3.md#L132-L135)
is now made concrete in the plan (see
[03-plan-r4.md](03-plan-r4.md#step-5b)).

| Pattern | Dist artifacts checked (expected: zero matches) |
| --- | --- |
| `interface Channel\b` | `docs/.vitepress/dist/internals/channels.html` and `docs/.vitepress/dist/assets/internals_channels.md.*.js` (incl. `.lean.js`) |
| `One-shot CLI` | `docs/.vitepress/dist/internals/agent-chat.html` and `docs/.vitepress/dist/assets/internals_agent-chat.md.*.js` (incl. `.lean.js`) |
| `tmp/chats/<sessionId>\.json` (flat, with the entity-encoded `&lt;` / `&gt;` alternation) | `docs/.vitepress/dist/internals/{agent-chat,data-model}.html` and `docs/.vitepress/dist/assets/internals_{agent-chat,data-model}.md.*.js` (incl. `.lean.js`) |

Encoding inside the JS chunks matches the HTML: `<` and `>` are
emitted as `&lt;` / `&gt;` inside `<code>` blocks. The same
alternation used for the HTML form
(`tmp/chats/&lt;sessionId&gt;\.json|tmp/chats/<sessionId>\.json`)
therefore matches the JS chunk content unchanged.

Hash glob: the chunk filename includes a build-hash component (e.g.
`BkNLsHnX`) that changes per build. The gate uses
`internals_<page>.md.*.js` (a literal glob in the shell, expanded
by the shell before grep runs) so the check survives rebuild-hash
churn. If the glob expands to zero files for any page in scope,
that itself is a gate failure — Step 4 (docs rebuild) did not
produce the expected chunks.

Files explicitly **not** added to the dist file-scoped check (same
rationale as r3, [02-design-r3.md](02-design-r3.md#L126-L131)):

- The whole `docs/.vitepress/dist/assets/` glob (would catch
  unrelated chunks that may legitimately render the
  [docs/internals/server.md](../../../../docs/internals/server.md#L48)
  `stop()` line or the
  [docs/guide/quickstart.md](../../../../docs/guide/quickstart.md#L64)
  Planner heading). Only the three named page chunks are checked.
- The aggregated client-app bundle under
  `docs/.vitepress/dist/assets/app.*.js` and theme chunks. They do
  not render page prose; widening to them would be scope creep and
  would re-introduce the r3 false-positive risk.

## Cost / risk (delta from r3)

- Three additional grep invocations in Step 5b (one per file-scoped
  pattern, each with a shell glob covering both `.js` and `.lean.js`
  per page). No new tooling, no new CI step. Total PR remains a
  small docs PR.
- Risk: if VitePress changes its chunk naming convention (e.g.
  drops the `internals_` prefix or moves chunks out of `assets/`),
  the glob expands to zero files and the gate fails closed. That is
  the desired behavior — the implementer must update the gate before
  merging.
- Risk: the hash glob expands to two files per page (the `.js` and
  the `.lean.js` sibling), each carrying the same prose. Grepping
  both is intentional; the cost is negligible and it guards against
  a future VitePress mode that ships only one of the two.

## Non-goals (unchanged from r3)

See [02-design-r3.md](02-design-r3.md#L156-L162). Widening the dist
gate to the three named asset chunks does **not** open the whole
assets directory or the client-app bundle as in-scope for any other
audit; the three globs are the only addition.
