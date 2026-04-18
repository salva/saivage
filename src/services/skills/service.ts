#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

// Skill directories, in discovery order
const SAIVAGE_ROOT = process.env["SAIVAGE_ROOT"] ?? process.cwd();
const PROJECT_ROOT = process.env["PROJECT_ROOT"] ?? "";
const SKILLS_DIRS = [
  join(SAIVAGE_ROOT, "skills"), // Built-in
  join(homedir(), ".saivage", "skills"), // User global
  ...(PROJECT_ROOT ? [join(PROJECT_ROOT, ".saivage", "skills")] : []), // Workspace
];

interface SkillEntry {
  name: string;
  description: string;
  source: string;
  path: string;
  agentTypes?: string[];
  triggers?: string[];
}

function discoverAll(): SkillEntry[] {
  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const dir of SKILLS_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        const skillFile = join(dir, entry, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        if (seen.has(entry)) continue;
        seen.add(entry);

        const raw = readFileSync(skillFile, "utf-8");
        const meta = parseFrontmatter(raw);
        skills.push({
          name: meta.name ?? entry,
          description: meta.description ?? "",
          source: dir.includes("/.saivage/skills")
            ? dir.includes(PROJECT_ROOT) ? "workspace" : "user"
            : "builtin",
          path: skillFile,
          agentTypes: meta.agentTypes,
          triggers: meta.triggers,
        });
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return skills;
}

function parseFrontmatter(raw: string): Record<string, any> {
  if (!raw.startsWith("---")) return {};
  const endIdx = raw.indexOf("---", 3);
  if (endIdx === -1) return {};
  const fm = raw.slice(3, endIdx).trim();
  const meta: Record<string, any> = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (!key || value === undefined) continue;
    const arrMatch = value.match(/^\[(.+)\]$/);
    if (arrMatch) {
      meta[key] = arrMatch[1]!
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return meta;
}

const server = new McpServer({ name: "skills", version: "0.1.0" });

server.tool(
  "list_skills",
  "List all available skills with their descriptions, triggers, and agent types",
  {},
  async () => {
    const skills = discoverAll();
    const table = skills.map(
      (s) =>
        `- **${s.name}** (${s.source}): ${s.description}` +
        (s.agentTypes?.length ? ` [agents: ${s.agentTypes.join(", ")}]` : "") +
        (s.triggers?.length ? ` [triggers: ${s.triggers.join(", ")}]` : ""),
    );
    return {
      content: [
        {
          type: "text" as const,
          text: skills.length > 0
            ? `Found ${skills.length} skills:\n\n${table.join("\n")}`
            : "No skills found.",
        },
      ],
    };
  },
);

server.tool(
  "read_skill",
  "Read the full content of a skill file (SKILL.md)",
  {
    name: z.string().describe("Name of the skill to read"),
  },
  async ({ name }) => {
    const skills = discoverAll();
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      return {
        content: [{ type: "text" as const, text: `Skill "${name}" not found. Available: ${skills.map(s => s.name).join(", ")}` }],
        isError: true,
      };
    }
    const content = readFileSync(skill.path, "utf-8");
    return {
      content: [{ type: "text" as const, text: content }],
    };
  },
);

server.tool(
  "create_skill",
  "Create a new skill file. Skills teach agents how to perform specific tasks. The skill will be saved to the user's global skills directory (~/.saivage/skills/<name>/SKILL.md) or the workspace skills directory.",
  {
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe("Skill name (lowercase, hyphens only, e.g. 'api-testing')"),
    description: z.string().describe("One-line description of what this skill teaches"),
    content: z.string().describe("Full SKILL.md content INCLUDING frontmatter (--- delimited YAML block at the top). Must include name, description, and version in frontmatter. Should include triggers (regex patterns for auto-loading) and agentTypes (which agent types should use this skill)."),
    scope: z
      .enum(["user", "workspace"])
      .default("user")
      .describe("Where to save: 'user' (~/.saivage/skills/) or 'workspace' (project/.saivage/skills/)"),
  },
  async ({ name, description, content, scope }) => {
    const baseDir =
      scope === "workspace" && PROJECT_ROOT
        ? join(PROJECT_ROOT, ".saivage", "skills")
        : join(homedir(), ".saivage", "skills");

    const skillDir = join(baseDir, name);
    if (existsSync(join(skillDir, "SKILL.md"))) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Skill "${name}" already exists at ${skillDir}/SKILL.md. Use update_skill to modify it.`,
          },
        ],
        isError: true,
      };
    }

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");

    return {
      content: [
        {
          type: "text" as const,
          text: `Skill "${name}" created at ${skillDir}/SKILL.md\n\nDescription: ${description}\n\nThe skill will be automatically discovered and loaded for matching tasks.`,
        },
      ],
    };
  },
);

server.tool(
  "update_skill",
  "Update an existing skill file with new content. Use this to improve skills based on experience.",
  {
    name: z.string().describe("Name of the skill to update"),
    content: z.string().describe("New full SKILL.md content (including frontmatter)"),
    reason: z.string().describe("Brief explanation of why the skill is being updated"),
  },
  async ({ name, content, reason }) => {
    const skills = discoverAll();
    const skill = skills.find((s) => s.name === name);

    if (!skill) {
      return {
        content: [{ type: "text" as const, text: `Skill "${name}" not found.` }],
        isError: true,
      };
    }

    // Don't allow modifying built-in skills directly
    if (skill.source === "builtin") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Cannot modify built-in skill "${name}". Create a user or workspace skill with the same name to override it.`,
          },
        ],
        isError: true,
      };
    }

    // Back up old version
    const oldContent = readFileSync(skill.path, "utf-8");
    const backupDir = join(dirname(skill.path), ".versions");
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(backupDir, `${timestamp}.md`), oldContent, "utf-8");

    // Write new content
    writeFileSync(skill.path, content, "utf-8");

    return {
      content: [
        {
          type: "text" as const,
          text: `Skill "${name}" updated. Previous version backed up.\nReason: ${reason}`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
