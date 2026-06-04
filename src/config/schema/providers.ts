import { z } from "zod";

export const runtimeProviderAccountSchema = z.object({
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

export const runtimeProviderConfigSchema = runtimeProviderAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), runtimeProviderAccountSchema).default({}),
  defaultContextWindow: z.number().optional(),
});
