import { z } from "zod";
import { modelsSchema } from "./models.js";
import { runtimeProviderConfigSchema } from "./providers.js";
import { mcpSchema, mcpServersSchema } from "./mcp.js";
import { ragSchema } from "./rag.js";
import {
  agentSchema,
  notificationsSchema,
  oauthSchema,
  runtimeSchema,
  securitySchema,
  serverSchema,
  supervisorSchema,
  telegramSchema,
} from "./runtime.js";

export const SaivageConfigSchema = z.object({
  models: modelsSchema,
  providers: z.record(z.string(), runtimeProviderConfigSchema).default({}),
  failover: z.record(z.string(), z.array(z.string())).default({}),
  modelEquivalents: z.record(z.string(), z.array(z.string())).default({}),
  server: serverSchema,
  agent: agentSchema,
  runtime: runtimeSchema,
  security: securitySchema,
  supervisor: supervisorSchema,
  telegram: telegramSchema,
  mcp: mcpSchema,
  notifications: notificationsSchema,
  oauth: oauthSchema,
  mcpServers: mcpServersSchema,
  rag: ragSchema,
}).strict();
