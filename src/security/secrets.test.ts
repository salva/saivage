/**
 * NOTE: fixtures use synthetic, non-functional placeholders that match
 * the shape but are not real secrets.
 */
import { describe, expect, it } from "vitest";
import { isBlockedPath, redact, scanForSecrets } from "./secrets.js";

const SYNTHETIC = {
  openai: "sk-" + "A".repeat(40),
  github: "ghp_" + "B".repeat(36),
  google: "ya29." + "C".repeat(60),
  aws: "AKIA" + "0123456789ABCDEF",
  jwt: "eyJABCDEFGH.eyJABCDEFGH.signaturePART1234",
  highEntropyValue: "Xy7!aZ9#bQ3@cP5$dM2%eN4^fR8&gT6*",
};

describe("scanForSecrets", () => {
  it("returns no matches for plain prose", () => {
    expect(scanForSecrets("This is just a sentence with no secrets.").matches).toEqual([]);
  });

  it.each([
    ["openai_key", SYNTHETIC.openai],
    ["github_token", SYNTHETIC.github],
    ["google_oauth", SYNTHETIC.google],
    ["aws_access_key_id", SYNTHETIC.aws],
    ["jwt", SYNTHETIC.jwt],
  ])("detects %s", (kind, sample) => {
    const r = scanForSecrets(`leading ${sample} trailing`);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].kind).toBe(kind);
  });

  it("detects multiple distinct provider matches in same text", () => {
    const r = scanForSecrets(`${SYNTHETIC.openai} and ${SYNTHETIC.aws}`);
    expect(r.matches.length).toBeGreaterThanOrEqual(2);
  });

  it("detects literal markers (auth-profiles, PEM, aws_secret marker)", () => {
    const text =
      "see auth-profiles.json file; also -----BEGIN OPENSSH PRIVATE KEY----- and aws_secret_access_key=...";
    const r = scanForSecrets(text);
    const kinds = new Set(r.matches.map((m) => m.kind));
    expect(kinds.has("auth_profiles")).toBe(true);
    expect(kinds.has("private_key_pem")).toBe(true);
    expect(kinds.has("aws_secret_marker")).toBe(true);
  });

  it("detects high-entropy env assignment", () => {
    const r = scanForSecrets(`API_TOKEN=${SYNTHETIC.highEntropyValue}`);
    expect(r.matches.some((m) => m.kind === "env_assignment")).toBe(true);
  });

  it("ignores low-entropy env assignment (e.g. repeated chars)", () => {
    const r = scanForSecrets("API_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(r.matches.some((m) => m.kind === "env_assignment")).toBe(false);
  });

  it("does not flag harmless lowercase identifiers", () => {
    const r = scanForSecrets("function authenticateUser() { return true; }");
    expect(r.matches).toEqual([]);
  });

  it("returns empty for non-string input", () => {
    expect(scanForSecrets("", "body").matches).toEqual([]);
  });

  it("attributes field name", () => {
    const r = scanForSecrets(SYNTHETIC.openai, "topic.subject");
    expect(r.matches[0]?.field).toBe("topic.subject");
  });
});

describe("redact", () => {
  it("returns text unchanged when no matches", () => {
    const r = redact("hello world", []);
    expect(r.text).toBe("hello world");
    expect(r.redacted_spans).toBe(0);
  });

  it("replaces matched spans with [REDACTED]", () => {
    const text = `prefix ${SYNTHETIC.openai} mid ${SYNTHETIC.aws} suffix`;
    const scan = scanForSecrets(text);
    const { text: out, redacted_spans } = redact(text, scan.matches);
    expect(out).toBe("prefix [REDACTED] mid [REDACTED] suffix");
    expect(redacted_spans).toBe(2);
    expect(out.includes(SYNTHETIC.openai)).toBe(false);
    expect(out.includes(SYNTHETIC.aws)).toBe(false);
  });

  it("collapses overlapping matches", () => {
    const text = SYNTHETIC.openai;
    const overlap = [
      { field: "body", start: 0, end: 10, kind: "x" },
      { field: "body", start: 5, end: text.length, kind: "y" },
    ];
    const { text: out, redacted_spans } = redact(text, overlap);
    expect(out).toBe("[REDACTED]");
    expect(redacted_spans).toBe(1);
  });
});

describe("isBlockedPath", () => {
  it.each([
    ".saivage/auth-profiles.json",
    "/abs/.saivage/auth-profiles.json",
    "project/.saivage/openai-credentials.json",
    "project/.saivage/openrouter-provider-config.json",
    ".env",
    ".env.local",
    "/repo/.env",
    "secrets/.env.staging",
    "secrets/api-token.txt",
    "/home/user/.bash_history",
    "/home/user/.zsh_history",
  ])("blocks %s", (p) => {
    expect(isBlockedPath(p)).toBe(true);
  });

  it.each([
    "src/index.ts",
    ".saivage/saivage.json",
    ".saivage/plan.json",
    "docs/.env-example.md",
    "envoy/config.yaml",
  ])("permits %s", (p) => {
    expect(isBlockedPath(p)).toBe(false);
  });

  it("returns false for empty/non-string input", () => {
    expect(isBlockedPath("")).toBe(false);
    // @ts-expect-error — defensive guard
    expect(isBlockedPath(null)).toBe(false);
  });
});
