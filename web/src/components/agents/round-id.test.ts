import { describe, expect, it } from "vitest";
import { parseRoundId, roundIdSortKey } from "./round-id";

describe("parseRoundId", () => {
  const cases: Array<{ input: string; kind: ReturnType<typeof parseRoundId>["kind"]; index?: number }> = [
    { input: "r-pre", kind: "pre" },
    { input: "r0", kind: "round", index: 0 },
    { input: "r1", kind: "round", index: 1 },
    { input: "r42", kind: "round", index: 42 },
    { input: "r-msg:0", kind: "msg", index: 0 },
    { input: "r-msg:7", kind: "msg", index: 7 },
    { input: "r-compacted-3", kind: "compacted", index: 3 },
    { input: "", kind: "unknown" },
    { input: "r", kind: "unknown" },
    { input: "r-", kind: "unknown" },
    { input: "r-1", kind: "unknown" },
    { input: "r1x", kind: "unknown" },
    { input: "r1 ", kind: "unknown" },
    { input: " r1", kind: "unknown" },
    { input: "r+1", kind: "unknown" },
    { input: "r01", kind: "round", index: 1 },
    { input: "r1e3", kind: "unknown" },
    { input: "r0x10", kind: "unknown" },
    { input: "r-msg:", kind: "unknown" },
    { input: "r-msg:3junk", kind: "unknown" },
    { input: "r-msg:+3", kind: "unknown" },
    { input: "r-msg:-3", kind: "unknown" },
    { input: "r-msg: 3", kind: "unknown" },
    { input: "r-compacted-", kind: "unknown" },
    { input: "r-compacted-3x", kind: "unknown" },
    { input: "r99999999999999999999", kind: "unknown" },
    { input: "R1", kind: "unknown" },
  ];

  for (const tc of cases) {
    it(`parses ${JSON.stringify(tc.input)} as ${tc.kind}`, () => {
      const parsed = parseRoundId(tc.input);
      expect(parsed.kind).toBe(tc.kind);
      if (tc.index !== undefined) {
        expect("index" in parsed ? parsed.index : undefined).toBe(tc.index);
      } else {
        expect("index" in parsed).toBe(false);
      }
    });
  }
});

describe("roundIdSortKey", () => {
  function compare(a: string, b: string): number {
    const [at, av] = roundIdSortKey(a);
    const [bt, bv] = roundIdSortKey(b);
    return at !== bt ? at - bt : av - bv;
  }

  it("sorts pre before numeric rounds", () => {
    expect(compare("r-pre", "r0")).toBeLessThan(0);
  });

  it("sorts numeric rounds by index", () => {
    expect(compare("r1", "r10")).toBeLessThan(0);
  });

  it("sorts message buckets before rounds and compacted buckets", () => {
    expect(compare("r-msg:0", "r0")).toBeLessThan(0);
    expect(compare("r-msg:0", "r-compacted-0")).toBeLessThan(0);
  });

  it("sorts compacted buckets by index", () => {
    expect(compare("r-compacted-0", "r-compacted-99")).toBeLessThan(0);
  });
});
