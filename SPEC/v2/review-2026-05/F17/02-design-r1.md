# F17 — Design r1

## Proposal A — Replace the regex converter with `telegramify-markdown`

### Scope

- Add dependency `telegramify-markdown` to [package.json](package.json#L29-L40).
- Edit [src/channels/telegram.ts](src/channels/telegram.ts):
  - Delete `escapeHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L33)).
  - Delete `markdownToTelegramHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L38-L82)).
  - Change `TelegramSendFn` parse-mode type from `"HTML"` to `"MarkdownV2"` ([src/channels/telegram.ts](src/channels/telegram.ts#L17-L20)).
  - In `send`, call `telegramifyMarkdown(message, "escape")` once, then chunk the result.
- Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60): change `parse_mode: parseMode` argument to forward `"MarkdownV2"`.
- Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34) to assert MarkdownV2-escaped output for the same input string.
- Replace the rendered-HTML chunker at [src/channels/telegram.ts](src/channels/telegram.ts#L104-L118) with a source-Markdown chunker: split the **input Markdown** at paragraph boundaries first, convert each chunk independently, fall back to `\n` then to a hard cut at 4096 chars. This avoids unbalanced-tag fragments because each chunk is a self-contained Markdown document.

### What gets added

- One `import { telegramifyMarkdown } from "telegramify-markdown";` (single named export, ~10 kB, no transitive deps).
- One new test verifying that nested `**__bold italic__**` is now accepted by Telegram's parser (parsed via `telegramify-markdown`'s own escaping; the assertion checks structural shape, since the library is the contract).

### What gets removed

- 60 lines of regex converter + helpers ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L82)).
- The `"HTML"` literal type on `TelegramSendFn` and its forwarded `parse_mode` argument.

### Risk

- New runtime dependency. Mitigation: `telegramify-markdown` has no dependencies of its own and a stable API surface (one function).
- Behaviour change: every Telegram message switches from HTML rendering to MarkdownV2. Visual output is equivalent for the formatting Saivage actually emits (bold, italic, code, links, blockquotes). No external schema consumers; verified by call-site search — only `TelegramChannel` uses Telegram parse mode.

### What it enables

- Future emoji-prefix / `<tg-spoiler>` / blockquote / underline support is a library config option, not new code.
- F16 (Telegram bot more broadly) can pin formatting concerns as "done"; no further bugs of the F17 family will recur.

### What it forbids

- Cannot send pre-rendered HTML through Telegram any more. There is no such call site today; nothing to migrate.

### Recommendation note

Recommended. Solves the actual class of bugs (nested formatting, header collision, italic underscores, blockquotes, spoilers) with one dependency that exists precisely for this task. Code shrinks by ~60 lines net. Switches to the parse mode Telegram themselves recommend for new bots.

---

## Proposal B — Keep a hand-rolled converter, but simplify by switching to MarkdownV2 escaping

### Scope

- Edit [src/channels/telegram.ts](src/channels/telegram.ts) in place:
  - Delete `markdownToTelegramHtml` and `escapeHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L82)).
  - Replace with a single function `escapeForMarkdownV2(md: string): string` that escapes the MarkdownV2 reserved set (`_*[]()~`>#+-=|{}.!` and `\`) outside of fenced code blocks and inline code spans, leaving authored Markdown formatting intact.
  - Change `TelegramSendFn`'s `parseMode` to `"MarkdownV2"`.
- Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60) to pass `"MarkdownV2"`.
- Rewrite the chunker at [src/channels/telegram.ts](src/channels/telegram.ts#L104-L118) to operate on the **input Markdown**, not the rendered output (same chunking fix as Proposal A).
- Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34) to assert MarkdownV2 escaping for the same input.

### What gets added

- ~15 lines: one regex-based escaper plus a code-fence tokenizer (mask `\`\`\`…\`\`\`` and `` `…` ``, escape outside, restore inside).

### What gets removed

- Same ~60 lines as Proposal A.

### Risk

- Still a hand-rolled escaper. It only has to escape ~15 punctuation characters in the non-code regions, which is far smaller than the current converter's problem surface (no formatting passes, no nesting questions, no header rewriting). Telegram's MarkdownV2 spec is stable; the rule list is closed.
- Subtle: the escape characters inside `[link text]` and `(url)` are different from the top-level set. The escaper must know about those sub-contexts. This is the failure mode every hand-rolled escaper hits eventually.

### What it enables

- Zero new dependencies. The escaper is colocated with `TelegramChannel`.

### What it forbids

- Same as A: no pre-rendered HTML through Telegram.

### Recommendation note

Plausible but strictly worse than A: the failure mode of the converter is "hand-rolled regex meets stable but quirky Telegram grammar". Replacing one hand-rolled converter (Markdown→HTML) with another hand-rolled converter (Markdown→escaped MarkdownV2) just relocates the problem. The "subtle" failure mode listed above (link-text vs URL sub-contexts) is the kind of bug that ships and is found a year later by a worker emitting a parenthesised link title.

---

## Proposal C — Send plain text and delete the converter entirely

### Scope

- Edit [src/channels/telegram.ts](src/channels/telegram.ts):
  - Delete `escapeHtml` and `markdownToTelegramHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L82)).
  - Change `TelegramSendFn` to drop the `parseMode` parameter entirely.
  - In `send`, just chunk the raw Markdown and forward verbatim.
- Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60): drop `parse_mode` from `sendMessage` options.
- Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34) to assert literal pass-through.

### What gets added

- Nothing.

### What gets removed

- ~60 lines of converter and the `parse_mode` field.

### Risk

- Worker output Markdown surfaces as literal `**`, `__`, `` ` ``, etc. on Telegram. Code blocks render as raw triple-backtick text. Telegram users see a meaningfully worse rendering for status snapshots and JSON dumps — exactly the content the issue note flags as motivation for keeping formatting.

### What it enables

- Smallest possible code; no parse-mode concerns.

### What it forbids

- No formatted output on Telegram, period.

### Recommendation note

Rejected. The issue note explicitly justifies formatting (status snapshots, formatted JSON, system events). Removing it regresses the user experience without removing the maintenance surface in a meaningful way — `TelegramChannel.send` still exists, still chunks, still escapes nothing.

---

## Recommendation

**Proposal A.** It is the only option that

1. removes the regex converter (guideline 1 / 2),
2. does not replace it with another hand-rolled escaper that will eventually hit the same class of bug (B),
3. preserves the formatting that the channel exists to deliver (C is regression).

The footprint of `telegramify-markdown` (one zero-dependency, ~10 kB package) is well within the bar for a single-purpose, hard-to-get-right transformation.
