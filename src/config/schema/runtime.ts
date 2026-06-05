import { z } from "zod";
import {
  DEFAULT_ANTHROPIC_CLIENT_ID,
  DEFAULT_OPENAI_CODEX_CLIENT_ID,
  DEFAULT_GITHUB_COPILOT_CLIENT_ID,
} from "../../auth/defaults.js";
import {
  DEFAULT_CREDENTIAL_LEXEMES,
  DEFAULT_CONFIG_POINTER_SUFFIXES,
} from "../../security/secrets.js";

export const serverSchema = z
  .object({
    port: z.number().default(8080),
    host: z.string().default("0.0.0.0"),
  })
  .default({});

export const agentSchema = z
  .object({
    maxConcurrentAgents: z.number().default(3),
  })
  .default({});

export const runtimeSchema = z
  .object({
    // Deprecated compatibility key: accepted but not currently enforced.
    maxServices: z.number().default(50),
    restartOnCrash: z.boolean().default(true),
    continuousImprovement: z.boolean().default(true),
    healthCheckIntervalMs: z.number().default(30_000),
    // Deprecated compatibility key: external MCP idle shutdown is disabled in v2.
    idleShutdownMs: z.number().default(300_000),
    recoveryDelayMs: z.number().default(60_000),
    notes: z
      .object({
        volatileTtlMs: z.number().default(2 * 60 * 60 * 1000),
      })
      .default({}),
  })
  .default({});

export const securitySchema = z
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
  .default({});

export const supervisorSchema = z
  .object({
    enabled: z.boolean().default(true),
    model: z.string().optional(),
    intervalMs: z.number().default(20 * 60 * 1000),
    consecutiveStuckVerdicts: z.number().default(3),
    logLines: z.number().default(400),
    forceCancelDelayMs: z.number().default(600_000),
  })
  .default({});

export const telegramSchema = z
  .object({
    botToken: z.string().default(""),
    allowedUserIds: z.array(z.number()).default([]),
  })
  .default({});

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

export const notificationsSchema = z
  .object({
    channels: z.array(z.enum(["telegram", "web"])).default(["web"]),
    filters: notificationFiltersSchema.default({}),
  })
  .default({});

export const oauthSchema = z
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
  .default({});
