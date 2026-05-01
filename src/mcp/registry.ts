import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { saivageDir, ensureDir } from "../config.js";

// --- Schema ---

const toolEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

const serviceEntrySchema = z.object({
  name: z.string(),
  version: z.string().default("0.1.0"),
  origin: z.enum(["builtin", "generated", "external"]).default("builtin"),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  transport: z.enum(["stdio", "sse"]).default("stdio"),
  tools: z.array(toolEntrySchema).default([]),
  capabilities: z.array(z.string()).default([]),
  status: z.enum(["active", "inactive", "error"]).default("active"),
  createdAt: z.string().default(() => new Date().toISOString()),
});

export type ServiceEntry = z.infer<typeof serviceEntrySchema>;
export type ToolEntry = z.infer<typeof toolEntrySchema>;

const registrySchema = z.object({
  services: z.array(serviceEntrySchema).default([]),
});

type RegistryData = z.infer<typeof registrySchema>;

// --- Registry ---

function registryPath(): string {
  return join(saivageDir(), "registry.json");
}

function loadRegistry(): RegistryData {
  const fp = registryPath();
  if (!existsSync(fp)) return { services: [] };
  const raw = JSON.parse(readFileSync(fp, "utf-8"));
  return registrySchema.parse(raw);
}

function saveRegistry(data: RegistryData): void {
  ensureDir(saivageDir());
  writeFileSync(registryPath(), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function listRegisteredServices(): ServiceEntry[] {
  return loadRegistry().services;
}

export function getService(name: string): ServiceEntry | undefined {
  return loadRegistry().services.find((s) => s.name === name);
}

export function registerService(entry: ServiceEntry): void {
  const data = loadRegistry();
  const idx = data.services.findIndex((s) => s.name === entry.name);
  if (idx >= 0) {
    data.services[idx] = entry;
  } else {
    data.services.push(entry);
  }
  saveRegistry(data);
}

export function unregisterService(name: string): boolean {
  const data = loadRegistry();
  const before = data.services.length;
  data.services = data.services.filter((s) => s.name !== name);
  if (data.services.length < before) {
    saveRegistry(data);
    return true;
  }
  return false;
}

export function updateServiceStatus(
  name: string,
  status: ServiceEntry["status"],
): void {
  const data = loadRegistry();
  const svc = data.services.find((s) => s.name === name);
  if (svc) {
    svc.status = status;
    saveRegistry(data);
  }
}
