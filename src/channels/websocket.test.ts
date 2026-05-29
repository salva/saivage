import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { WebSocketChannel } from "./websocket.js";
import { log } from "../log.js";

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: string[] = [];
  closeCalls: Array<[number?, string?]> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.emit("close");
  }
}

function channel() {
  const ws = new FakeWebSocket();
  return { ws, ch: new WebSocketChannel(ws as unknown as WebSocket) };
}

describe("WebSocketChannel", () => {
  it("routes valid message envelopes to the message handler", () => {
    const { ws, ch } = channel();
    const seen: string[] = [];
    ch.onMessage((msg) => { seen.push(msg); });

    ws.emit("message", Buffer.from(JSON.stringify({ type: "message", content: "hello" })));

    expect(seen).toEqual(["hello"]);
    expect(ws.closeCalls).toEqual([]);
  });

  it("closes malformed inbound frames with 1003", () => {
    const { ws, ch } = channel();
    const seen: string[] = [];
    ch.onMessage((msg) => { seen.push(msg); });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    ws.emit("message", Buffer.from("garbage"));

    expect(seen).toEqual([]);
    expect(ws.closeCalls.at(-1)).toEqual([1003, "schema-violation"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropping malformed inbound frame"));
  });

  it("logs inbound error envelopes without routing to chat", () => {
    const { ws, ch } = channel();
    const seen: string[] = [];
    ch.onMessage((msg) => { seen.push(msg); });
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    ws.emit("message", Buffer.from(JSON.stringify({ type: "error", reason: "bad-frame" })));

    expect(seen).toEqual([]);
    expect(ws.closeCalls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("client reported schema violation"));
  });

  it("sends parsed outbound messages", () => {
    const { ws, ch } = channel();

    ch.send("hello");

    expect(ws.sent).toEqual(['{"type":"message","content":"hello"}']);
  });

  it("sendEvent throws on drifting shapes and writes nothing", () => {
    const { ws, ch } = channel();

    expect(() => ch.sendEvent({ type: "toolCall" } as unknown as Parameters<typeof ch.sendEvent>[0])).toThrow();
    expect(ws.sent).toHaveLength(0);
  });

  it("sendEvent rejects extra fields", () => {
    const { ws, ch } = channel();

    expect(() => ch.sendEvent({ type: "session", sessionId: "abc", extra: 1 } as unknown as Parameters<typeof ch.sendEvent>[0])).toThrow();
    expect(ws.sent).toHaveLength(0);
  });
});
