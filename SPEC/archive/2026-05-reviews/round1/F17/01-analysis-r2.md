# F17 — Analysis r2

## Changes from r1

- Corrected the line reference for the `markdownToTelegramHtml` invocation: it is at [src/channels/telegram.ts](src/channels/telegram.ts#L98), not L101. Both the "Problem restated" paragraph and the "Call sites & dependencies" entry are updated.

## Problem restated

`src/channels/telegram.ts` hand-rolls a Markdown→Telegram-HTML converter using a sequence of `String.prototype.replace(/.../g, ...)` passes. The whole converter is the function `markdownToTelegramHtml` at [src/channels/telegram.ts](src/channels/telegram.ts#L38-L82); it is invoked exactly once from `TelegramChannel.send` at [src/channels/telegram.ts](src/channels/telegram.ts#L98).

The Telegram Bot API only accepts a small, non-nestable HTML subset (`<b>`, `<i>`, `<u>`, `<s>`, `<a>`, `<code>`, `<pre>`, `<tg-spoiler>`, `<blockquote>`) and rejects everything else with the opaque error `"Bad Request: can't parse entities"`. When the bot is the only delivery channel for project notifications (see `startTelegramBot` at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L19-L162)), a single bad message silently disappears — the `await bot.api.sendMessage` call at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L57-L60) throws, the `sendFn` re-throws ([src/server/telegram-bot.ts](src/server/telegram-bot.ts#L61-L64)), and `TelegramChannel.send` propagates the rejection to whichever caller awaited it (typically `sendEvent`, [src/channels/telegram.ts](src/channels/telegram.ts#L125-L130), which does not await and therefore loses the failure entirely).

The custom converter has concrete defects:

1. **Order-of-passes bugs.** The escape pass at [src/channels/telegram.ts](src/channels/telegram.ts#L46) runs before the formatting passes, so user content containing `<` and `>` is escaped, but the formatting passes then synthesize bare `<b>`, `<i>`, `<a href="…">` tags from the still-Markdown input. Any `*…*` or `[…](…)` inside what was originally a `<code>`-inline span is escaped to `&lt;…&gt;` before the inline-code rule at [src/channels/telegram.ts](src/channels/telegram.ts#L57) gets to wrap it, so the result is correct for trivial input but breaks for `` `*not bold*` `` (the asterisks inside the inline code are still seen by the bold/italic passes that run after the inline-code wrapping).
2. **No nested-emphasis support.** Telegram's HTML mode does not allow nested formatting tags anyway, but the converter happily produces `<b>foo <i>bar</i></b>` from `**foo *bar***`, which Telegram rejects. The converter has no notion of "this nesting is illegal" — it just hopes input is flat.
3. **Italic rule is `*` only.** Both `_…_` and `__…__` (standard Markdown italic and CommonMark/GFM bold variants) are passed through unchanged.
4. **Headers collide with bold.** `# **Important**` becomes `<b># <b>Important</b></b>` because the bold pass at [src/channels/telegram.ts](src/channels/telegram.ts#L60) runs before the header pass at [src/channels/telegram.ts](src/channels/telegram.ts#L72) and the header pass naively wraps the whole line. Telegram then rejects the nested `<b>`.
5. **Link URL is not escaped.** `[link](javascript:alert(1))` becomes `<a href="javascript:alert(1)">link</a>`; Telegram strips the tag but does not refuse the message — still, this is a system-boundary correctness gap because notification content can include arbitrary `${…}` interpolation from worker output (see worker event payloads consumed by `ChatAgent`'s event filter at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L75-L82)).
6. **Strikethrough/Spoiler/Blockquote/Underline ignored.** Telegram supports `<s>`, `<u>`, `<tg-spoiler>`, `<blockquote>`. The converter only handles `~~…~~`, no `||…||` (MarkdownV2 spoiler), no `>` blockquote.
7. **No "raw HTML in input" guard.** If a worker emits a literal `<script>` in its Markdown (e.g. a captured agent transcript), the initial escape on line [src/channels/telegram.ts](src/channels/telegram.ts#L46) handles it, but only because the `escapeHtml` pass happens before anything synthesises `<…>`. Any future reorder would silently introduce an injection vector. This invariant is implicit, not enforced.

## Contract

`markdownToTelegramHtml(md: string): string`

- **Input**: Markdown-ish text emitted by ChatAgent's `message` events. In practice these come from LLM completions and from human chat replies. No schema; no length cap.
- **Output**: A string that Telegram accepts under `parse_mode: "HTML"`.
- **Error mode**: None declared. On bad input the result is a string Telegram will reject; the rejection surfaces as a thrown error from `bot.api.sendMessage` inside `sendFn` at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L57-L65), is re-thrown out of `sendFn`, and is logged but the message is dropped.

`TelegramChannel.send(message: string)` chunks the post-conversion HTML at 4096 chars using `\n\n` / `\n` / hard-cut at [src/channels/telegram.ts](src/channels/telegram.ts#L104-L118). The chunker operates on rendered HTML, so a 4096-char boundary can land inside a `<pre><code>…</code></pre>` block, producing an unbalanced tag in the first chunk. Telegram rejects unbalanced tags. This is a second, distinct bug riding on top of the converter.

## Call sites & dependencies

- `markdownToTelegramHtml` is module-private; only `TelegramChannel.send` ([src/channels/telegram.ts](src/channels/telegram.ts#L98)) calls it.
- `TelegramChannel` is instantiated only from `startTelegramBot` at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L67). No other channel uses Telegram HTML.
- The only test that exercises the converter is the "escapes Telegram HTML while preserving basic markdown formatting" case at [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34). It pins one trivial input.
- No other module imports `markdownToTelegramHtml`. There is no public API surface to preserve.

## Constraints any solution must respect

1. **Project guideline 1 (no backward compat):** The replacement deletes the regex converter outright; no shim, no flag.
2. **Telegram parse-mode reality:** Telegram supports two parse modes — `HTML` and `MarkdownV2`. `HTML` does not permit nested formatting. `MarkdownV2` requires escaping `_*[]()~`>#+-=|{}.!` outside of code spans, but does support nested emphasis and is the parse mode the official Telegram docs recommend for "new bots". Either is acceptable — the call site at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60) just forwards whatever `parseMode` the channel asks for.
3. **`grammy` does not provide a Markdown converter.** It only forwards `parse_mode`. Conversion is the application's responsibility.
4. **Length splitting must remain correct** at 4096 chars and must not split inside formatting tags / code blocks / multi-byte UTF-8 sequences. The current implementation does not honour the second of these.
5. **No new docstrings/comments on untouched code** (guideline 3). The function being replaced has a docstring; deleting the function deletes the docstring with it.
6. **Bundle / dependency footprint:** `saivage` is a CLI shipped through `tsup`. A small focused dependency is acceptable; pulling `marked` + `sanitize-html` (the two-lib stack the issue note suggests) would add ~120 kB minified. The dependency choice must be evaluated against the actual transitive footprint reported by npm (see Design r2 for the verified numbers for `telegramify-markdown`).
7. **Out-of-scope boundary:** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/`. F17 touches only `src/channels/telegram.ts`, `src/channels/telegram.test.ts`, `src/server/telegram-bot.ts` (parse-mode wiring only), and `package.json`. None of those are out-of-scope.
