# F17 — Design r2

## Changes from r1

- **Honest dependency footprint for `telegramify-markdown`.** `npm view telegramify-markdown@1.3.3 dependencies --json` (run on 2026-05-24) returns 9 direct dependencies — `remark-parse`, `remark-gfm`, `remark-stringify`, `remark-remove-comments`, `mdast-util-gfm-table`, `mdast-util-to-markdown`, `unified`, `unist-util-remove`, `unist-util-visit`. The r1 claim of "single named export, ~10 kB, no transitive deps" was wrong. Proposal A now states the actual footprint and justifies why it is still the right pick versus a hand-rolled escaper. The "what gets added" section is updated.
- **Single, consistent chunking model across design and plan.** r1 contradicted itself: the scope bullet said "convert once and then chunk the result", the next bullet said "split the input Markdown first and convert each chunk independently". Both Proposal A and Proposal B in r2 use exactly one model: **block-aware source-side splitting**, never slicing converted MarkdownV2. This is carried into Plan r2.

## Proposal A — Replace the regex converter with `telegramify-markdown`

### Scope

- Add dependency `telegramify-markdown` to [package.json](package.json#L29-L40).
- Edit [src/channels/telegram.ts](src/channels/telegram.ts):
  - Delete `escapeHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L33)).
  - Delete `markdownToTelegramHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L38-L82)).
  - Change `TelegramSendFn` parse-mode type from `"HTML"` to `"MarkdownV2"` ([src/channels/telegram.ts](src/channels/telegram.ts#L17-L20)).
  - Replace the existing rendered-HTML chunker at [src/channels/telegram.ts](src/channels/telegram.ts#L98-L118) with a **block-aware source-side splitter** that produces a sequence of source-Markdown fragments. Each fragment is then independently fed through `telegramifyMarkdown(fragment, "escape")`, and the full result of that conversion is sent verbatim. **The converted MarkdownV2 string is never sliced.** This guarantees that every string handed to `sendFn` is the complete output of a single `telegramifyMarkdown` call, which by construction is syntactically well-formed MarkdownV2.
- Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60): change the `sendFn` signature to accept `"MarkdownV2"` and forward it as `parse_mode`.
- Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34) to assert MarkdownV2-escaped output and to cover the structural chunking cases (see Plan r2).

### Chunking model (single, consistent)

`splitSourceForTelegram(md: string, max: number): string[]` returns source-Markdown fragments. Algorithm:

1. **Tokenize the input into block units.** Walk the source line-by-line. A fenced code block (lines from `` ``` `` opener to the matching closing fence) is one atomic unit; everything else is grouped into paragraph units separated by blank lines.
2. **Greedy packing.** Accumulate consecutive units into a fragment while the running `telegramifyMarkdown(fragment, "escape").length` stays ≤ `max`. When adding the next unit would exceed `max`, emit the current fragment and start a new one.
3. **Oversized single unit.** A unit whose converted length already exceeds `max` is split recursively:
   - **Fenced code block:** split the code content along line boundaries; each piece is re-wrapped with the original opener (`` ``` `` plus language tag) and closer (`` ``` ``). The wrapping ensures each piece is itself a syntactically complete fenced block, so its conversion is well-formed MarkdownV2.
   - **Paragraph:** split on `\n`. If a single line still over-runs, split on sentence boundaries (`. `, `? `, `! `). If still over-running, split on whitespace. Plain text with no code/emphasis is safe to split at any whitespace boundary because escaping is character-local and re-joining is never attempted.
4. **Worst-case guarantee.** If recursion bottoms out at a single very long token with no whitespace whose escaped form still exceeds `max` (e.g. a 5000-char base64 blob with no spaces), the unit is hard-cut at a UTF-8-safe code-point boundary. This is the only place a hard cut can occur, and it is on **source** characters, not on converted MarkdownV2 — so no escape sequence, no formatting delimiter, and no fence marker can be split mid-token. We still feed the resulting source fragment through `telegramifyMarkdown` before sending; whatever escapes the library inserts come out paired correctly because each fragment is itself a valid source string.

This is exactly one chunking model: split source units, convert per fragment, send the conversion result whole.

### What gets added

- One `import telegramifyMarkdown from "telegramify-markdown";` (the package's default export per its README; type-checked at install time).
- `telegramify-markdown@1.3.3` runtime dependency. Verified transitive footprint (via `npm view telegramify-markdown@1.3.3 dependencies --json` on 2026-05-24):

  ```
  mdast-util-gfm-table       ^0.1.6
  mdast-util-to-markdown     ^0.6.2
  remark-gfm                 ^1.0.0
  remark-parse               ^9.0.0
  remark-remove-comments     ^0.2.0
  remark-stringify           ^9.0.1
  unified                    ^9.0.0
  unist-util-remove          ^2.0.1
  unist-util-visit           ^2.0.3
  ```

  The full transitive closure of these is ~40 npm packages (the remark/unified ecosystem). Disk size in `node_modules` is ~1.2 MB unminified. Because `saivage` is a CLI that runs from `dist/` produced by `tsup`, what ships to the user is what `tsup` bundles. `tsup` tree-shakes ESM dependencies; the remark/unified stack is ESM and side-effect-free, so the bundle delta is dominated by the parser/printer code paths actually exercised by `telegramifyMarkdown`, on the order of ~80–120 kB minified. This is in the same order of magnitude as the `marked` + `sanitize-html` alternative the issue note flagged as undesirable, but it replaces a class of correctness bugs the hand-rolled converter has, not just a single bug. It is acceptable for a CLI of `saivage`'s size.
- New module-private helpers in [src/channels/telegram.ts](src/channels/telegram.ts): `splitSourceForTelegram`, `tokenizeBlocks`, `splitOversizedBlock`, and a small `convertedLength` thunk.
- New tests in [src/channels/telegram.test.ts](src/channels/telegram.test.ts) — see Plan r2 for the exact cases.

### What gets removed

- 60 lines of regex converter + helpers ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L82)).
- The `"HTML"` literal type on `TelegramSendFn` and its forwarded `parse_mode` argument.
- The HTML-output-aware chunker at [src/channels/telegram.ts](src/channels/telegram.ts#L98-L118).

### Risk

- **New runtime dependency with a substantial transitive closure.** Mitigation: `telegramify-markdown` exists precisely for this transformation; its API surface is one function; the remark/unified ecosystem is widely used (current npm weekly downloads for `unified` exceed 80 M) and version-pinned through the dependency. The risk of bit-rot is low.
- **Behaviour change: HTML → MarkdownV2.** Visual output is equivalent for the formatting `saivage` emits (bold, italic, code, links, blockquotes). The only consumers of the channel's parse mode are the channel itself and the grammy `sendMessage` call; verified by call-site search.
- **Chunking-model risk.** The block-aware splitter is new logic. Mitigation: tests cover oversized fenced-code blocks, escape-expansion at the boundary, nested emphasis spanning fragments, and a very long inline-code span. See Plan r2.

### What it enables

- Future emoji-prefix / `<tg-spoiler>` / blockquote / underline support is a library config option, not new code.
- F16 (Telegram bot more broadly) can pin formatting concerns as "done"; no further bugs of the F17 family will recur.

### What it forbids

- Cannot send pre-rendered HTML through Telegram any more. There is no such call site today; nothing to migrate.

### Recommendation note

Recommended. The dependency footprint is real but bounded, and it is paid once to remove an entire class of correctness bugs (nested formatting, header collision, italic underscores, blockquotes, spoilers, and unbalanced-tag chunk splits). The alternative (Proposal B) reproduces the same hand-rolled-escaper problem in a smaller form and does not eliminate the failure class.

---

## Proposal B — Keep a hand-rolled converter, but switch to MarkdownV2 escaping

### Scope

- Edit [src/channels/telegram.ts](src/channels/telegram.ts) in place:
  - Delete `markdownToTelegramHtml` and `escapeHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L82)).
  - Replace with `escapeForMarkdownV2(md: string): string` — escapes the MarkdownV2 reserved set (`_*[]()~`>#+-=|{}.!` and `\`) outside of fenced code blocks and inline code spans, with separate handling for the link-text and link-URL sub-contexts of `[text](url)`.
  - Change `TelegramSendFn`'s `parseMode` to `"MarkdownV2"`.
- Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60) to pass `"MarkdownV2"`.
- Replace the chunker with the same block-aware source-side splitter described in Proposal A. Same chunking model: split source units, escape per fragment via `escapeForMarkdownV2`, send the escape result whole. **Never slice converted MarkdownV2.**
- Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34) to assert MarkdownV2 escaping plus the same structural chunking cases.

### What gets added

- ~40 lines: an escaper that masks fenced and inline code, escapes the reserved set in the non-code regions, and handles link sub-contexts. Plus the same chunking helpers as Proposal A.

### What gets removed

- Same ~60 lines as Proposal A.

### Risk

- Still a hand-rolled escaper. It only has to escape ~15 punctuation characters in the non-code regions, but it must also know:
  - The reserved set inside `[link text]` is `[]\` only.
  - The reserved set inside `(url)` is `)\` only.
  - Inside ``…``-spans only `` ` `` and `\` are escaped.
  - Inside ` ```…``` ` fenced blocks the only escape is `\``.
  Each of these is a separate code path that must stay correct as Telegram updates MarkdownV2.

### What it enables

- Zero new dependencies. The escaper is colocated with `TelegramChannel`.

### What it forbids

- Same as A: no pre-rendered HTML through Telegram.

### Recommendation note

Plausible but strictly worse than A: it replaces one hand-rolled regex converter with another hand-rolled escaper that must implement MarkdownV2's sub-context rules. The footprint argument for B is the strongest argument B has, and it is genuine, but the maintenance argument cuts the other way.

---

## Proposal C — Send plain text and delete the converter entirely

### Scope

- Edit [src/channels/telegram.ts](src/channels/telegram.ts):
  - Delete `escapeHtml` and `markdownToTelegramHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L82)).
  - Change `TelegramSendFn` to drop the `parseMode` parameter entirely.
  - In `send`, chunk the raw Markdown (using the same block-aware splitter, since plain-text chunks must still avoid mid-word UTF-8 cuts) and forward verbatim.
- Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60): drop `parse_mode` from `sendMessage` options.
- Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34) to assert literal pass-through.

### What gets added

- Just the block-aware chunker; no escaper, no converter.

### What gets removed

- ~60 lines of converter and the `parse_mode` field.

### Risk

- Worker output Markdown surfaces as literal `**`, `__`, `` ` ``, etc. on Telegram. Code blocks render as raw triple-backtick text. Telegram users see a meaningfully worse rendering for status snapshots and JSON dumps — exactly the content the issue note flags as motivation for keeping formatting.

### What it enables

- Smallest possible code; no parse-mode concerns.

### What it forbids

- No formatted output on Telegram, period.

### Recommendation note

Rejected. The issue note explicitly justifies formatting (status snapshots, formatted JSON, system events). Removing it regresses the user experience without removing the maintenance surface in a meaningful way — `TelegramChannel.send` still exists, still chunks.

---

## Recommendation

**Proposal A.** It is the only option that

1. removes the regex converter (guideline 1 / 2),
2. does not replace it with another hand-rolled escaper that will eventually hit MarkdownV2 sub-context bugs (B),
3. preserves the formatting that the channel exists to deliver (C is regression).

The dependency footprint of `telegramify-markdown` is real (9 direct deps, ~40 transitives, ~80–120 kB bundled) but is the right price to remove a whole class of correctness bugs from a system-boundary converter that has shown it cannot be kept correct by hand.
