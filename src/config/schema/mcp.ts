import { z } from "zod";
import { WALL_CLOCK_HEADROOM_MS } from "../../mcp/builtins/shell.js";

export const mcpSchema = z
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
  });

export const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  disabled: z.boolean().default(false),
  autostart: z.boolean().default(true),
  // "sse" is accepted for config compatibility but currently uses stdio behavior.
  transport: z.enum(["stdio", "sse"]).default("stdio"),
});

export const mcpServersSchema = z.record(z.string(), mcpServerSchema).default({});
