/**
 * Saivage — Project initializer
 * Initialize/discover .saivage/ directory, load config, resolve paths.
 */

import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { readDoc, writeDoc, ensureDir, pathExists } from "./documents.js";
import { SaivageConfigSchema } from "../config.js";
import {
  ProjectConfigSchema,
  type ProjectConfig,
} from "../types.js";

/** Lines that must be present in `.saivage/.gitignore` after init. */
const GITIGNORE_LINES = ["tmp/"];

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
    stages: string;
    notes: string;
    inspections: string;
    tools: string;
    research: string;
    tmp: string;
    runtimeState: string;
    shutdownRequest: string;
    shutdownSummary: string;
    chats: string;
    inspectorWorkspace: string;
    work: string;
    telegramSubscriptions: string;
  };
}

/** Discover the .saivage/ directory by walking up from startDir. */
export async function discoverProject(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, ".saivage");
    if (await pathExists(join(candidate, "config.json"))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) return null; // hit filesystem root
    dir = parent;
  }
}

/** Load a ProjectContext given a project root path. */
export async function loadProject(projectRoot: string): Promise<ProjectContext> {
  const saivageDir = join(projectRoot, ".saivage");
  const configPath = join(saivageDir, "config.json");

  const config = await readDoc(configPath, ProjectConfigSchema);

  const paths = {
    plan: join(saivageDir, "plan.json"),
    stages: join(saivageDir, "stages"),
    notes: join(saivageDir, "notes"),
    inspections: join(saivageDir, "inspections"),
    tools: join(saivageDir, "tools"),
    research: join(projectRoot, "research"),
    tmp: join(saivageDir, "tmp"),
    runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
    shutdownRequest: join(saivageDir, "tmp", "state", "shutdown-request.json"),
    shutdownSummary: join(saivageDir, "tmp", "state", "shutdown-summary.json"),
    chats: join(saivageDir, "tmp", "chats"),
    inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
    work: join(saivageDir, "tmp", "work"),
    telegramSubscriptions: join(saivageDir, "telegram-subscriptions.json"),
  };

  return { projectRoot, saivageDir, config, paths };
}

/**
 * Seed a new `.saivage/` directory structure for a project. Writes the
 * canonical `config.json` (project-level) and `saivage.json` (runtime-level),
 * seeds the knowledge tree, and returns a `ProjectContext`.
 *
 * Fails if either `config.json` or `saivage.json` already exists.
 */
export async function seedProject(
  projectRoot: string,
  opts: { name?: string; objectives?: string[] } = {},
): Promise<ProjectContext> {
  const saivageDir = join(projectRoot, ".saivage");
  const configPath = join(saivageDir, "config.json");
  const saivageJsonPath = join(saivageDir, "saivage.json");

  if ((await pathExists(configPath)) || (await pathExists(saivageJsonPath))) {
    throw new Error(`Project already initialized at ${saivageDir}`);
  }

  // Create directory structure
  await ensureDir(saivageDir);
  await ensureDir(join(saivageDir, "stages"));
  await ensureDir(join(saivageDir, "notes"));
  await ensureDir(join(saivageDir, "inspections"));
  await ensureDir(join(saivageDir, "tools", "inspector"));
  await ensureDir(join(saivageDir, "tmp", "state"));
  await ensureDir(join(saivageDir, "tmp", "chats"));
  await ensureDir(join(saivageDir, "tmp", "inspector-workspace"));
  await ensureDir(join(saivageDir, "tmp", "work"));

  // Write project config (post-F33 shape)
  const config: ProjectConfig = {
    project_name: opts.name ?? "my-project",
    objectives: opts.objectives ?? [],
    routing: { roles: {}, profiles: {} },
    skills: { max_per_agent: 5 },
  };
  await writeDoc(configPath, config, ProjectConfigSchema);

  // Write canonical runtime config (saivage.json)
  const saivageJson = SaivageConfigSchema.parse({});
  await writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema);

  // Seed knowledge trees (skills + memory) and .gitignore lines.
  await initProjectTree(projectRoot);

  return loadProject(projectRoot);
}

/**
 * Ensure the `.saivage/.gitignore` contains the lines required by FR-21.
 *
 * Pre-F01 this also seeded `.saivage/{skills,memory}/{project,stages,sessions}/`
 * trees with empty `index.json` + `audit.jsonl` files. F01 B07 cut that over
 * to the SQLite sidecar at `.saivage/knowledge/store.sqlite`, which is
 * created on demand by `openSidecar` during knowledge boot.
 *
 * Idempotent: only appends missing `.gitignore` lines.
 *
 * Called from {@link seedProject} during fresh init, and safe to call
 * independently to upgrade a partially-initialized tree.
 */
export async function initProjectTree(projectRoot: string): Promise<void> {
  const saivageDir = join(projectRoot, ".saivage");
  await ensureDir(saivageDir);

  // Idempotent .gitignore update. We only append missing lines, preserving
  // any pre-existing entries (e.g. user customizations).
  const gitignorePath = join(saivageDir, ".gitignore");
  const existing = (await pathExists(gitignorePath))
    ? await readFile(gitignorePath, "utf-8")
    : "";
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const missing = GITIGNORE_LINES.filter((line) => !have.has(line));
  if (missing.length > 0) {
    const trailing = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await writeFile(gitignorePath, existing + trailing + missing.join("\n") + "\n", "utf-8");
  }
}
