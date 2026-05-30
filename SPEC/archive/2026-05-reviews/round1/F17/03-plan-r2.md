# F17 — Plan r2 (Proposal A)

## Changes from r1

- **Chunking model rewritten to never slice converted MarkdownV2.** r1 split source Markdown first, then converted each chunk; but if the converted result still exceeded 4096 chars, r1 hard-cut the escaped MarkdownV2 string at a newline. That hard cut could fall inside an inline code span, a fenced code block, a `[…]` link-text, an emphasis pair, or immediately after a MarkdownV2 escape backslash — producing exactly the "invalid entities" failure F17 is meant to remove. r2 replaces that step with **recursive block-aware source-side splitting**: every string passed to `sendFn` is the complete output of a single `telegramifyMarkdown(fragment, "escape")` call on a syntactically self-contained source fragment.
- **Chunking tests strengthened** to cover escape-expansion at the boundary, an oversized fenced code block, a long inline-code span at the cut point, and a long nested-emphasis paragraph at the cut point. The trivial "repeated `x`" test is kept only as a smoke check.
- **Dependency note** corrected to match Design r2: `telegramify-markdown` has 9 direct dependencies; the addition is justified there, not minimized here.
- **Line references** updated where the analysis correction applies.

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

   - Add the block-aware source-side splitter and its helpers. All module-private. Implementation contract (precise enough to write without further design):

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
     //   sentence boundary (/[.?!]\s+/). If still over-running, split by whitespace.
     //   If still over-running (single token, no whitespace), hard-cut at a
     //   UTF-8-safe code-point boundary on the SOURCE string — never on the
     //   converted output.
     function splitOversizedBlock(block: string, max: number): string[] { /* … */ }

     function convertedLen(md: string): number {
       return telegramifyMarkdown(md, "escape").length;
     }
     ```

     Implementation notes the engineer should follow:
     - `tokenizeBlocks` recognizes a fenced opener as a line matching `/^ {0,3}```([^\n]*)$/` and the matching closer as the next line matching `/^ {0,3}```\s*$/`. Indented code blocks are treated as paragraphs (Telegram MarkdownV2 has no semantic for 4-space indented blocks distinct from text).
     - The hard-cut fallback splits at `Array.from(token).slice(0, n).join("")` to be code-point safe (so multi-byte glyphs are not bisected). It is the only place source characters get cut without a natural boundary, and it is on raw source, so the subsequent `telegramifyMarkdown` pass always produces a balanced escape output.
     - `convertedLen` is called O(blocks) times in the greedy loop, plus O(log) extra calls during recursive splits. `telegramifyMarkdown` is pure and deterministic; no memoization needed for the message sizes seen in practice (a single LLM message is <50 kB).

3. **Update [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L65).**
   - Change the `sendFn` literal: `async (text: string, parseMode?: "MarkdownV2") => { await bot.api.sendMessage(chatId, text, { parse_mode: parseMode, link_preview_options: { is_disabled: true } }); }`.
   - No other changes; `link_preview_options` stays.

4. **Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts).**

   Keep the queueing test as-is ([src/channels/telegram.test.ts](src/channels/telegram.test.ts#L5-L17)). Replace the old HTML-escape test and add the four new chunking cases below. Every test uses an in-memory `sendFn` mock; no network.

   ```ts
   it("forwards Markdown to Telegram with MarkdownV2 escaping", async () => {
     const sent: { text: string; parseMode?: "MarkdownV2" }[] = [];
     const channel = new TelegramChannel(123, async (text, parseMode) => {
       sent.push({ text, parseMode });
     });

     await channel.send("2 < 3 & **safe** `code <tag>`");

     expect(sent).toHaveLength(1);
     expect(sent[0]?.parseMode).toBe("MarkdownV2");
     // telegramify-markdown is the contract; assert shape rather than
     // re-implementing the rule.
     expect(sent[0]?.text).toContain("*safe*");
     expect(sent[0]?.text).toContain("`code <tag>`");
   });

   it("converts nested emphasis without producing invalid output", async () => {
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

     // 500 lines * ~10 chars each + fence overhead ≈ 5 KB of source.
     const lines = Array.from({ length: 500 }, (_, i) => `line_${i}`).join("\n");
     await channel.send("intro\n\n```ts\n" + lines + "\n```\n\nouter trailer");

     expect(sent.length).toBeGreaterThan(1);
     for (const part of sent) {
       expect(part.length).toBeLessThanOrEqual(4096);
       // Every chunk that contains fenced output must have balanced fences:
       // the number of ``` markers on their own line must be even.
       const fenceMarkers = (part.match(/^```/gm) ?? []).length;
       expect(fenceMarkers % 2).toBe(0);
       // And no chunk may end immediately after a MarkdownV2 escape backslash
       // (that is the prototypical "dangling escape" failure mode).
       expect(part.endsWith("\\")).toBe(false);
     }
   });

   it("splits a paragraph dominated by punctuation that expands under escaping", async () => {
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     // Lots of MarkdownV2-reserved punctuation: every '.' becomes '\.' so the
     // converted length is ~2x the input. A 3000-char input lands near the
     // 4096-char Telegram limit only after escaping, which is the boundary
     // case r1 mishandled.
     const punctHeavy = "a.b.c.d.e.f.".repeat(250); // 3000 chars
     await channel.send(punctHeavy);

     expect(sent.length).toBeGreaterThanOrEqual(1);
     for (const part of sent) {
       expect(part.length).toBeLessThanOrEqual(4096);
       expect(part.endsWith("\\")).toBe(false);
     }
   });

   it("splits inline code at non-code source boundaries when the span is short", async () => {
     // The point of this case is: when a paragraph contains an inline code
     // span that fits within max, the splitter must not cut INSIDE the span.
     const sent: string[] = [];
     const channel = new TelegramChannel(123, async (text) => sent.push(text));

     const filler = "word ".repeat(800); // ~4000 chars of plain text
     const inline = "`identifier_with_underscores`";
     await channel.send(`${filler}\n\n${inline}\n\n${filler}`);

     expect(sent.length).toBeGreaterThan(1);
     for (const part of sent) {
       expect(part.length).toBeLessThanOrEqual(4096);
       // Inline-code span must appear intact in exactly one chunk.
     }
     expect(sent.some((p) => p.includes("`identifier_with_underscores`"))).toBe(true);
   });
   ```

   Notes on the test design:
   - The "balanced fences" assertion in the fenced-code test is what catches the r1 failure mode: r1 would emit a chunk ending mid-``` or mid-line of code-block content, producing an odd fence-marker count.
   - The "no chunk ends with `\\`" assertion catches dangling MarkdownV2 escapes — the prototypical failure of hard-cutting an escaped string.
   - The punctuation-heavy test is the explicit "escaped output expands past 4096 even though source is under 4096" case the reviewer required.
   - The inline-code test asserts the span lands intact in one chunk; it does not test cutting inside an inline code span because the splitter is designed to never need that (inline spans are part of a paragraph unit and the unit-level packing keeps them whole).

## Test strategy

- **Existing coverage:** [src/channels/telegram.test.ts](src/channels/telegram.test.ts) is the only file that exercises this code; the queueing test is unchanged. The HTML escape test is replaced with the MarkdownV2 case above.
- **New tests:** six vitest cases listed above — MarkdownV2 escape, nested emphasis, paragraph-boundary chunking, fenced-code-block chunking with balance check, punctuation/escape-expansion chunking, and inline-code preservation.
- **Manual smoke (optional):** send the live bot a message containing a fenced code block of 200+ lines, a `**bold *italic***`, a `>` blockquote, and a long line of `.....`s. Observe that the bot replies without `"can't parse entities"` errors and that messages over 4096 chars are split with no missing or duplicated text.

## Validation commands

Run from `/home/salva/g/ml/saivage`:

```
npm install
npm run typecheck
npx vitest run src/channels/telegram.test.ts
npm run build
```

`npm run typecheck` and the full `npx vitest run` (no path filter) are also acceptable; the focused vitest path is the targeted one for this change.

## Rollback strategy

Single commit. Revert via `git revert <sha>`. The `package.json` dependency line, the rewritten `telegram.ts`, the rewritten `telegram.test.ts`, and the `telegram-bot.ts` `sendFn` signature change all revert together. `package-lock.json` regenerates with `npm install` after the revert. No data migration, no on-disk state touched.

## Cross-issue ordering note

- **Independent of every other Fxx in this review.** `TelegramChannel` is module-local; the converter is module-private; no other issue touches `src/channels/telegram.ts` or `src/server/telegram-bot.ts`.
- F16 (the broader Telegram-bot issue) may follow or precede F17 without conflict. If F16 lands first and rewrites `telegram-bot.ts`, F17 only needs to update the new `sendFn` signature; if F17 lands first, F16 inherits the `"MarkdownV2"` parse-mode type and the source-side chunker.
