// F01 B12 — Debouncer tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Debouncer, type DebouncerEvent } from "./debouncer.js";

describe("Debouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces events within the window and flushes on quiescence", () => {
    const flushes: DebouncerEvent[][] = [];
    const d = new Debouncer({ windowMs: 100, onFlush: (b) => flushes.push(b) });
    d.push({ kind: "upsert", path: "/a" });
    d.push({ kind: "upsert", path: "/b" });
    vi.advanceTimersByTime(50);
    d.push({ kind: "upsert", path: "/c" });
    vi.advanceTimersByTime(50);
    expect(flushes).toHaveLength(0); // window resets on every push
    vi.advanceTimersByTime(100);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toHaveLength(3);
    const paths = flushes[0].map((e) => e.path).sort();
    expect(paths).toEqual(["/a", "/b", "/c"]);
  });

  it("dedupes by path keeping the last event kind", () => {
    const flushes: DebouncerEvent[][] = [];
    const d = new Debouncer({ windowMs: 100, onFlush: (b) => flushes.push(b) });
    d.push({ kind: "upsert", path: "/x" });
    d.push({ kind: "delete", path: "/x" });
    vi.advanceTimersByTime(200);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual([{ kind: "delete", path: "/x" }]);
  });

  it("delete followed by upsert resolves to upsert", () => {
    const flushes: DebouncerEvent[][] = [];
    const d = new Debouncer({ windowMs: 100, onFlush: (b) => flushes.push(b) });
    d.push({ kind: "delete", path: "/y" });
    d.push({ kind: "upsert", path: "/y" });
    vi.advanceTimersByTime(200);
    expect(flushes[0]).toEqual([{ kind: "upsert", path: "/y" }]);
  });

  it("cancel drops pending without flushing", () => {
    const flushes: DebouncerEvent[][] = [];
    const d = new Debouncer({ windowMs: 100, onFlush: (b) => flushes.push(b) });
    d.push({ kind: "upsert", path: "/z" });
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(flushes).toHaveLength(0);
  });

  it("flush() forces immediate emit", () => {
    const flushes: DebouncerEvent[][] = [];
    const d = new Debouncer({ windowMs: 1_000_000, onFlush: (b) => flushes.push(b) });
    d.push({ kind: "upsert", path: "/p" });
    d.flush();
    expect(flushes).toHaveLength(1);
  });
});
