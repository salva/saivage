import { describe, it, expect } from "vitest";
import { scanForSyncFs } from "../testing/noSyncFsScanner.js";

describe("src/mcp/ stays off blocking fs", () => {
  it("has no node:fs sync imports or *Sync calls outside tests", async () => {
    const violations = await scanForSyncFs({
      roots: ["src/mcp"],
      allowedNamedImports: ["createWriteStream"],
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
