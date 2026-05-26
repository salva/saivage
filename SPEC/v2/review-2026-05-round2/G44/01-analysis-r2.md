# G44 — Analysis r2

Round 2 of the analysis. Round 1 lives at
[01-analysis-r1.md](01-analysis-r1.md); the reviewer's findings are in
[04-review-r1.md](04-review-r1.md). The substantive corrections in this
round are:

1. `sendEvent` is **not** only a registration-glue extension — the live
   ChatAgent calls it directly. The analysis is rewritten to describe
   it as an optional concrete-channel extension consumed by ChatAgent
   (primary caller) and by WebSocket route glue (one site).
2. The chat-log path on disk includes a per-channel subdirectory; this
   round corrects that fact and brings the adjacent
   [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L55-L59)
   sentence into scope (the file is already being edited for the
   channels list, so fixing one nearby stale string in the same edit is
   smaller than carving it out).
3. The acceptance criteria now enumerate every stale string the rewrite
   has to remove, so the post-edit grep can verify the entire claim
   surface, not just removed file paths.

## Scope

[docs/internals/channels.md](../../../../docs/internals/channels.md) and
[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md)
describe a `Channel` plugin abstraction (`name / start / stop /
publish`), a `channels/cli.ts` ad-hoc CLI channel, and a
`channels/oneshot.ts` synchronous channel that the `saivage inspect`
flow allegedly uses. F35 deleted all three implementations plus the
`channels/index.ts` barrel; the runtime now ships only two channel
implementations with a much smaller contract. The same two docs also
mis-describe the WebSocket envelope (`chat-chunk`) and the chat-log
path (no per-channel directory).

## Verified facts

### What the internals docs currently claim

1. There is a `Channel` interface in
   [src/channels/types.ts](../../../../src/channels/types.ts) with four
   members: a string `name`, `start(runtime)`, `stop()`, and a
   `publish(event)` method invoked by the EventBus. See
   [docs/internals/channels.md](../../../../docs/internals/channels.md#L10-L17).
2. [channels/cli.ts](../../../../docs/internals/channels.md#L22-L27)
   exists and is used implicitly by the `saivage` CLI for one-off
   Chat-style interactions, e.g. `inspect`.
3. [channels/oneshot.ts](../../../../docs/internals/channels.md#L29-L34)
   exists and is the entry point used by `saivage inspect <scope>` to
   render a single Inspector dispatch on stdout. The same claim is
   repeated in
   [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L39-L40).
4. Adding a channel involves implementing the four-method `Channel`
   contract and registering it in `bootstrap()`. See
   [docs/internals/channels.md](../../../../docs/internals/channels.md#L51-L58).
5. The dashboard websocket envelope is `chat-chunk` for streaming
   deltas. See
   [docs/internals/channels.md](../../../../docs/internals/channels.md#L42-L44).
6. Chat session logs are stored at
   `.saivage/tmp/chats/<sessionId>.json` — flat, no channel
   subdirectory. See
   [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L55-L59).

### What the code actually shows

1. The real interface is
   [ChatChannel](../../../../src/channels/types.ts#L5-L17) and has
   exactly four members: `send(message)`, `onMessage(handler)`,
   `onClose(handler)`, `close()`. There is no `name`, no `start`, no
   `stop`, no `publish`, and no reference to a `SaivageRuntime`
   parameter.
2. [src/channels/](../../../../src/channels) contains four files:
   [src/channels/types.ts](../../../../src/channels/types.ts),
   [src/channels/telegram.ts](../../../../src/channels/telegram.ts),
   [src/channels/websocket.ts](../../../../src/channels/websocket.ts),
   and a `telegram.test.ts`. There is no `cli.ts`, no `oneshot.ts`, no
   `index.ts` barrel.
3. The `inspect` CLI command in
   [src/server/cli.ts](../../../../src/server/cli.ts#L219-L252)
   instantiates `InspectorAgent` directly against the runtime; it does
   not open Chat, does not construct any channel, and does not stream
   through stdin/stdout under a channel abstraction.
4. Both concrete channels expose a non-interface `sendEvent(event)`
   method (see
   [src/channels/websocket.ts](../../../../src/channels/websocket.ts#L39-L43)
   and
   [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L373-L378)).
   `TelegramChannel` also exposes a readonly `chatId: number` —
   Telegram's chat identifier — at
   [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L358-L362).
   These are channel-specific extensions, not part of `ChatChannel`.
5. **The Chat agent itself uses `sendEvent`.** ChatAgent calls it
   through a typed cast at
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L208-L210) to
   emit a `thinking` envelope before running an LLM turn, and at
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L388-L394) to
   emit the assistant `message` envelope on non-Telegram channels
   (Telegram falls back to `channel.send`). The optional shape is
   declared inline in those call sites:
   `ChatChannel & { sendEvent?: (e: Record<string, unknown>) => void }`.
   WebSocket route glue uses it once more, at
   [src/server/server.ts](../../../../src/server/server.ts#L692-L693),
   to emit a `session` envelope so the browser knows the session id on
   reconnect. **No other production code paths call `sendEvent`.**
6. The websocket envelope sent by `send()` is
   `{ type: "message", content: <string> }`, not `chat-chunk` — see
   [src/channels/websocket.ts](../../../../src/channels/websocket.ts#L35-L37).
   `WebSocketChannel.send` is implemented as
   `this.sendEvent({ type: "message", content: message })`, so the
   "envelope" claim and the "non-interface extension" claim share a
   single source-of-truth line range.
7. There is no `EventBus → channel.publish` path: notifications/events
   reach the user via the Chat agent's `handleEvent`, which calls
   `channel.send(...)` at
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L364-L373).
   No channel implementation has a `publish` method.
8. The chat-log path on disk includes a per-channel subdirectory.
   `ChatAgent` builds the directory as
   `.saivage/tmp/chats/<channel>` at
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L98-L104) and
   writes `<sessionId>.json` underneath it at
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L398-L400). The
   flat path in
   [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L55-L59)
   is wrong.

### `sendEvent` ownership summary

| Caller | Site | Purpose |
| --- | --- | --- |
| ChatAgent | [src/agents/chat.ts](../../../../src/agents/chat.ts#L208-L210) | `thinking` envelope before LLM turn |
| ChatAgent | [src/agents/chat.ts](../../../../src/agents/chat.ts#L388-L394) | `message` envelope (non-Telegram path) |
| WebSocket route glue | [src/server/server.ts](../../../../src/server/server.ts#L692-L693) | `session` envelope on connection setup |

This means round 1's "registration-glue-only" framing was wrong: the
primary caller is the Chat agent itself, and the route glue uses it
exactly once. The rewrite must describe `sendEvent` as an optional
concrete-channel extension used by ChatAgent (and, in one place, by
WebSocket setup), not as a registration-only feature.

## Severity / impact

Documentation regression, medium. The two doc files are the only
narrative description of the channel layer; a newcomer reading them
and trying to add (say) a Discord channel will:

- implement an interface that does not exist;
- look for `channels/index.ts` to import the contract from and not
  find it;
- read [agent-chat.md](../../../../docs/internals/agent-chat.md#L39-L40)
  and look in `channels/oneshot.ts` for the inspect entry point and
  find nothing;
- copy the `publish` shape and discover the EventBus has no such
  consumer;
- copy the `chat-chunk` envelope shape and find nothing emits it;
- look on disk at `.saivage/tmp/chats/<sessionId>.json` and not find
  the log because it is one directory deeper.

There is no runtime bug, no behaviour change, and no user-visible
regression — but every internals reader is mis-trained.

## Issue-level inaccuracies to correct in the design

The G44 issue body asserts that the real `ChatChannel` exposes
`send / sendEvent / onMessage / onClose / close / chatId`. That is
slightly wrong: `sendEvent` and `chatId` are **not** members of
`ChatChannel`; they are implementation-specific surface on the
concrete classes. The doc rewrite must reflect the actual interface
(4 methods) and call the extra surface out separately so we do not
introduce a new, opposite drift. In particular the rewrite must:

- describe `sendEvent` as an **optional** extension that both
  shipped concrete channels happen to implement, that ChatAgent
  calls through a structural-type cast, and that WebSocket route
  setup uses once;
- describe `chatId` as Telegram-specific routing metadata, not a
  cross-channel concept.

## Built dist drift

The VitePress build output under
`docs/.vitepress/dist/internals/channels.html` and the asset chunk
`docs/.vitepress/dist/assets/internals_channels.md.mA2guGXo.js` carry
the stale text too. They are regenerated on `docs:build`, so they
need no source change, but the docs build must be re-run after the
source fix so any deploy artefact tracked in-tree is refreshed. We
do not need to delete the dist directory as part of this issue —
that is the docs build's job — but if the dist tree is committed (it
is, today), the post-fix `docs:build` artefacts must be committed in
the same change so the published site does not lag the source.

## Adjacent drift in scope

[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L55-L59)
is already being edited by G44 (the `## Channels` section a few
lines above). While the file is open, fix the
`.saivage/tmp/chats/<sessionId>.json` sentence to the live shape
`.saivage/tmp/chats/<channel>/<sessionId>.json` per the code at
[src/agents/chat.ts](../../../../src/agents/chat.ts#L98-L104) and
[src/agents/chat.ts](../../../../src/agents/chat.ts#L398-L400). This
is one string change in a file we are already touching; carving it
out would cost more SPEC bytes than the fix.

It is in scope as a one-line correction only. We do **not** rewrite
the rest of `agent-chat.md` (no scope creep into the rest of the
Chat agent doc — only the channels list and the one path string).

## Cross-links

- F35 — original deletion. No reopening; this is purely a docs
  catch-up.
- G40 — `docs/guide/web-ui.md` user-facing drift. Both share the
  same root cause (no docs lint in the F35 PR) and the same
  prevention idea (level-up). The lint design is shared, not
  duplicated here; G44 just consumes the lint when G40 ships it.
- G45 — `docs/internals/server.md` describes a stale
  `SaivageRuntime` shape. Same root cause and lint applicability.
- G11 — references G44 only as a downstream consumer of the chat
  control-channel docs once Chat restart prose is rewritten. No
  blocker.

## Project rules applied

- No backward-compat shim, no "deprecated channel" appendix, no
  migration note for the removed CLI/oneshot channels: F35 already
  removed them and the SPEC was the ledger entry. The docs simply
  describe the present.
- No new abstractions, no new generated tables. The fix is a
  targeted rewrite of two markdown files plus a docs rebuild.
- The level-up (a CI lint that fails when `docs/**/*.md` mentions a
  non-existent `src/**/*.ts` path) is recorded as a follow-up at
  the metaplan level (G40 will own the lint design). G44 itself
  stops at the doc rewrite so we do not over-engineer a docs-drift
  PR into a CI-platform change.
- The new project-wide principles (no regex parsing of user intent,
  no hardcoded values, no fragile heuristics) do not apply here:
  the fix is markdown prose with no runtime behaviour. Recorded for
  awareness only.

## Stale-string inventory (must all be gone after rewrite)

The following strings appear in source markdown today and must be
absent from both the rewritten source markdown and the rebuilt dist
HTML / JS after the fix. This is the canonical list the plan's
sanity grep must check.

| Stale string | Source location |
| --- | --- |
| `channels/cli.ts` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L22-L27) |
| `channels/oneshot.ts` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L29-L34), [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L39-L40) |
| `channels/index.ts` | (claimed by the issue body; verify with grep — must be zero in source after the rewrite) |
| `interface Channel` (the four-member shape) | [docs/internals/channels.md](../../../../docs/internals/channels.md#L10-L17) |
| `start(runtime` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L13) |
| `stop()` (as a channel method) | [docs/internals/channels.md](../../../../docs/internals/channels.md#L14) |
| `publish(event` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L15) |
| `chat-chunk` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L42-L44) |
| `One-shot CLI` | [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L39) |
| `Three concrete channel implementations` | [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L33) |
| `.saivage/tmp/chats/<sessionId>.json` (flat) | [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L57-L58) |

Any of these surviving in `docs/**/*.md` (outside SPEC review trails)
or in `docs/.vitepress/dist/**` after the rewrite + rebuild is a
review blocker.

## Acceptance criteria

1. [docs/internals/channels.md](../../../../docs/internals/channels.md)
   describes the real `ChatChannel` interface from
   [src/channels/types.ts](../../../../src/channels/types.ts#L5-L17),
   the two shipped implementations
   ([websocket.ts](../../../../src/channels/websocket.ts),
   [telegram.ts](../../../../src/channels/telegram.ts)), and the
   channel-specific extensions (`sendEvent`, `chatId`) without
   pretending they are on the interface. The prose describes
   `sendEvent` as an optional concrete-channel extension called by
   ChatAgent and by one WebSocket-setup site in
   [src/server/server.ts](../../../../src/server/server.ts#L692-L693).
2. [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md)
   no longer references `channels/oneshot.ts` or
   "Three concrete channel implementations"; the inspect flow is
   described as in-process against the runtime, citing
   [src/server/cli.ts](../../../../src/server/cli.ts#L219-L252). The
   chat-log path sentence reflects the per-channel subdirectory at
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L98-L104).
3. Every stale string in the inventory table above is absent from
   `docs/**/*.md` (outside SPEC review trails) and from
   `docs/.vitepress/dist/**` after the rewrite + rebuild.
4. `npm run docs:build` succeeds and the rebuilt
   `docs/.vitepress/dist/internals/channels.html` and
   `docs/.vitepress/dist/internals/agent-chat.html` reflect the new
   source.
5. The websocket envelope description in the rewritten file matches
   what `WebSocketChannel.send` and `WebSocketChannel.sendEvent`
   actually emit (`{ type, ...rest }` JSON, with
   `{ type: "message", content }` as the `send`-emitted envelope —
   see
   [src/channels/websocket.ts](../../../../src/channels/websocket.ts#L34-L43)).
