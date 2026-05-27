import { z } from "zod";
import { existsSync } from "node:fs";          // resolveProjectRoot only
import { readFile } from "node:fs/promises";   // loadConfig only
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_ANTHROPIC_CLIENT_ID,
  DEFAULT_OPENAI_CODEX_CLIENT_ID,
  DEFAULT_GITHUB_COPILOT_CLIENT_ID,
} from "./auth/defaults.js";
import { pathExists } from "./store/documents.js";
import { WALL_CLOCK_HEADROOM_MS } from "./mcp/builtins.js";
import {
  DEFAULT_CREDENTIAL_LEXEMES,
  DEFAULT_CONFIG_POINTER_SUFFIXES,
} from "./security/secrets.js";

// --- Schema ---

const runtimeProviderAccountSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  authProfile: z.string().optional(),
  priority: z.number().default(100),
  models: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  quota: z
    .object({
      usedTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      remainingTokens: z.number().optional(),
      remainingRatio: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

const runtimeProviderConfigSchema = runtimeProviderAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), runtimeProviderAccountSchema).default({}),
  defaultContextWindow: z.number().optional(),
});

const modelAssignmentSchema = z.union([z.string(), z.array(z.string())]);

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

export const SaivageConfigSchema = z.object({
  models: z
    .object({
      orchestrator: modelAssignmentSchema.optional(),
      coder: modelAssignmentSchema.optional(),
      researcher: modelAssignmentSchema.optional(),
      data_agent: modelAssignmentSchema.optional(),
      reviewer: modelAssignmentSchema.optional(),
      designer: modelAssignmentSchema.optional(),
      critic: modelAssignmentSchema.optional(),
      chat: modelAssignmentSchema.optional(),
      default: modelAssignmentSchema.optional(),
    })
    .default({}),

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
      recoveryDelayMs: z.number().default(60_000),
      notes: z
        .object({
          volatileTtlMs: z.number().default(2 * 60 * 60 * 1000),
        })
        .default({}),
    })
    .default({}),

  security: z
    .object({
      envScrubber: z
        .object({
          credentialLexemes: z
            .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
            .min(1)
            .default([...DEFAULT_CREDENTIAL_LEXEMES]),
          configPointerSuffixes: z
            .array(z.string().regex(/^_[A-Z][A-Z0-9_]*$/))
            .default([...DEFAULT_CONFIG_POINTER_SUFFIXES]),
        })
        .default({}),
    })
    .strict()
    .default({}),

  supervisor: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().optional(),
      intervalMs: z.number().default(20 * 60 * 1000),
      consecutiveStuckVerdicts: z.number().default(3),
      logLines: z.number().default(400),
      forceCancelDelayMs: z.number().default(600_000),
    })
    .default({}),

  telegram: z
    .object({
      botToken: z.string().default(""),
      allowedUserIds: z.array(z.number()).default([]),
    })
    .default({}),

  mcp: z
    .object({
      shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000),
      shellTimeoutFloorMs: z.number().default(10 * 60 * 1000),
      inProcessTimeoutMs: z.number().default(300_000),
      maxOutputBytes: z.number().default(100 * 1024),
      maxFetchBytes: z.number().default(200_000),
      maxDownloadBytes: z.number().default(250 * 1024 * 1024),
      maxFileReadBytes: z.number().default(200_000),
      maxSearchResults: z.number().int().min(0).default(1_000),
      maxSearchDepth: z.number().int().positive().default(20),
      maxSearchMs: z.number().int().positive().default(10_000),
      fetchTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
      webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
      webSearchMaxResults: z.number().int().min(1).max(50).default(20),
      webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
    })
    .default({})
    .superRefine((mcp, ctx) => {
      if (mcp.shellTimeoutMs <= WALL_CLOCK_HEADROOM_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shellTimeoutMs"],
          message:
            `mcp.shellTimeoutMs must exceed WALL_CLOCK_HEADROOM_MS (${WALL_CLOCK_HEADROOM_MS}ms); ` +
            `got ${mcp.shellTimeoutMs}`,
        });
        return;
      }
      const innerCap = mcp.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;
      if (mcp.shellTimeoutFloorMs > innerCap) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shellTimeoutFloorMs"],
          message:
            `mcp.shellTimeoutFloorMs (${mcp.shellTimeoutFloorMs}) must not exceed the derived inner cap ` +
            `mcp.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS (${innerCap})`,
        });
      }
    }),

  notifications: z
    .object({
      channels: z.array(z.enum(["telegram", "web"])).default(["web"]),
      filters: notificationFiltersSchema.default({}),
    })
    .default({}),

  oauth: z
    .object({
      anthropic: z
        .object({ clientId: z.string().default(DEFAULT_ANTHROPIC_CLIENT_ID) })
        .default({}),
      openaiCodex: z
        .object({ clientId: z.string().default(DEFAULT_OPENAI_CODEX_CLIENT_ID) })
        .default({}),
      githubCopilot: z
        .object({ clientId: z.string().default(DEFAULT_GITHUB_COPILOT_CLIENT_ID) })
        .default({}),
    })
    .default({}),

  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
}).strict();

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
