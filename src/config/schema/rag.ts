import { z } from "zod";

export const ragSchema = z
  .object({
    enabled: z.boolean().default(false),
    datasets: z
      .array(
        z.object({
          id: z.string().min(1),
          source: z.enum(["skill", "memory", "doc", "code"]),
          provider: z
            .object({
              kind: z.literal("openai"),
              model: z.string().min(1).default("text-embedding-3-small"),
              dim: z.number().int().positive().default(1536),
            })
            .strict(),
          store: z
            .object({
              kind: z.literal("sqlite-vec").default("sqlite-vec"),
            })
            .default({ kind: "sqlite-vec" }),
          chunker: z.object({
            kind: z.enum(["markdown", "code", "memory"]),
            chunkSize: z.number().int().positive().optional(),
            overlap: z.number().min(0).max(0.5).optional(),
          }),
          exclusions: z.array(z.string()).default([]),
          sources: z
            .array(
              z.object({
                root: z.string().min(1),
                include: z.array(z.string()).optional(),
                exclude: z.array(z.string()).optional(),
              }),
            )
            .default([]),
          watch: z
            .union([
              z.literal(false),
              z.literal(true),
              z.object({
                usePolling: z.literal(true),
                interval: z.number().int().positive().optional(),
              }),
            ])
            .default(false),
        }),
      )
      .default([]),
  })
  .default({ enabled: false, datasets: [] });
