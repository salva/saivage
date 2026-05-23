/**
 * Saivage — Project initializer
 * Initialize/discover .saivage/ directory, load config, resolve paths.
 */

import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { readDoc, writeDoc, ensureDir } from "./documents.js";
import {
  ProjectConfigSchema,
  type ProjectConfig,
} from "../types.js";

/** Subscopes under skills/ and memory/ knowledge trees (design §B.4). */
const KNOWLEDGE_SUBSCOPES = ["project", "stages", "sessions"] as const;

/** Lines that must be present in `.saivage/.gitignore` after init. */
const GITIGNORE_LINES = ["tmp/", "skills/sessions/", "memory/sessions/"];

/** Resolved paths and loaded config for a project. */
export interface ProjectContext {
  /** Absolute path to the project root directory. */
  projectRoot: string;
  /** Absolute path to .saivage/ directory inside the project. */
  saivageDir: string;
  /** Loaded project config. */
  config: ProjectConfig;

  // Convenience resolved paths
  paths: {
    plan: string;
    planHistory: string;
    stages: string;
    notes: string;
    inspections: string;
    skills: string;
    memory: string;
    tools: string;
    research: string;
    tmp: string;
    runtimeState: string;
    shutdownRequest: string;
    shutdownSummary: string;
    chats: string;
    inspectorWorkspace: string;
    work: string;
  };
}

/** Discover the .saivage/ directory by walking up from startDir. */
export function discoverProject(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, ".saivage");
    if (existsSync(join(candidate, "config.json"))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

/** Load a ProjectContext given a project root path. */
export function loadProject(projectRoot: string): ProjectContext {
  const saivageDir = join(projectRoot, ".saivage");
  const configPath = join(saivageDir, "config.json");

  const config = readDoc(configPath, ProjectConfigSchema);

  const paths = {
    plan: join(saivageDir, "plan.json"),
    planHistory: join(saivageDir, "plan-history.json"),
    stages: join(saivageDir, "stages"),
    notes: join(saivageDir, "notes"),
    inspections: join(saivageDir, "inspections"),
    skills: join(saivageDir, "skills"),
    memory: join(saivageDir, "memory"),
    tools: join(saivageDir, "tools"),
    research: join(projectRoot, "research"),
    tmp: join(saivageDir, "tmp"),
    runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
    shutdownRequest: join(saivageDir, "tmp", "state", "shutdown-request.json"),
    shutdownSummary: join(saivageDir, "tmp", "state", "shutdown-summary.json"),
    chats: join(saivageDir, "tmp", "chats"),
    inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
    work: join(saivageDir, "tmp", "work"),
  };

  return { projectRoot, saivageDir, config, paths };
}

/**
 * Initialize a new .saivage/ directory structure for a project.
 * Creates all necessary subdirectories and a default config file.
 */
export function initProject(
  projectRoot: string,
  config: ProjectConfig,
): ProjectContext {
  const saivageDir = join(projectRoot, ".saivage");
  const configPath = join(saivageDir, "config.json");

  if (existsSync(configPath)) {
    throw new Error(
      `Project already initialized at ${saivageDir}`,
    );
  }

  // Create directory structure
  ensureDir(saivageDir);
  ensureDir(join(saivageDir, "stages"));
  ensureDir(join(saivageDir, "notes"));
  ensureDir(join(saivageDir, "inspections"));
  ensureDir(join(saivageDir, "tools", "inspector"));
  ensureDir(join(saivageDir, "tmp", "state"));
  ensureDir(join(saivageDir, "tmp", "chats"));
  ensureDir(join(saivageDir, "tmp", "inspector-workspace"));
  ensureDir(join(saivageDir, "tmp", "work"));

  // Write project config
  writeDoc(configPath, config, ProjectConfigSchema);

  // Seed knowledge trees (skills + memory) and .gitignore lines.
  initProjectTree(projectRoot);

  return loadProject(projectRoot);
}

/**
 * Ensure the `.saivage/{skills,memory}/{project,stages,sessions}/` tree
 * exists with seeded empty `index.json` and empty `audit.jsonl` files,
 * and that `.saivage/.gitignore` contains the lines required by FR-21.
 *
 * Idempotent: running on an already-initialized tree is a no-op (no
 * file is overwritten if it already exists).
 *
 * Called from {@link initProject} during fresh init, and safe to call
 * independently to upgrade a partially-initialized tree.
 */
export function initProjectTree(projectRoot: string): void {
  const saivageDir = join(projectRoot, ".saivage");
  ensureDir(saivageDir);

  for (const kind of ["skills", "memory"] as const) {
    for (const sub of KNOWLEDGE_SUBSCOPES) {
      ensureDir(join(saivageDir, kind, sub));
    }
    // Seed empty project-scope index + audit. Stage and session scopes
    // are created on demand by their respective lifecycle events.
    const indexPath = join(saivageDir, kind, "project", "index.json");
    if (!existsSync(indexPath)) {
      const initial =
        kind === "skills" ? { skills: [] } : { memories: [], topic_map: {} };
      writeFileSync(indexPath, JSON.stringify(initial, null, 2), "utf-8");
    }
    const auditPath = join(saivageDir, kind, "project", "audit.jsonl");
    if (!existsSync(auditPath)) writeFileSync(auditPath, "", "utf-8");
  }

  // Idempotent .gitignore update. We only append missing lines, preserving
  // any pre-existing entries (e.g. user customizations).
  const gitignorePath = join(saivageDir, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf-8")
    : "";
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const missing = GITIGNORE_LINES.filter((line) => !have.has(line));
  if (missing.length > 0) {
    const trailing = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, existing + trailing + missing.join("\n") + "\n", "utf-8");
  }
}
