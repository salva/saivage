# G44 — Analysis r1

## Scope

[docs/internals/channels.md](../../../../docs/internals/channels.md) and
[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md)
describe a `Channel` plugin abstraction (`name / start / stop / publish`),
a `channels/cli.ts` ad-hoc CLI channel, and a `channels/oneshot.ts`
synchronous channel that the `saivage inspect` flow allegedly uses. F35
deleted all three implementations plus the `channels/index.ts` barrel; the
runtime now ships only two channel implementations with a much smaller
contract.

## Verified facts

### What the internals docs currently claim

1. There is a `Channel` interface in `src/channels/types.ts` with four
   members: a string `name`, `start(runtime)`, `stop()`, and a
   `publish(event)` method invoked by the EventBus.
   See [docs/internals/channels.md](../../../../docs/internals/channels.md#L10-L17).
2. `channels/cli.ts` exists and is used implicitly by the `saivage` CLI
   for one-off Chat-style interactions, e.g. `inspect`.
   See [docs/internals/channels.md](../../../../docs/internals/channels.md#L22-L27).
3. `channels/oneshot.ts` exists and is the entry point used by
   `saivage inspect <scope>` to render a single Inspector dispatch on
   stdout. See
   [docs/internals/channels.md](../../../../docs/internals/channels.md#L29-L34)
   and [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L39-L40).
4. Adding a channel involves implementing the four-method `Channel`
   contract and registering it in `bootstrap()`.
   See [docs/internals/channels.md](../../../../docs/internals/channels.md#L51-L58).
5. The dashboard websocket envelope is `chat-chunk` for streaming deltas.
   See [docs/internals/channels.md](../../../../docs/internals/channels.md#L42-L44).

### What the code actually shows

1. The real interface is `ChatChannel` in
   [src/channels/types.ts](../../../../src/channels/types.ts#L4-L17) and
   has exactly four members: `send(message)`, `onMessage(handler)`,
   `onClose(handler)`, `close()`. There is **no** `name`, no `start`, no
   `stop`, no `publish`, and no reference to a `SaivageRuntime`
   parameter.
2. `src/channels/` contains four files only:
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
   method used by their owners to push typed envelopes (see
   [src/channels/websocket.ts](../../../../src/channels/websocket.ts#L39-L44)
   and
   [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L375-L390)).
   `TelegramChannel` also exposes a readonly `chatId: number` (Telegram's
   chat identifier), see
   [src/channels/telegram.ts](../../../../src/channels/telegram.ts#L355-L362).
   These are deliberately not on `ChatChannel`: they are channel-specific
   extensions consumed by the registration glue, not by the Chat agent.
5. The websocket envelope sent by `send()` is `{ type: "message",
   content: <string> }`, not `chat-chunk` — see
   [src/channels/websocket.ts](../../../../src/channels/websocket.ts#L35-L37).
6. There is no `EventBus → channel.publish` path: notifications/events
   reach the user via the Chat agent calling `channel.send(...)` or via
   route-level `sendEvent` calls, not via a channel-level publish
   contract.

## Severity / impact

Documentation regression, medium. The two doc files are the only
narrative description of the channel layer; a newcomer reading them and
trying to add (say) a Discord channel will:

- implement an interface that does not exist;
- look for `channels/index.ts` to import the contract from and not find
  it;
- read `agent-chat.md` and look in `channels/oneshot.ts` for the inspect
  entry point and find nothing;
- copy the `publish` shape and discover the EventBus has no such
  consumer.

There is no runtime bug, no behaviour change, and no user-visible
regression — but every internals reader is mis-trained.

## Issue-level inaccuracies to correct in the design

The G44 issue body asserts that the real `ChatChannel` exposes
`send / sendEvent / onMessage / onClose / close / chatId`. That is
slightly wrong: `sendEvent` and `chatId` are **not** members of
`ChatChannel`; they are implementation-specific surface on the concrete
classes. The doc rewrite must reflect the actual interface (4 methods)
and call the extra surface out separately so we do not introduce a new,
opposite drift.

## Built dist drift

The VitePress build output under
`docs/.vitepress/dist/internals/channels.html` and the asset chunk
`docs/.vitepress/dist/assets/internals_channels.md.mA2guGXo.js` carry
the stale text too. They are regenerated on `docs:build`, so they need
no source change, but the docs build must be re-run after the source
fix so any deploy artefact tracked in-tree is refreshed. We do not need
to delete the dist directory as part of this issue — that is the docs
build's job — but if the dist tree is committed (it is, today), the
post-fix `docs:build` artefacts must be committed in the same change so
the published site does not lag the source.

## Cross-links

- F35 — original deletion. No reopening; this is purely a docs catch-up.
- G40 — `docs/guide/web-ui.md` user-facing drift. Both share the same
  root cause (no docs lint in the F35 PR) and the same prevention idea
  (level-up). The lint design is shared, not duplicated here; G44 just
  consumes the lint when G40 ships it.
- G45 — `docs/internals/server.md` describes a stale `SaivageRuntime`
  shape. Same root cause and lint applicability.
- G11 — references G44 only as a downstream consumer of the chat
  control-channel docs once Chat restart prose is rewritten. No
  blocker.

## Constraints (project rules applied)

- No backward-compat shim, no "deprecated channel" appendix, no
  migration note for the removed CLI/oneshot channels: F35 already
  removed them and the SPEC was the ledger entry. The docs simply
  describe the present.
- No new abstractions, no new generated tables. The fix is a targeted
  rewrite of two markdown files plus a docs rebuild.
- The level-up (a CI lint that fails when `docs/**/*.md` mentions a
  non-existent `src/**/*.ts` path) is recorded as a follow-up at the
  metaplan level (G40 will own the lint design). G44 itself stops at
  the doc rewrite so we do not over-engineer a docs-drift PR into a
  CI-platform change.

## Acceptance criteria

1. `docs/internals/channels.md` describes the real `ChatChannel`
   interface from
   [src/channels/types.ts](../../../../src/channels/types.ts), the two
   shipped implementations
   ([websocket.ts](../../../../src/channels/websocket.ts),
   [telegram.ts](../../../../src/channels/telegram.ts)), and the
   channel-specific extensions (`sendEvent`, `chatId`) without
   pretending they are on the interface.
2. `docs/internals/agent-chat.md` no longer references
   `channels/oneshot.ts`; the inspect flow is described as in-process
   against the runtime, citing
   [src/server/cli.ts](../../../../src/server/cli.ts#L219-L252).
3. No remaining string `channels/cli.ts`, `channels/oneshot.ts`, or
   `channels/index.ts` anywhere under `docs/` source markdown.
4. `npm run docs:build` succeeds and the rebuilt
   `docs/.vitepress/dist/internals/channels.html` and
   `docs/.vitepress/dist/internals/agent-chat.html` reflect the new
   source.
5. The websocket envelope description in the rewritten file matches
   what `WebSocketChannel.sendEvent` actually emits (`{ type, ...
   }` JSON, with `{ type: "message", content }` as the message
   envelope).
