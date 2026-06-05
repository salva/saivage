import type { z } from "zod";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathExists } from "./store/documents.js";
import { SaivageConfigSchema } from "./config/schema/index.js";

// --- Schema ---

export { SaivageConfigSchema } from "./config/schema/index.js";

export type RagConfig = z.infer<typeof SaivageConfigSchema>["rag"];

export type SaivageConfig = z.infer<typeof SaivageConfigSchema>;

// --- Paths ---

export function resolveProjectRoot(startDir = process.cwd()): string {
  const envProjectRoot = process.env["PROJECT_ROOT"];
  if (envProjectRoot) return envProjectRoot;

  const envSaivageRoot = process.env["SAIVAGE_ROOT"];
  if (envSaivageRoot) return dirname(envSaivageRoot);

  let dir = startDir;
  while (true) {
    const saivage = join(dir, ".saivage");
    if (existsSync(join(saivage, "config.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export function saivageDir(projectRoot?: string): string {
  if (!projectRoot && process.env["SAIVAGE_ROOT"]) {
    return process.env["SAIVAGE_ROOT"];
  }
  return join(projectRoot ?? resolveProjectRoot(), ".saivage");
}

export function configPath(projectRoot?: string): string {
  return join(saivageDir(projectRoot), "saivage.json");
}

// --- Env var interpolation ---

function interpolateEnvVars(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    return process.env[name] ?? "";
  });
}

function deepInterpolate(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(deepInterpolate);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepInterpolate(v);
    }
    return result;
  }
  return obj;
}

// --- Expand ~ ---

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// --- Load ---

export async function loadConfig(projectRoot?: string): Promise<SaivageConfig> {
  const fp = configPath(projectRoot);
  let raw: unknown = {};
  if (await pathExists(fp)) {
    const text = await readFile(fp, "utf-8");
    raw = JSON.parse(text);
  }
  const interpolated = deepInterpolate(raw);
  return SaivageConfigSchema.parse(interpolated);
}
