# F17 — Telegram channel reimplements Markdown→HTML in ~50 lines of custom regex

**Category**: bad-design
**Severity**: low
**Transversality**: local

## Summary

`telegram.ts` ships its own Markdown→HTML converter to satisfy Telegram's restricted HTML subset (no `<p>`, no nesting, escaped entities). The implementation is a series of `replace(/pattern/g, ...)` passes that handle bold/italic/code/link sequentially and that miss the obvious nested-formatting cases.

## Evidence

- The converter: see `markdownToTelegramHtml` (or similar) in [src/channels/telegram.ts](src/channels/telegram.ts).
- Telegram's restricted-HTML rules are documented at <https://core.telegram.org/bots/api#html-style>.

## Why this matters

Workers send heterogeneous Markdown (system events, status snapshots, formatted JSON). A regex converter cannot get nested `**__bold italic__**` right and silently emits broken HTML, which Telegram rejects with an opaque "can't parse entities" error and the entire notification is dropped. A 4kB library (`marked` + `sanitize-html` with a Telegram allow-list) would replace this code with a single chain.

## Related

- F16 (telegram bot more broadly)
