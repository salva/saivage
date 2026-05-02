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

  it("escapes Telegram HTML while preserving basic markdown formatting", async () => {
    const sent: { text: string; parseMode?: "HTML" }[] = [];
    const channel = new TelegramChannel(123, async (text, parseMode) => {
      sent.push({ text, parseMode });
    });

    await channel.send("2 < 3 & **safe** `code <tag>`");

    expect(sent).toEqual([
      {
        text: "2 &lt; 3 &amp; <b>safe</b> <code>code &lt;tag&gt;</code>",
        parseMode: "HTML",
      },
    ]);
  });
});