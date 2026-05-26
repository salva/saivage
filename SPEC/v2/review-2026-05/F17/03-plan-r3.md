# F17 — Plan r3 (Proposal A)

## Changes from r2

- **Added long formatted/nested-emphasis boundary test.** r2 only had a short nested-emphasis smoke test. r3 forces a split around a paragraph dominated by `**bold *italic* tail**` runs that, after MarkdownV2 escaping, lands over 4096 chars. The test asserts every emitted chunk has balanced emphasis delimiters at its boundaries and no dangling `\` escape — exactly the failure mode the splitter must not produce. The short nested-emphasis smoke test is kept as a separate case because it pins a different invariant (round-trip of nested formatting through a single `telegramifyMarkdown` call).
- **Added long inline-code boundary test.** r2 only asserted that a short inline span landed intact in some chunk. r3 forces the boundary: a paragraph filled with many long-but-individually-under-max inline-code spans where the converted total exceeds 4096. The test asserts each inline-code span lands intact in exactly one chunk (no chunk ends with an unbalanced `` ` ``).
- **Added worst-case-degradation test.** A single inline-code span longer than 4096 must still be deliverable. The test asserts the splitter emits multiple chunks, all under 4096, and that no chunk ends with a dangling `\` escape. It does not assert the inline-code formatting survives — by design (see Design r3 step 4), the formatting degrades to plain text at the cut, which is the documented behavior.
- **Span-aware paragraph splitting contract spelled out.** The `splitOversizedBlock` paragraph branch now explicitly tokenizes lines into atomic spans (inline code, link, emphasis, plain-text run) and packs span-by-span; plain-text runs may be re-split at whitespace; formatted spans are kept whole. The worst-case branch (single span over the limit) is defined as raw-source hard-cut with documented formatting degradation.
- **Dependency-footprint note** aligned with Design r3: no bundle-size prediction; the verified facts are unpacked package size, direct/transitive count, and CommonJS module format. Bundle delta is validated by `npm run build`.

## Ordered edit steps

1. **Add the dependency.**
   - In [package.json](package.json#L29-L40), add `"telegramify-markdown": "^1.3.3"` under `dependencies`.
   - Run `npm install` once to refresh `package-lock.json`.

2. **Rewrite [src/channels/telegram.ts](src/channels/telegram.ts).** Final shape:

   - Imports:
     - Add `import telegramifyMarkdown from "telegramify-markdown";`. The package's default export is a function with signature `(md: string, escapeMode?: "escape" | "keep" | "remove") => string`. If installation reveals the export is named instead, switch to `import { telegramifyMarkdown } from "telegramify-markdown";` — `npm run typecheck` will tell us in one step before commit.
     - Keep the existing `ChatChannel` / `log` imports.
   - Type change:
     - `export type TelegramSendFn = (text: string, parseMode?: "MarkdownV2") => Promise<void>;` ([src/channels/telegram.ts](src/channels/telegram.ts#L17-L20)).
   - Remove `escapeHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L33)) and `markdownToTelegramHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L38-L82)) in full. Remove the "Markdown → Telegram HTML conversion" banner comment.
   - Replace `send` ([src/channels/telegram.ts](src/channels/telegram.ts#L95-L118)) with:

     ```ts
     async send(message: string): Promise<void> {
       if (this.closed) return;
       for (const fragment of splitSourceForTelegram(message, TG_MAX_LENGTH)) {
         await this.sendFn(telegramifyMarkdown(fragment, "escape"), "MarkdownV2");
       }
     }
     ```

   - Add the block-aware + span-aware source-side splitter and its helpers. All module-private. Implementation contract:

     ```ts
     // Returns a sequence of source-Markdown fragments such that
     // telegramifyMarkdown(fragment, "escape").length <= max for each.
     function splitSourceForTelegram(md: string, max: number): string[] {
       const blocks = tokenizeBlocks(md);
       const out: string[] = [];
       let current = "";
       for (const block of blocks) {
         const candidate = current === "" ? block : current + "\n\n" + block;
         if (convertedLen(candidate) <= max) {
           current = candidate;
           continue;
         }
         if (current !== "") {
           out.push(current);
           current = "";
         }
         if (convertedLen(block) <= max) {
           current = block;
         } else {
           for (const piece of splitOversizedBlock(block, max)) out.push(piece);
         }
       }
       if (current !== "") out.push(current);
       return out;
     }

     // Block units: each fenced code block (```...```) is one atomic unit;
     // everything else is grouped by blank-line separators into paragraph units.
     function tokenizeBlocks(md: string): string[] { /* … */ }

     // Recursively reduces an oversized unit to converted-length-bounded fragments.
     // - Fenced code block: split content by line; each piece re-wrapped with the
     //   original opener (including language tag) and closer. Each piece is a
     //   complete fenced block.
     // - Paragraph: split by '\n'. If a single line still over-runs, split by
     //   sentence boundary (/[.?!]\s+/). If still over-running, hand to
     //   splitParagraphIntoAtomicSpans (span-aware packing).
     function splitOversizedBlock(block: string, max: number): string[] { /* … */ }

     // Splits a paragraph that exceeds `max` after line/sentence splitting.
     // Tokenizes into atomic spans, then greedily packs spans into fragments
     // whose convertedLen <= max. Plain-text-run spans may be re-split at
     // whitespace; formatted spans (inline-code, link, emphasis) are kept whole.
     // If a single formatted span's own convertedLen > max, that span is
     // hard-cut on its raw source at a UTF-8 code-point boundary (worst-case
     // degradation; the cut span renders as plain text on Telegram by design).
     function splitParagraphIntoAtomicSpans(paragraph: string, max: number): string[] { /* … */ }

     function convertedLen(md: string): number {
       return telegramifyMarkdown(md, "escape").length;
     }
     ```

     Implementation notes the engineer should follow:
     - `tokenizeBlocks` recognizes a fenced opener as a line matching `/^ {0,3}```([^\n]*)$/` and the matching closer as the next line matching `/^ {0,3}```\s*$/`. Indented code blocks are treated as paragraphs (Telegram MarkdownV2 has no semantic for 4-space indented blocks distinct from text).
     - `splitParagraphIntoAtomicSpans` tokenizes the paragraph greedily by trying the following span patterns in order at each position: fenced inline code `` `…` `` (handles backtick-escaped runs the same way `telegramify-markdown` does — a span is `` ` `` followed by content not containing `` ` ``, terminated by the next `` ` ``), link `[text](url)` (matched non-greedily, balanced `(` `)` inside url permitted only via standard MarkdownV2 rules), emphasis `**…**`, `__…__`, `*…*`, `_..._` (matched non-greedily, terminated by the same delimiter), and otherwise a plain-text run up to the next span boundary or whitespace. Atomic-span boundaries are also paragraph-fragment boundaries during packing.
     - The hard-cut fallback splits at `Array.from(token).slice(0, n).join("")` to be code-point safe (so multi-byte glyphs are not bisected). It is the only place source characters get cut without a natural boundary, and it is on raw source, so the subsequent `telegramifyMarkdown` pass always produces a balanced escape output.
     - `convertedLen` is called O(blocks + spans) times during the packing loops. `telegramifyMarkdown` is pure and deterministic; no memoization is needed for the message sizes seen in practice (a single LLM message is <50 kB).

3. **Update [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L65).**
   - Change the `sendFn` literal: `async (text: string, parseMode?: "MarkdownV2") => { await bot.api.sendMessage(chatId, text, { parse_mode: parseMode, link_preview_options: { is_disabled: true } }); }`.
   - No other changes; `link_preview_options` stays.

4. **Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts).**

   Keep the queueing test as-is ([src/channels/telegram.test.ts](src/channels/telegram.test.ts#L5-L17)). Replace the old HTML-escape test and add the cases below. Every test uses an in-memory `sendFn` mock; no network.

   ```ts
   it("forwards Markdown to Telegram with MarkdownV2 escaping", async () => {
     const sent: { text: string; parseMode?: "MarkdownV2" }[] = [];
     const channel = new TelegramChannel(123, async (text, parseMode) => {
       sent.push({ text, parseMode });
     });

     await channel.send("2 < 3 & **safe** `code <tag>`");

     expect(sent).toHaveLength(1);
     expect(sent[0]?.parseMode).toBe("MarkdownV2");
     expect(sent[0]?.text).toContain("*safe*");
     expect(sent[0]?.text).toContain("`code <tag>`");
   });

   it("converts nested emphasis without producing invalid output (short)", async () => {
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     await channel.send("**bold *italic* end**");

     expect(sent).toHaveLength(1);
     expect(sent[0]).toMatch(/\*bold/);
     expect(sent[0]).toMatch(/italic/);
   });

   it("splits long paragraph-only messages on paragraph boundaries", async () => {
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     const paragraph = "x".repeat(2000);
     await channel.send(`${paragraph}\n\n${paragraph}\n\n${paragraph}`);

     expect(sent.length).toBeGreaterThan(1);
     for (const part of sent) expect(part.length).toBeLessThanOrEqual(4096);
   });

   it("splits an oversized fenced code block into self-contained fences", async () => {
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     // ~5 KB of fenced code.
     const lines = Array.from({ length: 500 }, (_, i) => `line_${i}`).join("\n");
     await channel.send("intro\n\n```ts\n" + lines + "\n```\n\nouter trailer");

     expect(sent.length).toBeGreaterThan(1);
     for (const part of sent) {
       expect(part.length).toBeLessThanOrEqual(4096);
       // Every chunk that contains fenced output must have balanced fences:
       // the number of ``` markers on their own line must be even.
       const fenceMarkers = (part.match(/^```/gm) ?? []).length;
       expect(fenceMarkers % 2).toBe(0);
       // And no chunk may end immediately after a MarkdownV2 escape backslash.
       expect(part.endsWith("\\")).toBe(false);
     }
   });

   it("splits a paragraph dominated by punctuation that expands under escaping", async () => {
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     // Every '.' becomes '\.' so the converted length is ~2x the input.
     const punctHeavy = "a.b.c.d.e.f.".repeat(250); // 3000 chars
     await channel.send(punctHeavy);

     expect(sent.length).toBeGreaterThanOrEqual(1);
     for (const part of sent) {
       expect(part.length).toBeLessThanOrEqual(4096);
       expect(part.endsWith("\\")).toBe(false);
     }
   });

   it("splits a long nested-emphasis paragraph across a boundary with balanced delimiters", async () => {
     // Boundary case required by r1/r2: force a split inside a paragraph that
     // is itself dominated by formatted runs. Each repeated unit is a complete
     // nested-emphasis run; after MarkdownV2 escaping the whole paragraph
     // exceeds 4096, so the splitter must cut between units, never inside one.
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     const unit = "**bold *italic* tail**"; // 22 source chars, all formatting-relevant
     const paragraph = Array.from({ length: 250 }, () => unit).join(" "); // ~5.7 KB

     await channel.send(paragraph);

     expect(sent.length).toBeGreaterThan(1);
     for (const part of sent) {
       expect(part.length).toBeLessThanOrEqual(4096);
       // No chunk ends with a dangling MarkdownV2 escape backslash.
       expect(part.endsWith("\\")).toBe(false);
       // Balanced emphasis at chunk boundary: count of unescaped '*' must be
       // even. (telegramify-markdown escapes literal '*' as '\\*'; unescaped
       // '*' delimit emphasis spans.)
       const unescapedStars = (part.match(/(?<!\\)\*/g) ?? []).length;
       expect(unescapedStars % 2).toBe(0);
       // Same for '_' (the other emphasis delimiter in MarkdownV2).
       const unescapedUnderscores = (part.match(/(?<!\\)_/g) ?? []).length;
       expect(unescapedUnderscores % 2).toBe(0);
     }
   });

   it("splits a paragraph of many inline-code spans without slicing any span", async () => {
     // Boundary case required by r1/r2: force a split inside a paragraph that
     // contains many inline-code spans whose converted total exceeds 4096.
     // Each span is short enough to fit; the splitter must cut between spans,
     // never inside one.
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     const span = "`identifier_with_underscores_and_dots.v1`"; // ~41 source chars
     const paragraph = Array.from({ length: 200 }, () => span).join(" "); // ~8.4 KB

     await channel.send(paragraph);

     expect(sent.length).toBeGreaterThan(1);
     for (const part of sent) {
       expect(part.length).toBeLessThanOrEqual(4096);
       expect(part.endsWith("\\")).toBe(false);
       // Balanced inline-code: number of unescaped backticks must be even.
       const unescapedBackticks = (part.match(/(?<!\\)`/g) ?? []).length;
       expect(unescapedBackticks % 2).toBe(0);
     }
     // Every span instance is preserved across chunks (200 spans total).
     const totalSpanOccurrences = sent
       .map((p) => (p.match(/`identifier_with_underscores_and_dots\\?\.v1`/g) ?? []).length)
       .reduce((a, b) => a + b, 0);
     expect(totalSpanOccurrences).toBe(200);
   });

   it("hard-cuts a single inline-code span longer than the limit (worst-case degradation)", async () => {
     // Worst case: one inline-code span whose own converted length exceeds
     // 4096. Per Design r3 step 4 the splitter falls back to raw-source
     // hard-cut on that span; the cut span renders as plain text on Telegram
     // by design. The test asserts deliverability (multiple chunks, all under
     // the limit, no dangling escape), not formatting preservation.
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     const huge = "x".repeat(6000);
     await channel.send("`" + huge + "`");

     expect(sent.length).toBeGreaterThan(1);
     for (const part of sent) {
       expect(part.length).toBeLessThanOrEqual(4096);
       expect(part.endsWith("\\")).toBe(false);
     }
     // Content is preserved across chunks (modulo MarkdownV2 escaping of 'x',
     // which is not in the reserved set, so it appears verbatim).
     const joined = sent.join("");
     expect(joined).toContain("x".repeat(100)); // sanity: a long run survived intact
   });
   ```

   Notes on the test design:
   - The fenced-balance assertion catches the r1 failure mode (chunks ending mid-fence).
   - The "no chunk ends with `\\`" assertion catches dangling MarkdownV2 escapes.
   - The punctuation-heavy test is the explicit "escaped output expands past 4096 even though source is under 4096" boundary.
   - The long nested-emphasis test is the boundary case r1 explicitly required and r2 omitted; it asserts balanced emphasis delimiters across the cut, which is the structural invariant Telegram requires.
   - The many-inline-code-spans test is the long-inline-code boundary case r1 explicitly required and r2 omitted; it asserts no span is sliced.
   - The worst-case-degradation test pins the documented behavior for the single-span-over-limit case so future refactors do not regress it silently.

## Test strategy

- **Existing coverage:** [src/channels/telegram.test.ts](src/channels/telegram.test.ts) is the only file that exercises this code; the queueing test is unchanged. The HTML escape test is replaced with the MarkdownV2 case above.
- **New tests:** eight vitest cases listed above — MarkdownV2 escape, short nested emphasis, paragraph-boundary chunking, fenced-code-block chunking with balance check, punctuation/escape-expansion chunking, long nested-emphasis boundary chunking, long inline-code boundary chunking, and worst-case single-span degradation.
- **Manual smoke (optional):** send the live bot a message containing a fenced code block of 200+ lines, a `**bold *italic***`, a `>` blockquote, and a long line of `.....`s. Observe that the bot replies without `"can't parse entities"` errors and that messages over 4096 chars are split with no missing or duplicated text.

## Validation commands

Run from `/home/salva/g/ml/saivage`:

```
npm install
npm run typecheck
npx vitest run src/channels/telegram.test.ts
npm run build
```

`npm run build` is part of the standard validation so that the actual bundle delta from adding `telegramify-markdown` is observed on the real build, rather than being predicted in the design. `npm run typecheck` and the full `npx vitest run` (no path filter) are also acceptable; the focused vitest path is the targeted one for this change.

## Rollback strategy

Single commit. Revert via `git revert <sha>`. The `package.json` dependency line, the rewritten `telegram.ts`, the rewritten `telegram.test.ts`, and the `telegram-bot.ts` `sendFn` signature change all revert together. `package-lock.json` regenerates with `npm install` after the revert. No data migration, no on-disk state touched.

## Cross-issue ordering note

- **Independent of every other Fxx in this review.** `TelegramChannel` is module-local; the converter is module-private; no other issue touches `src/channels/telegram.ts` or `src/server/telegram-bot.ts`.
- F16 (the broader Telegram-bot issue) may follow or precede F17 without conflict. If F16 lands first and rewrites `telegram-bot.ts`, F17 only needs to update the new `sendFn` signature; if F17 lands first, F16 inherits the `"MarkdownV2"` parse-mode type and the source-side chunker.
