/**
 * Saivage — F27: OAuth client id resolution via config.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import {
  DEFAULT_ANTHROPIC_CLIENT_ID,
  DEFAULT_OPENAI_CODEX_CLIENT_ID,
  DEFAULT_GITHUB_COPILOT_CLIENT_ID,
} from "./defaults.js";

function makeProject(jsonBody?: object): string {
  const root = mkdtempSync(join(tmpdir(), "saivage-oauth-"));
  mkdirSync(join(root, ".saivage"), { recursive: true });
  if (jsonBody !== undefined) {
    writeFileSync(
      join(root, ".saivage", "saivage.json"),
      JSON.stringify(jsonBody, null, 2),
      "utf8",
    );
  }
  return root;
}

let createdRoot: string | null = null;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv["ANTHROPIC_OAUTH_CLIENT_ID"] = process.env["ANTHROPIC_OAUTH_CLIENT_ID"];
});

afterEach(() => {
  if (createdRoot) {
    rmSync(createdRoot, { recursive: true, force: true });
    createdRoot = null;
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("OAuth client id defaults", () => {
  it("resolves to the shipped defaults when no oauth block is configured", async () => {
    createdRoot = makeProject({});
    const cfg = await loadConfig(createdRoot);
    expect(cfg.oauth.anthropic.clientId).toBe(DEFAULT_ANTHROPIC_CLIENT_ID);
    expect(cfg.oauth.openaiCodex.clientId).toBe(DEFAULT_OPENAI_CODEX_CLIENT_ID);
    expect(cfg.oauth.githubCopilot.clientId).toBe(DEFAULT_GITHUB_COPILOT_CLIENT_ID);
  });

  it("honours an explicit override from saivage.json", async () => {
    createdRoot = makeProject({
      oauth: { anthropic: { clientId: "override-abc" } },
    });
    const cfg = await loadConfig(createdRoot);
    expect(cfg.oauth.anthropic.clientId).toBe("override-abc");
    // Other providers still default.
    expect(cfg.oauth.openaiCodex.clientId).toBe(DEFAULT_OPENAI_CODEX_CLIENT_ID);
  });

  it("interpolates env-var references in the override", async () => {
    process.env["ANTHROPIC_OAUTH_CLIENT_ID"] = "from-env";
    createdRoot = makeProject({
      oauth: { anthropic: { clientId: "${ANTHROPIC_OAUTH_CLIENT_ID}" } },
    });
    const cfg = await loadConfig(createdRoot);
    expect(cfg.oauth.anthropic.clientId).toBe("from-env");
  });
});
