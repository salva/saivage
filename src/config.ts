import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Schema ---

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

const configSchema = z.object({
  models: z
    .object({
      orchestrator: z.string().default("anthropic/claude-sonnet-4-20250514"),
      coder: z.string().default("anthropic/claude-sonnet-4-20250514"),
      researcher: z.string().default("openai/gpt-4o"),
      executor: z.string().default("anthropic/claude-haiku-3"),
      chat: z.string().default("anthropic/claude-sonnet-4-20250514"),
      default: z.string().default("anthropic/claude-sonnet-4-20250514"),
    })
    .default({}),

  providers: z.record(z.string(), providerConfigSchema).default({}),

  failover: z.record(z.string(), z.array(z.string())).default({}),

  server: z
    .object({
      port: z.number().default(7777),
      host: z.string().default("0.0.0.0"),
    })
    .default({}),

  agent: z
    .object({
      maxConcurrentAgents: z.number().default(3),
    })
    .default({}),

  generator: z
    .object({
      language: z.string().default("typescript"),
      testBeforeRegister: z.boolean().default(true),
      sandbox: z.boolean().default(true),
    })
    .default({}),

  runtime: z
    .object({
      maxServices: z.number().default(50),
      restartOnCrash: z.boolean().default(true),
      healthCheckIntervalMs: z.number().default(30_000),
      idleShutdownMs: z.number().default(300_000),
    })
    .default({}),

  versions: z
    .object({
      storagePath: z.string().default("~/.saivage/versions"),
      retainCount: z.number().default(5),
    })
    .default({}),

  sandbox: z
    .object({
      timeoutMs: z.number().default(120_000),
      secondaryInstancePort: z.number().default(7778),
    })
    .default({}),

  watchdog: z
    .object({
      enabled: z.boolean().default(true),
      healthCheckIntervalMs: z.number().default(5_000),
      restartTimeoutMs: z.number().default(60_000),
    })
    .default({}),

  autonomy: z
    .object({
      enabled: z.boolean().default(false),
      planningCooldownMs: z.number().default(60_000), // min 1 min between planning cycles
      maxTasksPerCycle: z.number().default(3),
      objectives: z.array(z.string()).default([]),
      planDocsPath: z.string().default(".saivage/planning"), // relative to project.root
      retrospectiveInterval: z.number().default(10), // run retrospective every N completed tasks
    })
    .default({}),

  project: z
    .object({
      root: z.string().default(""),
      venv: z.string().default(""),
      description: z.string().default(""),
    })
    .default({}),

  security: z
    .object({
      injectionScanner: z.boolean().default(true),
      maxScanLengthBytes: z.number().default(100_000),
    })
    .default({}),

  telegram: z
    .object({
      botToken: z.string().default(""),
      allowedUserIds: z.array(z.number()).default([]),
    })
    .default({}),

  telemetry: z
    .object({
      enabled: z.boolean().default(true),
      intervalMs: z.number().default(30_000),
    })
    .default({}),
});

export type SaivageConfig = z.infer<typeof configSchema>;

// --- Paths ---

export function saivageDir(): string {
  return join(homedir(), ".saivage");
}

export function configPath(): string {
  return join(saivageDir(), "saivage.json");
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

export function loadConfig(force = false): SaivageConfig {
  if (cached && !force) return cached;

  const dir = saivageDir();
  const fp = configPath();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let raw: unknown = {};
  if (existsSync(fp)) {
    const text = readFileSync(fp, "utf-8");
    raw = JSON.parse(text);
  }

  const interpolated = deepInterpolate(raw);
  cached = configSchema.parse(interpolated);
  return cached;
}

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function writeDefaultConfig(): void {
  const fp = configPath();
  if (existsSync(fp)) return;

  ensureDir(saivageDir());
  const defaultConfig = {
    models: {
      orchestrator: "anthropic/claude-sonnet-4-20250514",
      coder: "anthropic/claude-sonnet-4-20250514",
      researcher: "openai/gpt-4o",
      executor: "anthropic/claude-haiku-3",
      chat: "anthropic/claude-sonnet-4-20250514",
      default: "anthropic/claude-sonnet-4-20250514",
    },
    providers: {
      anthropic: {},
      openai: {},
      ollama: { baseUrl: "http://localhost:11434" },
      llamacpp: { baseUrl: "http://localhost:8080" },
    },
    failover: {},
    server: { port: 7777, host: "0.0.0.0" },
    agent: { maxConcurrentAgents: 3 },
  };
  writeFileSync(fp, JSON.stringify(defaultConfig, null, 2) + "\n", "utf-8");
}
