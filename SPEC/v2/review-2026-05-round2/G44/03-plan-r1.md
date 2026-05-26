# G44 — Implementation plan r1

Implements Proposal A from
[02-design-r1.md](02-design-r1.md): targeted rewrite of two internals
docs, plus a docs rebuild. No source code changes.

## Pre-flight verification

Before editing, confirm reality has not drifted further since the
analysis. Run:

1. `ls saivage/src/channels` — expect exactly `telegram.test.ts`,
   `telegram.ts`, `types.ts`, `websocket.ts`. Abort and re-analyse if
   anything else is present.
2. `sed -n '1,20p' saivage/src/channels/types.ts` — confirm the four
   members are still `send`, `onMessage`, `onClose`, `close` and no
   new members were added.
3. `grep -nE 'sendEvent|chatId|publish' saivage/src/channels/{telegram,websocket}.ts`
   — confirm `sendEvent` exists on both, `chatId` on Telegram, no
   `publish` anywhere.
4. `sed -n '215,255p' saivage/src/server/cli.ts` — confirm the
   `inspect` subcommand still imports `InspectorAgent` directly and
   never constructs a channel.
5. `grep -nE 'channels/(cli|oneshot|index)\.ts' saivage/docs/internals/*.md`
   — record the exact line numbers; these must all be gone after the
   rewrite.

If any check fails, stop and update the analysis before proceeding.

## Step 1 — Rewrite `docs/internals/channels.md`

Replace the body of
[docs/internals/channels.md](../../../../docs/internals/channels.md)
with the following structure. Keep the existing top-of-page repo link
and headline `# Channels`.

Sections (in order):

1. **Intro paragraph** — one sentence: a channel bridges a user
   transport to a Chat agent; the runtime currently ships two
   implementations; the shared contract lives in
   [src/channels/types.ts](../../../../src/channels/types.ts).
2. **Interface** — reproduce the `ChatChannel` interface verbatim
   inside a `ts` fenced block from
   [src/channels/types.ts](../../../../src/channels/types.ts#L4-L17).
   Follow with a four-bullet list, one per method, each citing the
   line in `types.ts`.
3. **WebSocket channel** — describe
   [src/channels/websocket.ts](../../../../src/channels/websocket.ts):
   one instance per connected client, JSON envelope on send
   (`{ type: "message", content }`,
   see [websocket.ts](../../../../src/channels/websocket.ts#L35-L37)),
   typed events via the non-interface `sendEvent`
   (see [websocket.ts](../../../../src/channels/websocket.ts#L39-L44)).
   Note that `sendEvent` is consumed by route-level glue, not by the
   Chat agent, and is not part of `ChatChannel`.
4. **Telegram channel** — describe
   [src/channels/telegram.ts](../../../../src/channels/telegram.ts):
   one instance per Telegram chat, MarkdownV2 conversion via
   `telegramify-markdown` with a source-side splitter for the 4096-byte
   limit
   (see [telegram.ts](../../../../src/channels/telegram.ts#L1-L20)),
   the readonly `chatId: number` extension property
   (see [telegram.ts](../../../../src/channels/telegram.ts#L355-L362)),
   the non-interface `sendEvent`
   (see [telegram.ts](../../../../src/channels/telegram.ts#L375-L390)).
   Mention that slash-command wiring lives in
   `src/server/telegram-bot.ts` if a reader needs the registration
   code.
5. **Adding a channel** — three-step checklist:
   1. Implement the four-method `ChatChannel` contract from
      [src/channels/types.ts](../../../../src/channels/types.ts).
   2. Wire the channel into the bootstrap path that owns its
      transport (websocket in the dashboard route, Telegram in
      `src/server/telegram-bot.ts`).
   3. Add any credentials / allow-lists to `saivage.json` if the
      transport needs them.
6. **State** — keep the existing one-paragraph note that channels are
   stateless across daemon restarts. Verify during edit that the
   `.saivage/tmp/chats/<sessionId>.json` claim is still accurate by
   `grep -rn "tmp/chats" saivage/src`. If it is no longer accurate,
   delete the sentence rather than rewriting it (do not document a
   hypothetical path).

Hard constraints during the rewrite:

- Never use the strings `channels/cli.ts`, `channels/oneshot.ts`,
  `channels/index.ts`, `publish`, `start(runtime`, `stop()`, or
  `chat-chunk` anywhere in the file.
- Every method signature and envelope shape in prose must be
  accompanied by a deep link to a specific line range in `src/`.
- Do not introduce a "deprecated" or "removed in F35" appendix.

## Step 2 — Update `docs/internals/agent-chat.md`

In
[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md),
replace the `## Channels` section's three-bullet list (currently
[lines 36-41](../../../../docs/internals/agent-chat.md#L36-L41)) with:

- A two-bullet list:
  - Web —
    [src/channels/websocket.ts](../../../../src/channels/websocket.ts)
    — one Chat per connected client.
  - Telegram —
    [src/channels/telegram.ts](../../../../src/channels/telegram.ts)
    — one Chat per Telegram user, allow-listed via
    `telegram.allowedUserIds`.
- A single sentence after the list: the `saivage inspect <project>
  <scope>` CLI command does not use a channel; it constructs an
  `InspectorAgent` directly against the runtime (see
  [src/server/cli.ts](../../../../src/server/cli.ts#L219-L252)).

Hard constraint: the strings `oneshot`, `One-shot`, and `channels/oneshot.ts`
must not appear anywhere in `agent-chat.md` after the edit.

## Step 3 — Sanity grep

Run from `saivage/`:

```
grep -rnE 'channels/(cli|oneshot|index)\.ts|name: string;\s*//.*"cli"|publish\(event' docs/*.md docs/**/*.md
```

Expect zero matches outside `docs/.vitepress/dist/` (which will be
overwritten in Step 4) and outside the SPEC review tree (this file,
the issue file, and any other G44 round trail).

If any non-dist, non-SPEC match remains, fix it in the same commit.

## Step 4 — Rebuild the docs site

From `saivage/`:

```
npm run docs:build
```

Expect success. The build regenerates files under
`docs/.vitepress/dist/`; commit all changes in that tree alongside
the markdown edits. Old hash-named asset files removed by the build
must be removed from the commit too (`git add -A docs/.vitepress/dist`).

If the build fails, do not paper over it with a sidebar tweak; treat
it as a regression in the rewrite and re-read the markdown.

## Step 5 — Post-build verification

1. `grep -rnE 'channels/(cli|oneshot|index)\.ts' docs/.vitepress/dist`
   — expect zero matches (confirms the rebuilt site is clean).
2. Spot-check `docs/.vitepress/dist/internals/channels.html` — the
   "CLI channel" and "One-shot channel" headings must be gone.
3. Spot-check `docs/.vitepress/dist/internals/agent-chat.html` — the
   "One-shot CLI" bullet must be gone; the inspect-flow sentence must
   be present.
4. Run the workspace's standard docs lint, if any
   (`npm run docs:lint` if present — otherwise skip).

## Step 6 — Commit / PR

One commit, one PR:

- Title: `docs(internals): rewrite channels.md and agent-chat.md against post-F35 code (G44)`
- Body cites G44, the two analysed source files, and the
  pre-flight grep that confirms the cleanup.
- Reviewer checklist:
  - No `channels/cli.ts` / `channels/oneshot.ts` / `channels/index.ts`
    in the diff or in `docs/.vitepress/dist`.
  - Every interface / envelope claim in the new prose has a deep link
    next to it.
  - `npm run docs:build` was run; the dist tree in the diff is
    consistent with the source edits.

## Step 7 — Cross-issue handoff

Mark in [00-INDEX.md](../00-INDEX.md) — when the metaplan is updated
— that G44 is `[done]` and that the docs-drift lint level-up is
deferred to G40. G44 itself does not edit the index in this PR;
indexing is the metaplan owner's job.

## Out-of-scope (explicitly)

- Designing or implementing the `docs/**.md` → `src/**.ts` reference
  lint. That is G40's level-up; G44 simply consumes it once it ships.
- Touching
  [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md).
  It already records the F35 deletions correctly.
- Editing any source under `src/channels/` or `src/server/`.
- Re-evaluating whether `docs/internals/channels.md` should exist as a
  standalone page (Proposal C was rejected).
- Adding migration / deprecation prose about the removed channels.

## Rollback

Single revert of the docs commit restores the prior (stale) state.
No data, schema, or runtime artefacts are touched, so rollback is
free.
