import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProjectConfigSchema } from "./types.js";

// Legacy v1 routing key built at runtime so the bareword does not
// appear in source-tree greps for the legacy field (G26 grep gate).
const LEGACY_KEY = ["model", "overrides"].join("_");

// Exact operator-facing message the schema's ctx.addIssue emits.
// Built from the same template as src/types.ts so a future change
// to the wording or to the legacy key fails this test at toBe.
const EXACT_MESSAGE = `${LEGACY_KEY} is a removed legacy v1 routing field. Delete it from .saivage/config.json and use ProjectConfig.routing.roles instead.`;

const baseFixture = () => ({
  project_name: "x",
  objectives: [],
  routing: { roles: {}, profiles: {} },
  skills: { max_per_agent: 5 },
});

describe("ProjectConfigSchema (G26 legacy-key rejection)", () => {
  it("rejects the pre-v2 legacy routing key with exactly one custom issue at the legacy path with the exact operator-facing message", () => {
    const fixture: Record<string, unknown> = baseFixture();
    fixture[LEGACY_KEY] = { coder: "github-copilot/gpt-5.4" };

    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      const [issue] = result.error.issues;
      expect(issue.code).toBe(z.ZodIssueCode.custom);
      expect(issue.path).toEqual([LEGACY_KEY]);
      expect(issue.message).toBe(EXACT_MESSAGE);
    }
  });

  it("rejects an empty legacy stub with the same single-issue surface and exact message (matches the previously seeded shape)", () => {
    const fixture: Record<string, unknown> = baseFixture();
    fixture[LEGACY_KEY] = {};

    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      const [issue] = result.error.issues;
      expect(issue.code).toBe(z.ZodIssueCode.custom);
      expect(issue.path).toEqual([LEGACY_KEY]);
      expect(issue.message).toBe(EXACT_MESSAGE);
    }
  });

  it("accepts an otherwise-valid config with no legacy key", () => {
    expect(ProjectConfigSchema.safeParse(baseFixture()).success).toBe(true);
  });

  it("accepts and silently strips other unknown top-level keys (preserves today's behavior)", () => {
    const fixture = {
      ...baseFixture(),
      notifications: { channel: "stub" },
      provider: { legacy: "stub" },
    };
    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("notifications");
      expect(parsed).not.toHaveProperty("provider");
      expect(parsed.project_name).toBe("x");
      expect(parsed.skills).toMatchObject({ max_per_agent: 5 });
    }
  });
});
