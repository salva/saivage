import { describe, it, expect } from "vitest";
import { ragOk, ragErr } from "./envelope.js";

describe("rag envelope", () => {
  it("ragOk produces { ok: true, content }", () => {
    expect(ragOk({ a: 1 })).toEqual({ ok: true, content: { a: 1 } });
  });

  it("ragErr without details omits the field", () => {
    expect(ragErr("RAG_X", "bad")).toEqual({ ok: false, code: "RAG_X", message: "bad" });
  });

  it("ragErr with details includes them", () => {
    expect(ragErr("RAG_X", "bad", { k: 1 })).toEqual({
      ok: false,
      code: "RAG_X",
      message: "bad",
      details: { k: 1 },
    });
  });
});
