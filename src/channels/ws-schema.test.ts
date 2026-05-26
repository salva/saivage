import { describe, expect, it } from "vitest";

import {
  parseInbound,
  parseOutbound,
  WsInboundSchema,
  WsOutboundSchema,
} from "./ws-schema.js";

describe("WebSocket envelope schemas", () => {
  it("accepts inbound message envelopes", () => {
    expect(parseInbound(JSON.stringify({ type: "message", content: "hi" }))).toEqual({
      ok: true,
      value: { type: "message", content: "hi" },
    });
  });

  it("accepts inbound error envelopes", () => {
    expect(parseInbound(JSON.stringify({ type: "error", reason: "bad-frame", raw: "{" }))).toEqual({
      ok: true,
      value: { type: "error", reason: "bad-frame", raw: "{" },
    });
  });

  it("rejects invalid inbound JSON", () => {
    expect(parseInbound("not-json")).toMatchObject({
      ok: false,
      raw: "not-json",
    });
  });

  it("rejects malformed inbound error envelopes", () => {
    expect(parseInbound(JSON.stringify({ type: "error" }))).toMatchObject({ ok: false });
  });

  it("rejects extra inbound fields", () => {
    expect(WsInboundSchema.safeParse({ type: "message", content: "hi", extra: true }).success).toBe(false);
  });

  it("accepts outbound session, thinking, and message envelopes", () => {
    expect(WsOutboundSchema.parse({ type: "session", sessionId: "abc" })).toEqual({
      type: "session",
      sessionId: "abc",
    });
    expect(WsOutboundSchema.parse({ type: "thinking" })).toEqual({ type: "thinking" });
    expect(WsOutboundSchema.parse({
      type: "message",
      content: "hi",
      provider: "p",
      model: "m",
      modelSpec: "p/m",
    })).toMatchObject({ type: "message", content: "hi" });
  });

  it("rejects outbound drift and extra fields", () => {
    expect(parseOutbound(JSON.stringify({ type: "toolCall" }))).toMatchObject({ ok: false });
    expect(parseOutbound(JSON.stringify({ type: "message", content: "hi", bogus: "x" }))).toMatchObject({
      ok: false,
    });
  });
});
