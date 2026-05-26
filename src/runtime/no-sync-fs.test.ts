import { describe, it, expect } from "vitest";
import { scanForSyncFs } from "../testing/noSyncFsScanner.js";

describe("src/runtime is sync-fs-free", () => {
  it("has no node:fs sync primitives or disallowed named imports", async () => {
    const violations = await scanForSyncFs({
      roots: ["src/runtime"],
      skipPathContains: [".test.ts", ".d.ts", "recovery.ts", "runtime-lock.ts"],
    });
    expect(violations).toEqual([]);
  });
});
