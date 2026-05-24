# F17 — Plan r1 (Proposal A)

## Ordered edit steps

1. **Add the dependency.**
   - In [package.json](package.json#L29-L40), add `"telegramify-markdown": "^1.3.0"` (or the latest stable at install time) under `dependencies`.
   - Run `npm install` once to refresh `package-lock.json`.

2. **Rewrite [src/channels/telegram.ts](src/channels/telegram.ts).** Final shape:
   - Imports:
     - Add `import telegramifyMarkdown from "telegramify-markdown";` (default export per the package; if the installed version exports named, switch to `import { telegramify } from "telegramify-markdown"` — verify with `npx tsc --noEmit` before committing).
     - Keep `import { log } from "../log.js";` and the existing `ChatChannel` import.
   - Type change:
     - `export type TelegramSendFn = (text: string, parseMode?: "MarkdownV2") => Promise<void>;` ([src/channels/telegram.ts](src/channels/telegram.ts#L17-L20)).
   - Remove `escapeHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L26-L33)) and `markdownToTelegramHtml` ([src/channels/telegram.ts](src/channels/telegram.ts#L38-L82)) in full. Remove the `// ── Markdown → Telegram HTML conversion ───` banner comment.
   - Rewrite `send` ([src/channels/telegram.ts](src/channels/telegram.ts#L94-L119)) so chunking happens on the **input Markdown**:

     ```ts
     async send(message: string): Promise<void> {
       if (this.closed) return;
       for (const chunk of splitMarkdown(message, TG_MAX_LENGTH)) {
         await this.sendFn(telegramifyMarkdown(chunk, "escape"), "MarkdownV2");
       }
     }
     ```

   - Add a module-private helper `splitMarkdown(md: string, max: number): string[]`:

     ```ts
     function splitMarkdown(md: string, max: number): string[] {
       if (md.length <= max) return [md];
       const chunks: string[] = [];
       let remaining = md;
       while (remaining.length > max) {
         let cut = remaining.lastIndexOf("\n\n", max);
         if (cut <= 0) cut = remaining.lastIndexOf("\n", max);
         if (cut <= 0) cut = max;
         chunks.push(remaining.slice(0, cut));
         remaining = remaining.slice(cut).replace(/^\s+/, "");
       }
       if (remaining.length > 0) chunks.push(remaining);
       return chunks;
     }
     ```

     Note: chunks are individually fed to `telegramifyMarkdown`. The 4096-char Telegram budget is on the **rendered** output, not the input, so `max` for splitting is conservatively the same value. `telegramifyMarkdown(md, "escape")` only inserts backslashes, so output length is ≤ ~1.25× input length; for messages between ~3.3 k and 4 k chars the escape pass could overshoot. Mitigation: after escaping, if `escaped.length > 4096`, fall back to a hard cut at the last newline before 4096 in the escaped string. Implement this as a second pass inside the `for` loop:

     ```ts
     async send(message: string): Promise<void> {
       if (this.closed) return;
       for (const chunk of splitMarkdown(message, TG_MAX_LENGTH)) {
         let escaped = telegramifyMarkdown(chunk, "escape");
         while (escaped.length > TG_MAX_LENGTH) {
           const cut = Math.max(
             escaped.lastIndexOf("\n", TG_MAX_LENGTH),
             TG_MAX_LENGTH - 1,
           );
           await this.sendFn(escaped.slice(0, cut), "MarkdownV2");
           escaped = escaped.slice(cut).replace(/^\s+/, "");
         }
         await this.sendFn(escaped, "MarkdownV2");
       }
     }
     ```

3. **Update [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L65).**
   - Change the `sendFn` signature literal: `async (text: string, parseMode?: "MarkdownV2") => { … parse_mode: parseMode … }`.
   - No other changes; `link_preview_options` stays.

4. **Update [src/channels/telegram.test.ts](src/channels/telegram.test.ts#L20-L34).**
   - Keep the queueing test as-is ([src/channels/telegram.test.ts](src/channels/telegram.test.ts#L5-L17)).
   - Replace the HTML-escape test with a MarkdownV2 test:

     ```ts
     it("forwards Markdown to Telegram with MarkdownV2 escaping", async () => {
       const sent: { text: string; parseMode?: "MarkdownV2" }[] = [];
       const channel = new TelegramChannel(123, async (text, parseMode) => {
         sent.push({ text, parseMode });
       });

       await channel.send("2 < 3 & **safe** `code <tag>`");

       expect(sent).toHaveLength(1);
       expect(sent[0]?.parseMode).toBe("MarkdownV2");
       // telegramify-markdown is the contract; assert the
       // shape rather than re-implementing the escape rules.
       expect(sent[0]?.text).toContain("*safe*");
       expect(sent[0]?.text).toContain("`code <tag>`");
       expect(sent[0]?.text).toMatch(/2 < 3/);
     });
     ```

   - Add one new test for nested formatting (the bug class that motivated the change):

     ```ts
     it("converts nested emphasis without producing invalid output", async () => {
       const sent: string[] = [];
       const channel = new TelegramChannel(123, async (text) => {
         sent.push(text);
       });

       await channel.send("**bold *italic* end**");

       expect(sent).toHaveLength(1);
       // MarkdownV2 supports nested emphasis natively; the
       // converter must not strip or duplicate delimiters.
       expect(sent[0]).toMatch(/\*bold/);
       expect(sent[0]).toMatch(/italic/);
     });
     ```

   - Add one new test for the chunk-boundary case:

     ```ts
     it("splits long messages on paragraph boundaries", async () => {
       const sent: string[] = [];
       const channel = new TelegramChannel(123, async (text) => {
         sent.push(text);
       });

       const paragraph = "x".repeat(2000);
       await channel.send(`${paragraph}\n\n${paragraph}\n\n${paragraph}`);

       expect(sent.length).toBeGreaterThan(1);
       for (const part of sent) expect(part.length).toBeLessThanOrEqual(4096);
     });
     ```

## Test strategy

- **Existing coverage**: [src/channels/telegram.test.ts](src/channels/telegram.test.ts) is the only file that exercises this code; the queueing test is unchanged. The escape test is rewritten as above.
- **New tests**: three vitest cases listed above — MarkdownV2 escape, nested emphasis, chunking. All synchronous against an in-memory `sendFn` mock, no network.
- **Manual smoke**: not required, but if performed, send the bot a message containing a fenced code block, a nested bold/italic, and a `>` blockquote; observe that the bot replies without `"can't parse entities"` errors.

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

Single commit. Revert via `git revert <sha>`. The dependency line in `package.json` and the rewritten `telegram.ts` / `telegram.test.ts` revert together; `package-lock.json` regenerates with `npm install` after revert. No data migration, no on-disk state touched.

## Cross-issue ordering note

- **Independent of every other Fxx in this review.** `TelegramChannel` is module-local; the converter is module-private; no other issue touches `src/channels/telegram.ts` or `src/server/telegram-bot.ts`.
- F16 (the broader Telegram-bot issue) may follow or precede F17 without conflict. If F16 lands first and rewrites `telegram-bot.ts`, F17 only needs to update the new `sendFn` signature; if F17 lands first, F16 inherits the `"MarkdownV2"` parse-mode type.
