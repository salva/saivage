# G44 — `docs/internals/channels.md` still references files deleted in F35

- **Subsystem**: docs (`docs/internals/channels.md`, `docs/internals/agent-chat.md`)
- **Category**: documentation regression
- **Severity**: medium
- **Transversality**: regression of F35 (`channels/cli.ts`, `channels/oneshot.ts`,
  `channels/index.ts` deletion)

## Summary

F35 deleted the unused CLI and one-shot chat channels. The internals docs
were not updated and still describe a `Channel` plugin interface with `name /
start / stop / publish` methods, a CLI channel rooted at `channels/cli.ts`,
and a one-shot channel rooted at `channels/oneshot.ts`. None of those files
exist; the real `ChatChannel` interface lives in
`src/channels/index.ts` (also deleted by F35 — channel types now live next
to their implementations) with a different method set (`send`,
`sendEvent`, `onMessage`, `onClose`, `close`, `chatId`).

## Evidence

`docs/internals/channels.md` describes the deleted channels:

```
## CLI channel

`channels/cli.ts` implements ad-hoc Chat invocations bound to stdin/stdout.
…

## One-shot channel

`channels/oneshot.ts` is a synchronous variant: open Chat, send one …
```

[docs/internals/channels.md](docs/internals/channels.md#L24-L35)

Cross-reference in `docs/internals/agent-chat.md`:

```
- **One-shot CLI** (`channels/oneshot.ts`) — used by the `saivage inspect`
  flow …
```

[docs/internals/agent-chat.md](docs/internals/agent-chat.md#L39)

Reality:

- `src/channels/` contains only `telegram.ts` and `websocket.ts` — verified
  via `list_dir`.
- The CLI `inspect` command (cited in `agent-chat.md`) opens the runtime
  directly and runs the inspector agent — it does not use any "one-shot
  channel" — see [src/server/cli.ts](src/server/cli.ts#L320-L420).
- The real channel interface exposes `send`, `sendEvent`, `onMessage`,
  `onClose`, `close`, and `chatId` (not the `name / start / stop / publish`
  the doc describes) — see
  [src/channels/telegram.ts](src/channels/telegram.ts#L1-L60),
  [src/channels/websocket.ts](src/channels/websocket.ts#L1-L57).

The F35 ledger entry in
[SPEC/v2/review-2026-05/99-METAPLAN.md](SPEC/v2/review-2026-05/99-METAPLAN.md)
lists the deletion as `[done]`, with no docs update.

## Why this matters

`docs/internals/*.md` is the only contemporary description of the channel
abstraction. A developer arriving today to add a third channel (e.g.
Discord, Slack) will copy the documented `Channel` plugin interface, wire it
up to a non-existent `channels/index.ts` barrel, and ship a stub that doesn't
satisfy the *actual* `ChatChannel` contract used by the runtime — so it will
type-error at first usage, but only after the developer has internalised the
wrong mental model.

The `agent-chat.md` reference is worse: it ties the `inspect` CLI flow to a
fictional channel, so anyone debugging inspector behaviour will look in
`channels/oneshot.ts` for the entry point and find nothing.

## Rough remediation direction

Rewrite the two doc sections against current code: replace the "CLI channel"
and "One-shot channel" subsections with one paragraph noting both were
removed in F35 (the inspect flow now drives the inspector agent in-process),
and rewrite the `Channel` interface block as the real `ChatChannel`
discriminated union (`send` / `sendEvent` / `onMessage` / `onClose` / `close` /
`chatId`). Delete the `oneshot` reference from `agent-chat.md`.

**Level up**: the same root cause underlies G40, G45. A refactor checklist
template for SPEC issues that delete public types or files should require a
docs grep before the issue lands. Better still: a CI lint that fails the
build if any `docs/**/*.md` references a `src/**/*.ts` path that no longer
exists.

## Cross-links

- F35 — the deletion this regressed.
- G40 — `docs/guide/web-ui.md` similar drift in the user-facing layer.
- G45 — `docs/internals/server.md` has matching `SaivageRuntime` shape drift.
