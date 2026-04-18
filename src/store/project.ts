/**
 * Saivage — Project initializer
 * Initialize/discover .saivage/ directory, load config, resolve paths.
 */

import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { readDoc, writeDoc, ensureDir } from "./documents.js";
import {
  ProjectConfigSchema,
  type ProjectConfig,
} from "../types.js";

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
    tools: string;
    research: string;
    tmp: string;
    runtimeState: string;
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
    tools: join(saivageDir, "tools"),
    research: join(projectRoot, "research"),
    tmp: join(saivageDir, "tmp"),
    runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
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
  ensureDir(join(saivageDir, "skills"));
  ensureDir(join(saivageDir, "tools", "inspector"));
  ensureDir(join(saivageDir, "tmp", "state"));
  ensureDir(join(saivageDir, "tmp", "chats"));
  ensureDir(join(saivageDir, "tmp", "inspector-workspace"));
  ensureDir(join(saivageDir, "tmp", "work"));

  // Write project config
  writeDoc(configPath, config, ProjectConfigSchema);

  // Create .gitignore for tmp/
  const gitignorePath = join(saivageDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "tmp/\n", "utf-8");
  }

  return loadProject(projectRoot);
}
