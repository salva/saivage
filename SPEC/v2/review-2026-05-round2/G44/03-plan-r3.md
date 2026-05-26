# G44 — Implementation plan r3

Implements Proposal A as carried forward in
[02-design-r3.md](02-design-r3.md): targeted rewrite of two internals
docs, one extra table-cell fix in
[docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28),
plus a docs rebuild. No source code changes.

Round 2 plan is at [03-plan-r2.md](03-plan-r2.md); reviewer findings
are at [04-review-r2.md](04-review-r2.md). The substantive changes
in this round, all confined to verification and to one extra table
cell:

1. The single over-broad stale-string grep from
   [03-plan-r2.md](03-plan-r2.md#L221-L229) and
   [03-plan-r2.md](03-plan-r2.md#L255-L257) is replaced by a
   partitioned gate per
   [02-design-r3.md](02-design-r3.md#L84-L135): a cross-doc-clean
   alternation plus a per-pattern file-scoped check. The token
   `stop\(\)` is dropped (covered by the `interface Channel`
   removal in channels.md; the only other occurrence is the valid
   `startServer` return type in
   [docs/internals/server.md](../../../../docs/internals/server.md#L48)).
   The token `One-shot CLI` is checked only against
   [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md)
   so the valid Planner heading in
   [docs/guide/quickstart.md](../../../../docs/guide/quickstart.md#L64)
   is not flagged.
2. A new Step 2c is added: fix the `ChatLogSchema` row in
   [docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28)
   so the path matches reality. One table cell, no other change to
   the file.
3. Pre-flight check 7 is updated to match the new partitioned gate
   (cross-doc-clean tokens checked tree-wide; file-scoped tokens
   checked against their specific files plus data-model.md).

Steps 1, 2a, 2b, 4, 6, 7, and the rollback section are unchanged
from [03-plan-r2.md](03-plan-r2.md). Step 3 (sanity grep) and Step 5
(post-build verification) are replaced. Step 2c is new.

## Pre-flight verification

Checks 1-6 from
[03-plan-r2.md](03-plan-r2.md#L25-L62) stand unchanged. Check 7 is
replaced by the following two checks; both must record line numbers
before editing so the post-edit gate can be compared against a
known baseline:

7a. Cross-doc-clean baseline, run from `saivage/`:

```
grep -rnE 'channels/(cli|oneshot|index)\.ts|publish\(event|chat-chunk|Three concrete channel implementations|start\(runtime' docs/*.md docs/**/*.md
```

Expected hits before editing: all inside
[docs/internals/channels.md](../../../../docs/internals/channels.md)
and
[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md).
Zero hits outside those two files. If a fresh hit appears anywhere
else, stop and update analysis r3.

7b. File-scoped baseline, run from `saivage/`:

```
grep -nE 'interface Channel\b' docs/internals/channels.md
grep -nE 'One-shot CLI' docs/internals/agent-chat.md
grep -nE 'tmp/chats/<sessionId>\.json' docs/internals/agent-chat.md docs/internals/data-model.md
```

Expected: at least one hit in each named file. If any of these
greps return zero hits, the drift has already partly been fixed
upstream — stop and re-check analysis r3 before continuing.

Also confirm that the valid prose lines that the round 2 gate
would have falsely flagged are still present (so we know we did
not accidentally fix them out of scope):

```
grep -nE 'stop\(\)' docs/internals/server.md
grep -nE 'One-shot CLI' docs/guide/quickstart.md
```

Expected: one hit each, at
[docs/internals/server.md](../../../../docs/internals/server.md#L48)
and
[docs/guide/quickstart.md](../../../../docs/guide/quickstart.md#L64).
Do not modify either file.

## Step 1 — Rewrite docs/internals/channels.md

Unchanged from [03-plan-r2.md](03-plan-r2.md#L64-L189). Apply that
step verbatim.

## Step 2 — Update docs/internals/agent-chat.md

### Step 2a — `## Channels` list

Unchanged from [03-plan-r2.md](03-plan-r2.md#L193-L213). Apply that
step verbatim.

### Step 2b — `## Sessions` chat-log path

Unchanged from [03-plan-r2.md](03-plan-r2.md#L215-L233). Apply that
step verbatim.

### Step 2c — Fix the ChatLogSchema row in data-model.md (NEW)

In [docs/internals/data-model.md](../../../../docs/internals/data-model.md),
the persisted-shapes table currently contains the row:

```
| `ChatLogSchema` | `<project>/.saivage/tmp/chats/<sessionId>.json` |
```

at [data-model.md](../../../../docs/internals/data-model.md#L28).
Replace the path cell so the row reads:

```
| `ChatLogSchema` | `<project>/.saivage/tmp/chats/<channel>/<sessionId>.json` |
```

Source-of-truth for the new path is the same code that justifies
the agent-chat.md edit:
[src/agents/chat.ts](../../../../src/agents/chat.ts#L98-L104) (the
per-channel directory) and
[src/agents/chat.ts](../../../../src/agents/chat.ts#L398-L400) (the
`<sessionId>.json` filename).

Hard constraints:

- Do not touch any other row of the persisted-shapes table.
- Do not edit any other section of `data-model.md` (Cross-references,
  ID schemes, etc.).
- The literal string `tmp/chats/<sessionId>.json` (flat, no
  `<channel>` segment) must not appear anywhere in `data-model.md`
  after the edit.

## Step 3 — Sanity grep (replaces r2 step 3)

Run both grep invocations from `saivage/`. Both must return zero
matches outside the SPEC review trail.

### Step 3a — Cross-doc-clean check

```
grep -rnE 'channels/(cli|oneshot|index)\.ts|publish\(event|chat-chunk|Three concrete channel implementations|start\(runtime' docs/*.md docs/**/*.md
```

Expected: zero matches.

If any match appears in a file outside the round 3 edit map, stop
and fix it in the same commit (it is the same root-cause drift as
G44 by definition — the alternation only contains tokens with no
legitimate use anywhere in `docs/`). If a match remains inside
[docs/internals/channels.md](../../../../docs/internals/channels.md)
or
[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md),
the rewrite missed a token — re-read step 1 / step 2.

### Step 3b — File-scoped check

```
grep -nE 'interface Channel\b' docs/internals/channels.md
grep -nE 'One-shot CLI' docs/internals/agent-chat.md
grep -nE 'tmp/chats/<sessionId>\.json' docs/internals/agent-chat.md docs/internals/data-model.md
```

Expected: zero matches from each invocation.

Do **not** widen these greps to other files. The valid
`startServer` lifecycle return type in
[docs/internals/server.md](../../../../docs/internals/server.md#L48)
and the valid Planner heading in
[docs/guide/quickstart.md](../../../../docs/guide/quickstart.md#L64)
are correct prose and must remain untouched.

If a match remains in any of the named files, the relevant step
(1, 2a, 2b, or 2c) was incomplete — re-read it before re-running.

## Step 4 — Rebuild the docs site

Unchanged from [03-plan-r2.md](03-plan-r2.md#L243-L253). Apply that
step verbatim. Note that the dist tree will now include a
regenerated
`docs/.vitepress/dist/internals/data-model.html` and a new hashed
asset for it; commit those alongside the channels and agent-chat
regenerations.

## Step 5 — Post-build verification (replaces r2 step 5)

The same partitioned gate as step 3, repeated against the rebuilt
dist tree.

### Step 5a — Cross-doc-clean check on dist

```
grep -rnE 'channels/(cli|oneshot|index)\.ts|publish\(event|chat-chunk|Three concrete channel implementations|start\(runtime' docs/.vitepress/dist
```

Expected: zero matches.

### Step 5b — File-scoped check on dist

```
grep -nE 'interface Channel\b' docs/.vitepress/dist/internals/channels.html
grep -nE 'One-shot CLI' docs/.vitepress/dist/internals/agent-chat.html
grep -nE 'tmp/chats/&lt;sessionId&gt;\.json|tmp/chats/<sessionId>\.json' docs/.vitepress/dist/internals/agent-chat.html docs/.vitepress/dist/internals/data-model.html
```

Note: the rebuilt HTML escapes `<` and `>` as `&lt;` / `&gt;`
inside `<code>` blocks, so the flat-path check uses an alternation
that matches both raw and entity-encoded forms. Expected: zero
matches.

If the asset chunks under `docs/.vitepress/dist/assets/*.js` get
filename-hash bumps without the corresponding HTML changes, treat
that as a clue that the build cached the old markdown; rerun
`npm run docs:build` from a clean working tree and re-check.

### Step 5c — Spot-checks

Spot-check the three rebuilt internals pages:

1. `docs/.vitepress/dist/internals/channels.html` — the "CLI
   channel" and "One-shot channel" headings must be gone; the
   "Concrete-channel extensions" heading must be present; the
   `chat-chunk` token must be absent.
2. `docs/.vitepress/dist/internals/agent-chat.html` — the
   "One-shot CLI" bullet must be gone; the inspect-flow sentence
   must be present; the `## Sessions` path must show the
   `<channel>` segment.
3. `docs/.vitepress/dist/internals/data-model.html` — the
   `ChatLogSchema` row must show the `<channel>` segment.

Then run the workspace's standard docs lint, if any
(`npm run docs:lint` if present — otherwise skip).

## Step 6 — Commit / PR

Unchanged from [03-plan-r2.md](03-plan-r2.md#L283-L308), with two
small additions to the PR body / reviewer checklist:

- Mention that `data-model.md`'s `ChatLogSchema` row is fixed in the
  same commit and explain why (same drift, same root cause).
- Reviewer checklist now also confirms: no flat
  `tmp/chats/<sessionId>.json` (and no entity-encoded form of it)
  in `data-model.md` or its rebuilt dist HTML; `data-model.html`
  is regenerated and committed.

## Step 7 — Cross-issue handoff

Unchanged from [03-plan-r2.md](03-plan-r2.md#L310-L315).

## Out-of-scope (delta from r2)

The non-goals list from
[03-plan-r2.md](03-plan-r2.md#L317-L334) stands without change. The
new `data-model.md` table-cell edit does **not** open data-model
docs as in-scope for any other refactor; the one cell is the only
change, and the rest of the file is explicitly out of scope.

## Rollback

Unchanged from [03-plan-r2.md](03-plan-r2.md#L336-L340). A single
revert restores the prior (stale) state across all three source
files and the dist tree.
