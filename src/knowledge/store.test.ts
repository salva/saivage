/**
 * Saivage — knowledge store guards (post-F01 B04).
 *
 * The legacy JSON-tree write primitives (writeRecordAtomic, appendAuditEntry,
 * rebuildIndex, readAuditLines, unlinkRecordIfExists, assertScopePathCoherence)
 * are gone; only the pure write-time guards remain. Lifecycle behaviour is
 * covered by lifecycle.archive.test.ts, concurrency.test.ts, and integration.
 */

import { describe, expect, it } from "vitest";
import {
  KnowledgeStoreError,
  assertNoSecrets,
  assertNotBlockedPath,
  assertReason,
  detectSecrets,
} from "./store.js";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail("expected KnowledgeStoreError with code " + code + ", but no error was thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(KnowledgeStoreError);
    expect((err as KnowledgeStoreError).code).toBe(code);
  }
}

describe("KnowledgeStoreError taxonomy", () => {
  it("attaches code, message, and optional details", () => {
    const err = new KnowledgeStoreError("EMPTY_REASON", "missing", { x: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("KnowledgeStoreError");
    expect(err.code).toBe("EMPTY_REASON");
    expect(err.message).toBe("missing");
    expect(err.details).toEqual({ x: 1 });
  });
});

describe("assertReason", () => {
  it("accepts a non-empty reason", () => {
    expect(assertReason("clarify acceptance criteria")).toBe("clarify acceptance criteria");
  });

  it("rejects undefined / non-string", () => {
    expectCode(() => assertReason(undefined), "EMPTY_REASON");
    expectCode(() => assertReason(123 as unknown), "EMPTY_REASON");
  });

  it("rejects whitespace-only reason", () => {
    expectCode(() => assertReason("   "), "EMPTY_REASON");
  });
});

describe("detectSecrets / assertNoSecrets", () => {
  it("detects secrets across multiple fields", () => {
    const out = detectSecrets({
      body: "sk-" + "a".repeat(48),
      keys: "harmless",
    });
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.redacted.body).toContain("[REDACTED");
  });

  it("returns empty matches for clean content", () => {
    const out = detectSecrets({ body: "all good", note: "no secret" });
    expect(out.matches).toEqual([]);
    expect(out.redacted).toEqual({});
  });

  it("assertNoSecrets passes for clean fields", () => {
    expect(() => assertNoSecrets({ body: "all good" })).not.toThrow();
  });

  it("assertNoSecrets throws SECRET_DETECTED on a match", () => {
    expectCode(
      () => assertNoSecrets({ body: "sk-" + "a".repeat(48) }),
      "SECRET_DETECTED",
    );
  });
});

describe("assertNotBlockedPath", () => {
  it("passes for empty or undefined path", () => {
    expect(() => assertNotBlockedPath(undefined)).not.toThrow();
    expect(() => assertNotBlockedPath("")).not.toThrow();
  });

  it("passes for a non-blocked path", () => {
    expect(() => assertNotBlockedPath("records/skill.md")).not.toThrow();
  });

  it("throws BLOCKED_PATH for an auth-profiles path", () => {
    expectCode(
      () => assertNotBlockedPath(".saivage/auth-profiles.json"),
      "BLOCKED_PATH",
    );
  });
});
