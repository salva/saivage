import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { runtimeProviderConfigSchema } from "./routing/resolver.js";

// --- Schema ---

const notificationFiltersSchema = z.object({
  min_severity: z.enum(["info", "warning", "error"]).default("info"),
  categories: z
    .array(z.enum([
      "stage_completed",
      "stage_failed",
      "escalation",
      "task_failed",
      "inspector_complete",
      "plan_updated",
    ]))
    .default([]),
});

const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  disabled: z.boolean().default(false),
  autostart: z.boolean().default(true),
  transport: z.enum(["stdio", "sse"]).default("stdio"),
});

const configSchema = z.object({
  models: z
    .object({
      orchestrator: z.string().optional(),
      planner: z.string().optional(),
      manager: z.string().optional(),
      coder: z.string().optional(),
      researcher: z.string().optional(),
      data_agent: z.string().optional(),
      reviewer: z.string().optional(),
      inspector: z.string().optional(),
      executor: z.string().optional(),
      chat: z.string().optional(),
      default: z.string().optional(),
    })
    .default({ orchestrator: "anthropic/claude-sonnet-4-20250514" }),

  providers: z.record(z.string(), runtimeProviderConfigSchema).default({}),

  failover: z.record(z.string(), z.array(z.string())).default({}),

  modelEquivalents: z.record(z.string(), z.array(z.string())).default({}),

  server: z
    .object({
      port: z.number().default(8080),
      host: z.string().default("0.0.0.0"),
    })
    .default({}),

  agent: z
    .object({
      maxConcurrentAgents: z.number().default(3),
    })
    .default({}),

  runtime: z
    .object({
      maxServices: z.number().default(50),
      restartOnCrash: z.boolean().default(true),
      continuousImprovement: z.boolean().default(true),
      healthCheckIntervalMs: z.number().default(30_000),
      idleShutdownMs: z.number().default(300_000),
    })
    .default({}),

  security: z
    .object({
      injectionScanner: z.boolean().default(true),
      injectionModel: z.string().default("github-copilot/gpt-5.4"),
      maxScanLengthBytes: z.number().default(100_000),
    })
    .default({}),

  supervisor: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().default("github-copilot/gpt-5.4"),
      intervalMs: z.number().default(20 * 60 * 1000),
      consecutiveStuckVerdicts: z.number().default(3),
      logLines: z.number().default(400),
    })
    .default({}),

  telegram: z
    .object({
      botToken: z.string().default(""),
      allowedUserIds: z.array(z.number()).default([]),
    })
    .default({}),

  notifications: z
    .object({
      channels: z.array(z.enum(["telegram", "web"])).default(["web"]),
      filters: notificationFiltersSchema.default({}),
    })
    .default({}),

  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
});

export type SaivageConfig = z.infer<typeof configSchema>;

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

let cached: SaivageConfig | null = null;
let cachedConfigDir: string | null = null;

export function loadConfig(force = false, projectRoot?: string): SaivageConfig {
  const dir = saivageDir(projectRoot);
  if (cached && !force && cachedConfigDir === dir) return cached;

  const fp = configPath(projectRoot);

  let raw: unknown = {};
  if (existsSync(fp)) {
    const text = readFileSync(fp, "utf-8");
    raw = JSON.parse(text);
  }

  const interpolated = deepInterpolate(raw);
  cached = configSchema.parse(interpolated);
  cachedConfigDir = dir;
  return cached;
}

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function writeDefaultConfig(projectRoot?: string): void {
  const fp = configPath(projectRoot);
  if (existsSync(fp)) return;

  ensureDir(saivageDir(projectRoot));
  const defaultConfig = {
    models: {},
    providers: {
      anthropic: {},
      openai: {},
      ollama: { baseUrl: "http://localhost:11434" },
      llamacpp: { baseUrl: "http://localhost:8080" },
    },
    failover: {},
    modelEquivalents: {},
    server: { port: 8080, host: "0.0.0.0" },
    agent: { maxConcurrentAgents: 3 },
    notifications: {
      channels: ["web"],
      filters: { min_severity: "info", categories: [] },
    },
    mcpServers: {
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--headless"],
        env: { PLAYWRIGHT_BROWSERS_PATH: "${HOME}/.cache/ms-playwright" },
        disabled: false,
        autostart: true,
        transport: "stdio",
      },
    },
  };
  writeFileSync(fp, JSON.stringify(defaultConfig, null, 2) + "\n", "utf-8");
}
