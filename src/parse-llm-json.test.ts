import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  extractJsonCandidates,
  parseLlmJson,
  parseLlmJsonAs,
} from "./parse-llm-json.js";

describe("extractJsonCandidates", () => {
  it("returns [] for empty input", () => {
    expect(extractJsonCandidates("")).toEqual([]);
  });

  it("returns [] for prose-only input with no braces", () => {
    expect(extractJsonCandidates("I am done. Nothing to report.")).toEqual([]);
  });

  it("includes the whole-trimmed candidate when input starts with {", () => {
    const out = extractJsonCandidates('{"ok":true}');
    expect(out[0]).toBe('{"ok":true}');
  });

  it("does NOT include the whole-trimmed candidate when input starts with prose", () => {
    const out = extractJsonCandidates('I am done. {"status":"completed"}');
    expect(out).toEqual(['{"status":"completed"}']);
  });

  it("includes fenced ```json block bodies", () => {
    const out = extractJsonCandidates(
      'Some prose.\n```json\n{"a":1}\n```\nMore prose.',
    );
    expect(out).toContain('{"a":1}');
  });

  it("includes balanced top-level brace spans found by depth scan", () => {
    const out = extractJsonCandidates('chatter {"k":{"inner":1}} tail');
    expect(out).toContain('{"k":{"inner":1}}');
  });

  it("does not split on braces inside string literals", () => {
    const text =
      '{"summary": "she said \\"hi}\\" then left", "status": "completed"}';
    const out = extractJsonCandidates(text);
    // exactly one balanced candidate (the whole object — and whole-trimmed)
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]).toBe(text);
  });

  it("preserves source order with fenced example before balanced object", () => {
    const text =
      'Example:\n```json\n{"example":true}\n```\nReport: {"status":"completed"}';
    const out = extractJsonCandidates(text);
    const exIdx = out.indexOf('{"example":true}');
    const repIdx = out.indexOf('{"status":"completed"}');
    expect(exIdx).toBeGreaterThanOrEqual(0);
    expect(repIdx).toBeGreaterThan(exIdx);
  });
});

describe("parseLlmJson", () => {
  it("picks the LAST parseable candidate", () => {
    const text =
      'Example:\n```json\n{"example":true}\n```\nReport: {"status":"completed"}';
    expect(parseLlmJson(text)).toEqual({ status: "completed" });
  });

  it("returns null for prose-only input", () => {
    expect(parseLlmJson("nothing here")).toBeNull();
  });

  it("returns null when candidates exist but none parse", () => {
    // unquoted key: JSON.parse fails
    expect(parseLlmJson("text {a: 1} more")).toBeNull();
  });
});

describe("parseLlmJsonAs", () => {
  const schema = z.object({ status: z.string() });

  it("success: valid JSON matching schema", () => {
    const r = parseLlmJsonAs('{"status":"completed"}', schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe("completed");
  });

  it("no_json: empty/prose input", () => {
    const r = parseLlmJsonAs("just prose", schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_json");
  });

  it("invalid_json: candidates exist but none parse", () => {
    const r = parseLlmJsonAs("text {a: 1} more", schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid_json");
      expect(r.raw).toContain("{a: 1}");
    }
  });

  it("schema_mismatch: parses but wrong shape", () => {
    const r = parseLlmJsonAs('{"status":42}', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_mismatch");
  });

  it("selection rule: later wrong-shape wins over earlier well-shape", () => {
    const text =
      'first: {"status":"completed"} second: {"status":42}';
    const r = parseLlmJsonAs(text, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_mismatch");
  });

  it("last balanced object wins: fenced example then real report", () => {
    const text =
      'Example:\n```json\n{"status":"example"}\n```\nReport: {"status":"completed"}';
    const r = parseLlmJsonAs(text, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe("completed");
  });
});
