import { describe, it, expect } from "vitest";
import { sep } from "node:path";
import { scanForSyncFs } from "./testing/noSyncFsScanner.js";

describe("src/config.ts is async-fs only", () => {
  it("permits only the existsSync carve-out in resolveProjectRoot", async () => {
    const all = await scanForSyncFs({
      roots: ["src"],
      // Default allow-list ["createWriteStream"] (G30). existsSync
      // is NOT broadened workspace-wide; it is narrowed to
      // src/config.ts via the post-filter below.
    });
    const configViolations = all
      .filter(
        (v) =>
          v.file === `src${sep}config.ts` ||
          v.file.endsWith(`${sep}src${sep}config.ts`),
      )
      // Stable order so the assertion is independent of the
      // scanner's traversal order between the named import and
      // the call site.
      .map((v) => ({ kind: v.kind, detail: v.detail }))
      .sort((a, b) =>
        a.kind === b.kind
          ? a.detail.localeCompare(b.detail)
          : a.kind.localeCompare(b.kind),
      );

    // The G30 scanner emits both kinds for the existsSync carve-out:
    //   - disallowed-named-import from `import { existsSync } from "node:fs"`
    //     at src/config.ts L2 (existsSync is not in the default
    //     allow-list).
    //   - sync-call from the call inside resolveProjectRoot at L208.
    // Any new sync-fs surface in src/config.ts adds a third entry
    // and fails this assertion.
    expect(configViolations).toEqual([
      { kind: "disallowed-named-import", detail: "existsSync" },
      { kind: "sync-call", detail: "existsSync" },
    ]);
  });
});
