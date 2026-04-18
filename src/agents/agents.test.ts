/**
 * Tests for Phase 3: LLM Integration (skills, conventions)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveSkills, formatSkillsForPrompt } from "../skills/loader.js";
import { checkConvention, getConvention } from "./conventions.js";
import { writeDoc, ensureDir } from "../store/documents.js";
import { SkillIndexSchema } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Skill Loader ────────────────────────────────────────────────────────────

describe("Skill Loader", () => {
  it("resolves skills matching keywords", () => {
    const skillsDir = join(tmpDir, "skills");
    ensureDir(skillsDir);

    // Write a skill file
    writeFileSync(join(skillsDir, "testing.md"), "# Testing Best Practices\nAlways test edge cases.", "utf-8");

    // Write index.json
    writeDoc(
      join(skillsDir, "index.json"),
      {
        skills: [
          {
            name: "testing",
            file: "testing.md",
            description: "Testing best practices",
            triggers: ["keyword:test", "keyword:jest", "tag:testing"],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            name: "deployment",
            file: "deploy.md",
            description: "Deployment guide",
            triggers: ["keyword:deploy", "tag:ops"],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      SkillIndexSchema,
    );

    // Write deploy.md too
    writeFileSync(join(skillsDir, "deploy.md"), "# Deploy Guide\nUse CI/CD.", "utf-8");

    const result = resolveSkills(
      {
        agentRole: "coder",
        description: "Write unit tests for the auth module",
        tags: ["testing"],
      },
      skillsDir,
      5,
    );

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].entry.name).toBe("testing");
    expect(result[0].matchScore).toBeGreaterThan(0);
  });

  it("filters by target_agents", () => {
    const skillsDir = join(tmpDir, "skills");
    ensureDir(skillsDir);

    writeFileSync(join(skillsDir, "coder-only.md"), "# Coder Only", "utf-8");

    writeDoc(
      join(skillsDir, "index.json"),
      {
        skills: [
          {
            name: "coder-only",
            file: "coder-only.md",
            description: "Only for coders",
            triggers: ["keyword:code"],
            target_agents: ["coder"],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      SkillIndexSchema,
    );

    // Should match for coder
    const coderResult = resolveSkills(
      { agentRole: "coder", description: "Write code" },
      skillsDir,
    );
    expect(coderResult).toHaveLength(1);

    // Should NOT match for researcher
    const researcherResult = resolveSkills(
      { agentRole: "researcher", description: "Write code" },
      skillsDir,
    );
    expect(researcherResult).toHaveLength(0);
  });

  it("respects max skill budget", () => {
    const skillsDir = join(tmpDir, "skills");
    ensureDir(skillsDir);

    const skills = Array.from({ length: 10 }, (_, i) => ({
      name: `skill-${i}`,
      file: `skill-${i}.md`,
      description: `Skill ${i}`,
      triggers: ["keyword:test"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    for (const s of skills) {
      writeFileSync(join(skillsDir, s.file), `# ${s.name}`, "utf-8");
    }

    writeDoc(join(skillsDir, "index.json"), { skills }, SkillIndexSchema);

    const result = resolveSkills(
      { agentRole: "coder", description: "test something" },
      skillsDir,
      3,
    );
    expect(result).toHaveLength(3);
  });

  it("formatSkillsForPrompt formats correctly", () => {
    const formatted = formatSkillsForPrompt([
      {
        entry: {
          name: "testing",
          file: "testing.md",
          description: "Test",
          triggers: [],
          created_at: "",
          updated_at: "",
        },
        content: "# Testing\nTest things.",
        matchScore: 1,
      },
    ]);

    expect(formatted).toContain("--- SKILL: testing ---");
    expect(formatted).toContain("# Testing");
  });

  it("formatSkillsForPrompt returns empty string for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });
});

// ─── Conventions ─────────────────────────────────────────────────────────────

describe("Conventions", () => {
  it("detects coder writing to research/", () => {
    const warning = checkConvention("coder", "research/findings.md");
    expect(warning).not.toBeNull();
    expect(warning).toContain("Convention violation");
  });

  it("allows coder writing to src/", () => {
    const warning = checkConvention("coder", "src/main.ts");
    expect(warning).toBeNull();
  });

  it("detects researcher writing to src/", () => {
    const warning = checkConvention("researcher", "src/main.ts");
    expect(warning).not.toBeNull();
  });

  it("allows researcher writing to research/", () => {
    const warning = checkConvention("researcher", "research/notes.md");
    expect(warning).toBeNull();
  });

  it("no convention for unknown role returns null", () => {
    // Chat has conventions, but agents without excluded territories pass
    const warning = checkConvention(
      "chat",
      ".saivage/notes/note-1.json",
    );
    expect(warning).toBeNull();
  });

  it("getConvention returns rule for known role", () => {
    const rule = getConvention("coder");
    expect(rule).not.toBeNull();
    expect(rule!.writeTerritory).toContain("src/");
  });
});
