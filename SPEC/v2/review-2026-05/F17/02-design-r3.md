# F17 — Design r3

## Changes from r2

- **Dependency-footprint paragraph rewritten to remove unverified ESM/tree-shaking claims.** r2 asserted that the remark/unified stack is ESM and side-effect-free and that `tsup` would tree-shake it to ~80–120 kB minified. Spot-checking the packed tarball, `telegramify-markdown@1.3.3` ships CommonJS (`module.exports = require('./lib/convert')`, types via `export = convert`) and does not declare `type: "module"` or `sideEffects: false`. The justification is now stated only from verified npm metadata — unpacked package size, direct dep count, transitive count — and the actual bundle delta is left to `npm run build` validation rather than predicted as a number. The recommendation does not change.
- **Test-coverage claim in Proposal A's risk section corrected to match Plan r3.** r2 listed "nested emphasis spanning fragments" and "a very long inline-code span" without those tests actually existing in Plan r2. Plan r3 adds both as real boundary tests; the design's risk-mitigation bullet now references them explicitly and only claims what Plan r3 implements.
- **Oversized-paragraph splitting contract tightened.** r2's `splitOversizedBlock` description for paragraphs split by newline → sentence → whitespace → code-point, but did not say what happens to inline code, link, and emphasis spans inside an oversized paragraph. The Proposal A chunking model in r3 makes those spans atomic during whitespace-level splitting and defines an explicit, tested degradation rule (hard-cut on raw source) for the pathological case where a single inline span itself exceeds the limit. Both branches are testable; Plan r3 tests them.

## Proposal A — Replace the regex converter with `telegramify-markdown`

### Scope

- Add dependency `telegramify-markdown` to [package.json](package.json#L29-L40).
- Edit [src/channels/telegram.ts](src/channels/telegram.ts):
  - Delete `escapeHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L33)).
  - Delete `markdownToTelegramHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L38-L82)).
  - Change `TelegramSendFn` parse-mode type from `"HTML"` to `"MarkdownV2"` ([src/channels/telegram.ts](src/channels/telegram.ts#L17-L20)).
  - Replace the existing rendered-HTML chunker at [src/channels/telegram.ts](src/channels/telegram.ts#L98-L118) with a **block-aware, span-aware source-side splitter** that produces a sequence of source-Markdown fragments. Each fragment is then independently fed through `telegramifyMarkdown(fragment, "escape")`, and the full result of that conversion is sent verbatim. **The converted MarkdownV2 string is never sliced.**
- Edit [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60): change the `sendFn` signature to accept `"MarkdownV2"` and forward it as `parse_mode`.
- Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34) to assert MarkdownV2-escaped output and to cover the boundary cases (see Plan r3).

### Chunking model (single, consistent, span-aware)

`splitSourceForTelegram(md: string, max: number): string[]` returns source-Markdown fragments. Algorithm:

1. **Tokenize the input into block units.** Walk the source line-by-line. A fenced code block (lines from `` ``` `` opener to the matching closing fence) is one atomic unit; everything else is grouped into paragraph units separated by blank lines.
2. **Greedy packing.** Accumulate consecutive units into a fragment while the running `telegramifyMarkdown(fragment, "escape").length` stays ≤ `max`. When adding the next unit would exceed `max`, emit the current fragment and start a new one.
3. **Oversized single unit.** A unit whose converted length already exceeds `max` is split recursively:
   - **Fenced code block:** split the code content along line boundaries; each piece is re-wrapped with the original opener (`` ``` `` plus language tag) and closer (`` ``` ``). The wrapping ensures each piece is itself a syntactically complete fenced block.
   - **Paragraph (line → sentence → atomic spans):** split on `\n` first. If a line still over-runs, split on sentence boundaries (`. `, `? `, `! `). If still over-running, **tokenize the line into atomic spans and pack span-by-span.** Atomic spans are: inline-code `` `…` ``, link `[text](url)`, emphasis `**…**` / `*…*` / `__…__` / `_…_`, and runs of plain text between them. Plain-text runs may be re-split at whitespace; formatted spans are kept whole.
4. **Worst-case degradation (single inline span over the limit).** If a single atomic inline span's own converted length exceeds `max` (e.g. a single ``` `…` ``` inline-code span containing a 5000-char base64 blob), the splitter falls back to hard-cutting on the raw **source** characters of that span at a UTF-8-safe code-point boundary. The resulting source fragments are each independently fed to `telegramifyMarkdown`. This intentionally degrades the inline formatting at the cut (the second half of the cut span will render as plain text, not as inline code) in exchange for guaranteed deliverability. This degradation is the only place a span can be split mid-content, it is deterministic, and Plan r3 covers it with a test.

This is exactly one chunking model: split source units, convert per fragment, send the conversion result whole. The only place source characters get cut without a natural boundary is the worst-case-degradation rule in step 4, and it is on raw source — so no escape sequence, no formatting delimiter, and no fence marker is split mid-token.

### What gets added

- One `import telegramifyMarkdown from "telegramify-markdown";` (the package's default export per its README; type-checked at install time).
- `telegramify-markdown@1.3.3` runtime dependency. Verified metadata from `npm view telegramify-markdown@1.3.3 dependencies dist.unpackedSize main types --json` (run 2026-05-24):
  - Module format: **CommonJS.** The package's `main` resolves to `./lib/convert`, which is `module.exports = require('./lib/convert')`. Types are exposed via `export = convert`. The package does not declare `type: "module"` nor `sideEffects: false`.
  - **Unpacked package size: 12,951 bytes** (the `telegramify-markdown` package itself, excluding dependencies).
  - **9 direct dependencies** — `remark-parse`, `remark-gfm`, `remark-stringify`, `remark-remove-comments`, `mdast-util-gfm-table`, `mdast-util-to-markdown`, `unified`, `unist-util-remove`, `unist-util-visit`.
  - **~40 transitive dependencies** total (the remark/unified ecosystem). Disk footprint in `node_modules` is on the order of ~1 MB.
  - **Actual bundle delta:** to be validated by `npm run build` when the dependency lands. The package is CommonJS and does not advertise side-effect-freeness, so `tsup`'s tree-shaking effectiveness is conservatively assumed to be modest; the bundle delta is whatever `tsup` produces on the real build and is bounded by the on-disk footprint above. The footprint is acceptable for a CLI of `saivage`'s size and is the price paid to delete the entire class of correctness bugs the hand-rolled converter has shown it cannot avoid.
- New module-private helpers in [src/channels/telegram.ts](src/channels/telegram.ts): `splitSourceForTelegram`, `tokenizeBlocks`, `splitOversizedBlock`, `splitParagraphIntoAtomicSpans`, and a small `convertedLen` thunk.
- New tests in [src/channels/telegram.test.ts](src/channels/telegram.test.ts) — see Plan r3 for the exact cases.

### What gets removed

- 60 lines of regex converter + helpers ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L82)).
- The `"HTML"` literal type on `TelegramSendFn` and its forwarded `parse_mode` argument.
- The HTML-output-aware chunker at [src/channels/telegram.ts](src/channels/telegram.ts#L98-L118).

### Risk

- **New runtime dependency with a substantial transitive closure.** Mitigation: `telegramify-markdown` exists precisely for this transformation; its API surface is one function; the remark/unified ecosystem is widely used and version-pinned through the dependency.
- **Bundle-size impact is not pre-measured.** Mitigation: the on-disk footprint is bounded (one package + ~40 transitives), and `npm run build` is part of the validation step in Plan r3. If the build delta turns out to be unacceptable in CI, Proposal B is a drop-in fallback that re-uses the same chunking model.
- **Behaviour change: HTML → MarkdownV2.** Visual output is equivalent for the formatting `saivage` emits (bold, italic, code, links, blockquotes). The only consumers of the channel's parse mode are the channel itself and the grammy `sendMessage` call; verified by call-site search.
- **Chunking-model risk.** The block-aware + span-aware splitter is new logic. Mitigation: Plan r3 covers (a) the long fenced-code-block boundary with a fence-balance assertion, (b) the punctuation/escape-expansion boundary, (c) **a long nested-emphasis paragraph forced across a split** with an unbalanced-emphasis assertion at the cut point, (d) **a long inline-code-containing paragraph forced across a split** asserting the inline span lands intact in exactly one chunk, and (e) the worst-case degradation where a single inline span exceeds the limit.

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
- Replace the chunker with the same block-aware + span-aware source-side splitter described in Proposal A. Same chunking model: split source units (and atomic spans within oversized paragraphs), escape per fragment via `escapeForMarkdownV2`, send the escape result whole. **Never slice converted MarkdownV2.**
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

Plausible but strictly worse than A: it replaces one hand-rolled regex converter with another hand-rolled escaper that must implement MarkdownV2's sub-context rules. The footprint argument for B is the strongest argument B has, and it is genuine, but the maintenance argument cuts the other way. B is the fallback if Proposal A's measured bundle delta turns out to be unacceptable.

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

The dependency footprint of `telegramify-markdown` (1 package, 12,951 bytes unpacked, 9 direct deps, ~40 transitives, CommonJS) is real but bounded. The actual bundle delta is left to `npm run build` validation; if it proves unacceptable, Proposal B uses the same chunking infrastructure and is a clean fallback.
