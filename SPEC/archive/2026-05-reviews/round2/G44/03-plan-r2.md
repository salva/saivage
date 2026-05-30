# G44 — Implementation plan r2

Implements Proposal A from [02-design-r2.md](02-design-r2.md): targeted
rewrite of two internals docs (with one extra in-scope path-string
fix), plus a docs rebuild. No source code changes.

Round 1 plan is at [03-plan-r1.md](03-plan-r1.md); reviewer findings
are at [04-review-r1.md](04-review-r1.md). The substantive changes in
this round:

1. The `## Concrete-channel extensions` section in the rewrite must
   enumerate the ChatAgent call sites for `sendEvent`, not describe
   them as registration-glue.
2. The sanity grep covers every stale token from the analysis r2
   inventory, not only removed file paths — in particular
   `chat-chunk`, `interface Channel`, `start(runtime`, `stop()`,
   `Three concrete channel implementations`.
3. The `agent-chat.md` edit fixes the `## Sessions` chat-log path
   in the same commit; pre-flight and post-flight greps verify the
   new per-channel form.

## Pre-flight verification

Before editing, confirm reality has not drifted further since the
analysis. Run from the workspace root unless noted; commands are
written so they can be pasted verbatim.

1. `ls saivage/src/channels` — expect exactly `telegram.test.ts`,
   `telegram.ts`, `types.ts`, `websocket.ts`. Abort and re-analyse
   if anything else is present.
2. `sed -n '1,20p' saivage/src/channels/types.ts` — confirm the four
   members are still `send`, `onMessage`, `onClose`, `close` and no
   new members were added.
3. `grep -nE 'sendEvent|chatId|publish' saivage/src/channels/telegram.ts saivage/src/channels/websocket.ts`
   — confirm `sendEvent` exists on both, `chatId` on Telegram, no
   `publish` anywhere.
4. `grep -nE 'sendEvent' saivage/src/agents/chat.ts saivage/src/server/server.ts`
   — confirm three call sites total: two in `chat.ts` (thinking +
   non-Telegram message) and one in `server.ts` (session envelope).
   If the count or files have changed, stop and update analysis r2's
   ownership table before editing the docs.
5. `sed -n '215,255p' saivage/src/server/cli.ts` — confirm the
   `inspect` subcommand still imports `InspectorAgent` directly and
   never constructs a channel.
6. `sed -n '95,110p;395,405p' saivage/src/agents/chat.ts` — confirm
   the chat log path is built as `tmp/chats/<channel>` then
   `<sessionId>.json`. If the layout has changed, update the
   `## Sessions` rewrite below before applying.
7. `grep -nE 'channels/(cli|oneshot|index)\.ts|chat-chunk|interface Channel|start\(runtime|publish\(event|Three concrete channel implementations' saivage/docs/internals/channels.md saivage/docs/internals/agent-chat.md`
   — record exact line numbers; these must all be gone from the
   source after step 1/step 2 and from the dist after step 4.

If any check fails, stop and update the analysis before
proceeding.

## Step 1 — Rewrite docs/internals/channels.md

Replace the body of
[docs/internals/channels.md](../../../../docs/internals/channels.md)
with the following structure. Keep the existing top-of-page repo
link and headline `# Channels`.

Sections (in order):

1. **Intro paragraph** — one sentence: a channel bridges a user
   transport to a Chat agent; the runtime currently ships two
   implementations; the shared contract lives in
   [src/channels/types.ts](../../../../src/channels/types.ts).

2. **Interface** — reproduce the `ChatChannel` interface verbatim
   inside a `ts` fenced block from
   [src/channels/types.ts](../../../../src/channels/types.ts#L5-L17).
   Follow with a four-bullet list, one per method, each citing the
   declaration line in `types.ts`.

3. **Concrete-channel extensions** — describe the two non-interface
   surface elements:
   - `sendEvent(event)` — implemented by both shipped channels
     ([websocket.ts](../../../../src/channels/websocket.ts#L39-L43),
     [telegram.ts](../../../../src/channels/telegram.ts#L373-L378)).
     Callers reach it through a structural-type cast pattern,
     `ChatChannel & { sendEvent?: (e: Record<string, unknown>) =>
     void }`, so it is optional from the caller's point of view
     even though both shipped channels implement it. Enumerate the
     callers explicitly:
     - ChatAgent, `thinking` envelope before each LLM turn —
       [src/agents/chat.ts](../../../../src/agents/chat.ts#L208-L210).
     - ChatAgent, assistant `message` envelope on non-Telegram
       channels —
       [src/agents/chat.ts](../../../../src/agents/chat.ts#L388-L394).
     - WebSocket route setup, `session` envelope once per
       connection —
       [src/server/server.ts](../../../../src/server/server.ts#L692-L693).
     State that on Telegram, `sendEvent` only forwards `message`
     events (it discards `thinking` and other internal types) —
     see
     [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L373-L378).
   - `chatId: number` — Telegram-only readonly identifier exposed
     for routing; see
     [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L358-L362).
     Not a cross-channel concept.

   Close the section with one sentence: neither extension is part
   of the `ChatChannel` interface in
   [src/channels/types.ts](../../../../src/channels/types.ts#L5-L17),
   so a new channel implementation is not obliged to provide
   either — but a channel intended for the dashboard's typed
   front-end should implement `sendEvent` to avoid falling back to
   plain-text frames.

4. **WebSocket channel** — describe
   [src/channels/websocket.ts](../../../../src/channels/websocket.ts):
   one instance per connected client, JSON envelope on `send`
   (`{ type: "message", content }` — see
   [websocket.ts](../../../../src/channels/websocket.ts#L34-L37)),
   typed events via `sendEvent` (see
   [websocket.ts](../../../../src/channels/websocket.ts#L39-L43)),
   incoming JSON envelope parsing for `{ type: "message", content }`
   client frames at
   [websocket.ts](../../../../src/channels/websocket.ts#L17-L28).
   Refer back to the extensions section for `sendEvent` instead of
   re-explaining it.

5. **Telegram channel** — describe
   [src/channels/telegram.ts](../../../../src/channels/telegram.ts):
   one instance per Telegram chat, MarkdownV2 conversion via
   `telegramify-markdown` with a source-side splitter for the
   4096-byte limit (see
   [telegram.ts](../../../../src/channels/telegram.ts#L1-L20)),
   the readonly `chatId: number` extension (see
   [telegram.ts](../../../../src/channels/telegram.ts#L358-L362)),
   the message-only filtering inside `sendEvent` (see
   [telegram.ts](../../../../src/channels/telegram.ts#L373-L378)).
   Mention that slash-command wiring lives in
   `src/server/telegram-bot.ts` if a reader needs the registration
   code.

6. **Adding a channel** — four-step checklist:
   1. Implement the four-method `ChatChannel` contract from
      [src/channels/types.ts](../../../../src/channels/types.ts#L5-L17).
   2. Optionally implement `sendEvent(event)` if the channel's
      front-end consumes typed envelopes (the dashboard does;
      Telegram is a "message-only" example).
   3. Wire the channel into the bootstrap path that owns its
      transport (websocket setup in
      [src/server/server.ts](../../../../src/server/server.ts#L692-L693),
      Telegram in `src/server/telegram-bot.ts`).
   4. Add any credentials / allow-lists to `saivage.json` if the
      transport needs them.

7. **State** — one paragraph: channels are stateless across daemon
   restarts; their connections drop when the daemon stops and
   reconnect on resume. Chat session history is owned by the
   ChatAgent, not by the channel; see the Sessions section of
   [agent-chat.md](../../../../docs/internals/agent-chat.md) for
   the on-disk layout. **Do not** restate the path here; that is
   the agent-chat doc's job, and duplicating it is what created
   the original drift.

Hard constraints during the rewrite:

- Never use the strings `channels/cli.ts`, `channels/oneshot.ts`,
  `channels/index.ts`, `publish`, `interface Channel`,
  `start(runtime`, `stop()` (as a channel method), or
  `chat-chunk` anywhere in the file.
- Every method signature, envelope shape, and `sendEvent` call
  site in prose must be accompanied by a deep link to a specific
  line range in `src/`.
- Do not introduce a "deprecated" or "removed in F35" appendix.
- Do not describe `sendEvent` as registration-glue-only. The
  primary caller is the Chat agent itself.

## Step 2 — Update docs/internals/agent-chat.md

Two targeted edits in
[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md);
no other prose changes.

### Step 2a — `## Channels` list

Replace the existing `## Channels` section
([currently lines 32-40](../../../../docs/internals/agent-chat.md#L32-L40))
with:

- A two-bullet list:
  - **Web** —
    [src/channels/websocket.ts](../../../../src/channels/websocket.ts)
    — one Chat per connected client.
  - **Telegram** —
    [src/channels/telegram.ts](../../../../src/channels/telegram.ts)
    — one Chat per Telegram user, allow-listed via
    `telegram.allowedUserIds`.
- A single sentence after the list: the
  `saivage inspect <project> <scope>` CLI command does not use a
  channel; it constructs an `InspectorAgent` directly against the
  runtime (see
  [src/server/cli.ts](../../../../src/server/cli.ts#L219-L252)).

Hard constraint: the strings `oneshot`, `One-shot`,
`channels/oneshot.ts`, and `Three concrete channel implementations`
must not appear anywhere in `agent-chat.md` after the edit.

### Step 2b — `## Sessions` chat-log path

In the `## Sessions` section
([currently lines 55-59](../../../../docs/internals/agent-chat.md#L55-L59)),
replace the sentence claiming logs are written to
`.saivage/tmp/chats/<sessionId>.json` with one that names the
actual layout: `.saivage/tmp/chats/<channel>/<sessionId>.json`,
citing
[src/agents/chat.ts](../../../../src/agents/chat.ts#L98-L104) (for
the directory) and
[src/agents/chat.ts](../../../../src/agents/chat.ts#L398-L400) (for
the file). Keep the "informational only" qualifier; do not rewrite
any other sentence in the section.

Hard constraint: the literal string `tmp/chats/<sessionId>.json`
(flat, no `<channel>` segment) must not appear anywhere in
`agent-chat.md` after the edit.

## Step 3 — Sanity grep

Run from `saivage/`:

```
grep -rnE 'channels/(cli|oneshot|index)\.ts|interface Channel\b|start\(runtime|stop\(\)|publish\(event|chat-chunk|Three concrete channel implementations|One-shot CLI|tmp/chats/<sessionId>\.json' docs/*.md docs/**/*.md
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

If the build fails, do not paper over it with a sidebar tweak;
treat it as a regression in the rewrite and re-read the markdown.

## Step 5 — Post-build verification

1. Run the same expanded grep over the rebuilt dist tree:
   ```
   grep -rnE 'channels/(cli|oneshot|index)\.ts|interface Channel\b|start\(runtime|stop\(\)|publish\(event|chat-chunk|Three concrete channel implementations|One-shot CLI|tmp/chats/<sessionId>\.json' docs/.vitepress/dist
   ```
   Expect zero matches.
2. Spot-check `docs/.vitepress/dist/internals/channels.html` — the
   "CLI channel" and "One-shot channel" headings must be gone; the
   "Concrete-channel extensions" heading must be present; the
   `chat-chunk` token must be absent.
3. Spot-check `docs/.vitepress/dist/internals/agent-chat.html` —
   the "One-shot CLI" bullet must be gone; the inspect-flow
   sentence must be present; the `## Sessions` path must show the
   `<channel>` segment.
4. Run the workspace's standard docs lint, if any
   (`npm run docs:lint` if present — otherwise skip).

## Step 6 — Commit / PR

One commit, one PR:

- Title:
  `docs(internals): rewrite channels.md and agent-chat.md against post-F35 code (G44)`
- Body cites G44, the analysed source files, and the pre-flight
  grep that confirms the cleanup.
- Reviewer checklist:
  - No `channels/cli.ts` / `channels/oneshot.ts` /
    `channels/index.ts` in the diff or in
    `docs/.vitepress/dist`.
  - No `chat-chunk`, no `interface Channel` four-member shape,
    no `start(runtime` / `stop()` channel method, no
    `Three concrete channel implementations`, no flat
    `tmp/chats/<sessionId>.json` in the diff or dist.
  - `sendEvent` is described as a concrete-channel extension
    with ChatAgent as the primary caller, not as
    registration-only.
  - Every interface / envelope / call-site claim in the new
    prose has a deep link next to it.
  - `npm run docs:build` was run; the dist tree in the diff is
    consistent with the source edits.

## Step 7 — Cross-issue handoff

Mark in [00-INDEX.md](../00-INDEX.md) — when the metaplan is
updated — that G44 is `[done]` and that the docs-drift lint
level-up is deferred to G40. G44 itself does not edit the index in
this PR; indexing is the metaplan owner's job.

## Out-of-scope (explicitly)

- Designing or implementing the `docs/**.md` → `src/**.ts`
  reference lint. That is G40's level-up; G44 simply consumes it
  once it ships.
- Touching
  [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md).
  It already records the F35 deletions correctly.
- Editing any source under `src/channels/`, `src/server/`, or
  `src/agents/`.
- Re-evaluating whether `docs/internals/channels.md` should exist
  as a standalone page (Proposal C was rejected).
- Adding migration / deprecation prose about the removed channels.
- Rewriting `agent-chat.md` outside the `## Channels` list and the
  one `## Sessions` path string.

## Rollback

Single revert of the docs commit restores the prior (stale) state.
No data, schema, or runtime artefacts are touched, so rollback is
free.
