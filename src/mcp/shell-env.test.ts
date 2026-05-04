import { describe, it, expect } from "vitest";
import { filterShellEnv } from "./builtins.js";

describe("filterShellEnv", () => {
  it("strips well-known secret keys", () => {
    const filtered = filterShellEnv({
      HOME: "/home/agent",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "ak-secret",
      GITHUB_TOKEN: "ghp-secret",
      TELEGRAM_BOT_TOKEN: "tg-secret",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "wJal...",
      MY_DB_PASSWORD: "hunter2",
      SAIVAGE_API_TOKEN: "saivage-secret",
      SOME_SECRET_VALUE: "x",
    });

    expect(filtered.HOME).toBe("/home/agent");
    expect(filtered.PATH).toBe("/usr/bin");
    expect(filtered.OPENAI_API_KEY).toBeUndefined();
    expect(filtered.ANTHROPIC_API_KEY).toBeUndefined();
    expect(filtered.GITHUB_TOKEN).toBeUndefined();
    expect(filtered.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(filtered.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(filtered.MY_DB_PASSWORD).toBeUndefined();
    expect(filtered.SAIVAGE_API_TOKEN).toBeUndefined();
    expect(filtered.SOME_SECRET_VALUE).toBeUndefined();
  });

  it("drops keys whose value is undefined", () => {
    const filtered = filterShellEnv({ A: "1", B: undefined });
    expect(filtered.A).toBe("1");
    expect("B" in filtered).toBe(false);
  });
});
