import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { saveProfiles, loadProfiles } from "./store.js";

describe("auth profile store", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      const path = created.pop();
      if (path) rmSync(path, { recursive: true, force: true });
    }
    delete process.env["SAIVAGE_ROOT"];
  });

  it("writes auth-profiles.json with owner-only mode", () => {
    if (platform() === "win32") return; // POSIX modes only

    const projectRoot = mkdtempSync(join(tmpdir(), "saivage-authstore-"));
    created.push(projectRoot);
    process.env["SAIVAGE_ROOT"] = join(projectRoot, ".saivage");

    saveProfiles({
      version: 1,
      profiles: {
        "anthropic.main": {
          type: "oauth",
          provider: "anthropic",
          access: "secret",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    });

    const fp = join(process.env["SAIVAGE_ROOT"]!, "auth-profiles.json");
    const st = statSync(fp);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readFileSync(fp, "utf-8")).toContain("anthropic.main");

    const round = loadProfiles();
    expect(round.profiles["anthropic.main"]).toBeDefined();
  });
});
