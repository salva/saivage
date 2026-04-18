import { describe, it, expect } from "vitest";
import { discoverSkills, loadSkillFile } from "./loader.js";
import { resolveSkills, formatSkillsForPrompt } from "./resolver.js";
import { join } from "node:path";

// Project root for built-in skills
const PROJECT_ROOT = join(import.meta.dirname, "../..");

describe("skill loader", () => {
  it("discovers built-in skills", () => {
    const skills = discoverSkills(PROJECT_ROOT);
    expect(skills.length).toBeGreaterThanOrEqual(4);

    const names = skills.map((s) => s.metadata.name);
    expect(names).toContain("coding");
    expect(names).toContain("mcp-authoring");
    expect(names).toContain("research");
    expect(names).toContain("planning");
  });

  it("parses frontmatter correctly", () => {
    const skills = discoverSkills(PROJECT_ROOT);
    const coding = skills.find((s) => s.metadata.name === "coding");

    expect(coding).toBeDefined();
    expect(coding!.metadata.agentTypes).toContain("coder");
    expect(coding!.metadata.triggers).toContain("write");
    expect(coding!.content).toContain("Coding Guidelines");
  });

  it("resolves dependencies", () => {
    const skills = discoverSkills(PROJECT_ROOT);
    const mcpSkill = skills.find((s) => s.metadata.name === "mcp-authoring");

    expect(mcpSkill).toBeDefined();
    expect(mcpSkill!.metadata.dependencies).toContain("coding");
  });
});

describe("skill resolver", () => {
  it("resolves explicit skills", () => {
    const allSkills = discoverSkills(PROJECT_ROOT);
    const resolved = resolveSkills({
      allSkills,
      explicit: ["research"],
    });

    expect(resolved.map((s) => s.metadata.name)).toContain("research");
  });

  it("resolves by agent type", () => {
    const allSkills = discoverSkills(PROJECT_ROOT);
    const resolved = resolveSkills({
      allSkills,
      agentType: "coder",
    });

    const names = resolved.map((s) => s.metadata.name);
    expect(names).toContain("coding");
    expect(names).toContain("mcp-authoring");
  });

  it("resolves by trigger matching", () => {
    const allSkills = discoverSkills(PROJECT_ROOT);
    const resolved = resolveSkills({
      allSkills,
      goalText: "research the best database for this project",
    });

    const names = resolved.map((s) => s.metadata.name);
    expect(names).toContain("research");
  });

  it("resolves dependencies transitively", () => {
    const allSkills = discoverSkills(PROJECT_ROOT);
    const resolved = resolveSkills({
      allSkills,
      explicit: ["mcp-authoring"],
      budget: 100_000,
    });

    const names = resolved.map((s) => s.metadata.name);
    expect(names).toContain("mcp-authoring");
    expect(names).toContain("coding"); // dependency of mcp-authoring
  });

  it("formatSkillsForPrompt produces XML blocks", () => {
    const allSkills = discoverSkills(PROJECT_ROOT);
    const resolved = resolveSkills({ allSkills, explicit: ["coding"] });
    const prompt = formatSkillsForPrompt(resolved);

    expect(prompt).toContain('<skill name="coding">');
    expect(prompt).toContain("</skill>");
    expect(prompt).toContain("Coding Guidelines");
  });
});
