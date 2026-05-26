/**
 * NOTE: fixtures use synthetic, non-functional placeholders that match
 * the shape but are not real secrets.
 */
import { describe, expect, it } from "vitest";
import {
  isBlockedPath,
  redact,
  scanForSecrets,
  createSecretEnvNamePredicate,
  DEFAULT_CREDENTIAL_LEXEMES,
  DEFAULT_CONFIG_POINTER_SUFFIXES,
} from "./secrets.js";

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

const ENV_FALSE_POSITIVES: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "NODE_ENV",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "PROJECT_ROOT",
  "SAIVAGE_ROOT",
  "SAIVAGE_PROJECT_ID",
  "PYTHONPATH",
  "LD_LIBRARY_PATH",
  "TERM",
  "SHELL",
  "MY_SECRETARY",
  "STAGETOKENISER_PATH",
  "TOKENIZER",
  "TOKENIZER_CACHE_DIR",
  "PASSWORDLESS_MODE",
  "CREDENTIALSMITH_BIN",
  "RESET_PASSWORD_URL",
  "PASSWORD_RESET_ENDPOINT",
  "CREDENTIALS_FILE",
  "API_KEY_URL",
  "TOKEN_ISSUER_URL",
  "SECRET_STORE_PATH",
  "USER_PROFILE_URL",
  "PASSWORD_PROMPT",
  "API_KEY_PROMPT",
  "TOKEN_TEMPLATE",
  "GITHUB_API_BASE_URL",
  "GITHUB_API_BASE_URL_TEMPLATE",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "GH_USERNAME",
  "TELEGRAM_BOT_NAME",
];

const ENV_FALSE_NEGATIVES: ReadonlyArray<string> = [
  "API_KEY",
  "MY_API_KEY",
  "API_KEYS",
  "SOME_API-KEY",
  "ACCESS-KEY",
  "SOME-ACCESS-KEY",
  "TOKEN",
  "MY_TOKEN",
  "AUTH_TOKEN",
  "TOKENS",
  "SECRET",
  "MY_SECRET",
  "SECRETS",
  "PASSWORD",
  "DATABASE_PASSWORD",
  "PASSWORDS",
  "PASSWD",
  "USER_CREDENTIAL",
  "MY_CREDENTIALS",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "SLACK_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SAIVAGE_API_TOKEN",
];

describe("createSecretEnvNamePredicate — defaults / false positives", () => {
  const p = createSecretEnvNamePredicate({
    credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
    configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
  });
  it.each(ENV_FALSE_POSITIVES)("%s is not a secret name", (name) => {
    expect(p(name)).toBe(false);
  });
});

describe("createSecretEnvNamePredicate — defaults / false negatives", () => {
  const p = createSecretEnvNamePredicate({
    credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
    configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
  });
  it.each(ENV_FALSE_NEGATIVES)("%s is a secret name", (name) => {
    expect(p(name)).toBe(true);
  });
});

describe("createSecretEnvNamePredicate — operator overrides", () => {
  it("adds a project-specific credential lexeme (additive)", () => {
    const defaultPredicate = createSecretEnvNamePredicate({
      credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
      configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
    });
    expect(defaultPredicate("PII_DATA")).toBe(false);
    expect(defaultPredicate("MY_PII")).toBe(false);

    const extended = createSecretEnvNamePredicate({
      credentialLexemes: [...DEFAULT_CREDENTIAL_LEXEMES, "PII"],
      configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
    });
    expect(extended("PII_DATA")).toBe(true);
    expect(extended("MY_PII")).toBe(true);
    expect(extended("PII_URL")).toBe(false);
    expect(extended("ANTHROPIC_API_KEY")).toBe(true);
    expect(extended("RESET_PASSWORD_URL")).toBe(false);
  });

  it("replaces the lexeme list (full-replacement semantics)", () => {
    const replaced = createSecretEnvNamePredicate({
      credentialLexemes: ["PII"],
      configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
    });
    expect(replaced("PII_DATA")).toBe(true);
    expect(replaced("ANTHROPIC_API_KEY")).toBe(false);
    expect(replaced("OPENAI_API_KEY")).toBe(false);
    expect(replaced("GITHUB_TOKEN")).toBe(false);
    expect(replaced("DATABASE_PASSWORD")).toBe(false);
  });

  it("adds a project-specific config-pointer suffix (additive)", () => {
    const defaultPredicate = createSecretEnvNamePredicate({
      credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
      configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
    });
    expect(defaultPredicate("ARTIFACT_TOKEN_BUILDFILE")).toBe(true);

    const extended = createSecretEnvNamePredicate({
      credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
      configPointerSuffixes: [
        ...DEFAULT_CONFIG_POINTER_SUFFIXES,
        "_BUILDFILE",
      ],
    });
    expect(extended("ARTIFACT_TOKEN_BUILDFILE")).toBe(false);
    expect(extended("ARTIFACT_TOKEN")).toBe(true);
  });

  it("replaces the suffix list with an empty array (layer 2 off)", () => {
    const replaced = createSecretEnvNamePredicate({
      credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
      configPointerSuffixes: [],
    });
    expect(replaced("ANTHROPIC_API_KEY")).toBe(true);
    expect(replaced("RESET_PASSWORD_URL")).toBe(true);
    expect(replaced("PASSWORD_PROMPT")).toBe(true);
    expect(replaced("OPENAI_BASE_URL")).toBe(false);
    expect(replaced("PATH")).toBe(false);
  });

  it("empty lexeme list produces an always-false predicate", () => {
    const empty = createSecretEnvNamePredicate({
      credentialLexemes: [],
      configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
    });
    expect(empty("ANTHROPIC_API_KEY")).toBe(false);
  });
});
