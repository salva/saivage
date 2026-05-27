import { describe, it, expect } from "vitest";
import { tryRunExclusive } from "./mutex.js";

describe("tryRunExclusive", () => {
  it("runs the function and releases the slot on success", async () => {
    const state = { busy: false };
    const r = tryRunExclusive(state, async () => 42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(await r.value).toBe(42);
    expect(state.busy).toBe(false);
  });

  it("returns { ok: false } when slot is busy", async () => {
    const state = { busy: false };
    const a = tryRunExclusive(state, async () => {
      await new Promise((res) => setTimeout(res, 5));
      return "a";
    });
    expect(a.ok).toBe(true);
    expect(state.busy).toBe(true);
    const b = tryRunExclusive(state, async () => "b");
    expect(b.ok).toBe(false);
    if (a.ok) await a.value;
    expect(state.busy).toBe(false);
  });

  it("releases slot when fn throws synchronously", async () => {
    const state = { busy: false };
    const r = tryRunExclusive(state, () => {
      throw new Error("sync");
    });
    expect(r.ok).toBe(true);
    if (r.ok) await expect(r.value).rejects.toThrow("sync");
    expect(state.busy).toBe(false);
  });

  it("releases slot when fn rejects", async () => {
    const state = { busy: false };
    const r = tryRunExclusive(state, async () => {
      throw new Error("async");
    });
    expect(r.ok).toBe(true);
    if (r.ok) await expect(r.value).rejects.toThrow("async");
    expect(state.busy).toBe(false);
  });
});
