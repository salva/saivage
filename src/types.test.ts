import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "./types.js";

const baseFixture = () => ({
  project_name: "x",
  objectives: [],
  routing: { roles: {}, profiles: {} },
  skills: { max_per_agent: 5 },
});

describe("ProjectConfigSchema", () => {
  it("accepts an otherwise-valid config with no legacy key", () => {
    expect(ProjectConfigSchema.safeParse(baseFixture()).success).toBe(true);
  });

  it("rejects unknown top-level keys instead of silently stripping them", () => {
    const fixture = {
      ...baseFixture(),
      notifications: { channel: "alerts" },
      provider: { name: "example" },
    };
    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain("Unrecognized key");
  });
});
