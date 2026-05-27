import { describe, it, expect } from "vitest";
import { shouldSkipPath, scanChunk } from "./secrets.js";

describe("shouldSkipPath", () => {
  it.each([
    "project/.saivage/auth-profiles.json",
    "project/.saivage/auth-profiles.openrouter.json",
    "src/keys/server.pem",
    "etc/ssl/private/key.pem",
    "config/host.key",
    ".ssh/id_rsa",
    ".ssh/id_rsa.pub",
    "home/u/.ssh/config",
    "home/u/.aws/credentials",
    "home/u/.netrc",
    ".env",
    ".env.local",
    "project/secrets/api-token.txt",
  ])("skips %s", (p) => {
    expect(shouldSkipPath(p)).toBe(true);
  });

  it.each([
    "src/index.ts",
    "docs/.env-example.md",
    "envoy/config.yaml",
    ".saivage/saivage.json",
    ".saivage/plan.json",
  ])("permits %s", (p) => {
    expect(shouldSkipPath(p)).toBe(false);
  });

  it("normalises windows separators", () => {
    expect(shouldSkipPath("C:\\Users\\me\\.ssh\\id_rsa")).toBe(true);
  });

  it("rejects empty / non-string", () => {
    expect(shouldSkipPath("")).toBe(false);
    // @ts-expect-error — defensive
    expect(shouldSkipPath(null)).toBe(false);
  });
});

describe("scanChunk", () => {
  it("flags OpenAI-shaped keys", () => {
    expect(scanChunk("the token is sk-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII")).toBe(true);
  });

  it("flags Anthropic-shaped keys", () => {
    expect(scanChunk("ANTHROPIC=sk-ant-AAAABBBBCCCCDDDDEEEEFFFFGGGG")).toBe(true);
  });

  it("flags Slack tokens", () => {
    expect(scanChunk("config: xoxb-1234567890-1234567890")).toBe(true);
  });

  it("flags AWS Access Key IDs", () => {
    expect(scanChunk("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("flags AWS secret access keys", () => {
    expect(
      scanChunk('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'),
    ).toBe(true);
  });

  it("flags PEM private-key blocks", () => {
    expect(scanChunk("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe(true);
  });

  it("passes ordinary prose unchanged", () => {
    expect(scanChunk("This is an ordinary paragraph about widgets.")).toBe(false);
  });

  it("rejects empty / non-string", () => {
    expect(scanChunk("")).toBe(false);
    // @ts-expect-error — defensive
    expect(scanChunk(null)).toBe(false);
  });
});
