import { describe, expect, it, vi } from "vitest";
import { TelegramChannel } from "./telegram.js";

describe("TelegramChannel", () => {
  it("queues incoming messages until a ChatAgent handler is registered", () => {
    const channel = new TelegramChannel(123, vi.fn());
    const received: string[] = [];

    channel.pushMessage("first");
    channel.pushMessage("second");
    channel.onMessage((message) => {
      received.push(message);
    });
    channel.pushMessage("third");

    expect(received).toEqual(["first", "second", "third"]);
  });

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
    const channel = new TelegramChannel(123, async (text) => { sent.push(text); });

    await channel.send("**bold *italic* end**");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/\*bold/);
    expect(sent[0]).toMatch(/italic/);
  });

  it("splits long paragraph-only messages on paragraph boundaries", async () => {
    const sent: string[] = [];
    const channel = new TelegramChannel(123, async (text) => { sent.push(text); });

    const paragraph = "x".repeat(2000);
    await channel.send(`${paragraph}\n\n${paragraph}\n\n${paragraph}`);

    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent) expect(part.length).toBeLessThanOrEqual(4096);
  });

  it("splits an oversized fenced code block into self-contained fences", async () => {
    const sent: string[] = [];
    const channel = new TelegramChannel(123, async (text) => { sent.push(text); });

    const lines = Array.from({ length: 500 }, (_, i) => `line_${i}`).join("\n");
    await channel.send("intro\n\n```ts\n" + lines + "\n```\n\nouter trailer");

    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent) {
      expect(part.length).toBeLessThanOrEqual(4096);
      const fenceMarkers = (part.match(/^```/gm) ?? []).length;
      expect(fenceMarkers % 2).toBe(0);
      expect(part.endsWith("\\")).toBe(false);
    }
  });

  it("splits a paragraph dominated by punctuation that expands under escaping", async () => {
    const sent: string[] = [];
    const channel = new TelegramChannel(123, async (text) => { sent.push(text); });

    const punctHeavy = "a.b.c.d.e.f.".repeat(250);
    await channel.send(punctHeavy);

    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const part of sent) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.endsWith("\\")).toBe(false);
    }
  });

  it("splits a long nested-emphasis paragraph across a boundary with balanced delimiters", async () => {
    const sent: string[] = [];
    const channel = new TelegramChannel(123, async (text) => { sent.push(text); });

    const unit = "**bold *italic* tail**";
    const paragraph = Array.from({ length: 250 }, () => unit).join(" ");

    await channel.send(paragraph);

    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.endsWith("\\")).toBe(false);
      const unescapedStars = (part.match(/(?<!\\)\*/g) ?? []).length;
      expect(unescapedStars % 2).toBe(0);
      const unescapedUnderscores = (part.match(/(?<!\\)_/g) ?? []).length;
      expect(unescapedUnderscores % 2).toBe(0);
    }
  });

  it("splits a paragraph of many inline-code spans without slicing any span", async () => {
    const sent: string[] = [];
    const channel = new TelegramChannel(123, async (text) => { sent.push(text); });

    const span = "`identifier_with_underscores_and_dots.v1`";
    const paragraph = Array.from({ length: 200 }, () => span).join(" ");

    await channel.send(paragraph);

    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.endsWith("\\")).toBe(false);
      const unescapedBackticks = (part.match(/(?<!\\)`/g) ?? []).length;
      expect(unescapedBackticks % 2).toBe(0);
    }
    const totalSpanOccurrences = sent
      .map((p) => (p.match(/`identifier_with_underscores_and_dots\\?\.v1`/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(totalSpanOccurrences).toBe(200);
  });

  it("hard-cuts a single inline-code span longer than the limit (worst-case degradation)", async () => {
    const sent: string[] = [];
    const channel = new TelegramChannel(123, async (text) => { sent.push(text); });

    const huge = "x".repeat(6000);
    await channel.send("`" + huge + "`");

    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.endsWith("\\")).toBe(false);
    }
    const joined = sent.join("");
    expect(joined).toContain("x".repeat(100));
  });
});
