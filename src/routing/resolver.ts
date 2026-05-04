import { z } from "zod";

export const ROUTING_ROLE_TO_MODEL_KEY: Record<string, string> = {
  planner: "orchestrator",
  manager: "orchestrator",
  inspector: "orchestrator",
  coder: "coder",
  researcher: "researcher",
  data_agent: "data_agent",
  reviewer: "reviewer",
  executor: "executor",
  chat: "chat",
  supervisor: "supervisor",
  security: "security",
  default: "default",
};

export const routingRuleSchema = z.object({
  profile: z.string().optional(),
  model: z.string().optional(),
  auth_profile: z.string().optional(),
  account: z.string().optional(),
  preferred_models: z.array(z.string()).default([]),
  allowed_models: z.array(z.string()).optional(),
  preferred_accounts: z.array(z.string()).default([]),
  allowed_accounts: z.array(z.string()).optional(),
});

export const projectRoutingSchema = z.object({
  default_profile: z.string().optional(),
  profiles: z.record(z.string(), routingRuleSchema).default({}),
  roles: z.record(z.string(), z.union([z.string(), routingRuleSchema])).default({}),
});

export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type ProjectRoutingConfig = z.infer<typeof projectRoutingSchema>;

export const runtimeProviderAccountSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  authProfile: z.string().optional(),
});

export const runtimeProviderConfigSchema = runtimeProviderAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), runtimeProviderAccountSchema).default({}),
});

export interface RuntimeProviderAccountLike {
  apiKey?: string;
  baseUrl?: string;
  authProfile?: string;
}

export interface RuntimeProviderConfigLike extends RuntimeProviderAccountLike {
  defaultAccount?: string;
  accounts?: Record<string, RuntimeProviderAccountLike | undefined>;
}

export interface ProjectRoutingConfigLike {
  provider?: string;
  model_overrides?: Record<string, string>;
  routing?: ProjectRoutingConfig;
}

export interface RuntimeRoutingConfigLike {
  models?: Record<string, string | undefined>;
  providers?: Record<string, RuntimeProviderConfigLike | undefined>;
  supervisorModel?: string;
  securityModel?: string;
}

export interface ResolvedModelRoute {
  role: string;
  modelSpec: string;
  provider: string;
  model: string;
  authProfile?: string;
  accountRef?: string;
  preferredModels: string[];
  preferredAccounts: string[];
  source: "routing" | "legacy" | "runtime-default" | "project-default" | "hardcoded-default";
  profileName?: string;
}

interface NormalizedRule {
  profile?: string;
  model?: string;
  authProfile?: string;
  account?: string;
  preferredModels: string[];
  allowedModels?: string[];
  preferredAccounts: string[];
  allowedAccounts?: string[];
}

export class ModelRoutingResolver {
  private readonly project: ProjectRoutingConfigLike;
  private readonly runtime: RuntimeRoutingConfigLike;
  private readonly profiles: Record<string, NormalizedRule>;
  private readonly defaultProfile?: string;

  constructor(project: ProjectRoutingConfigLike, runtime: RuntimeRoutingConfigLike) {
    this.project = project;
    this.runtime = runtime;
    const routing = project.routing ? projectRoutingSchema.parse(project.routing) : undefined;
    this.profiles = Object.fromEntries(
      Object.entries(routing?.profiles ?? {}).map(([name, rule]) => [name, normalizeRule(rule)]),
    );
    this.defaultProfile = routing?.default_profile;
  }

  resolve(role: string): ResolvedModelRoute {
    const roleRule = this.resolveRoleRule(role);
    const merged = this.mergeRuleChain(roleRule.rule);
    const preferredModels = this.resolvePreferredModels(role, merged);
    const modelSpec = preferredModels[0] ?? this.resolveLegacyModel(role);
    const { provider, model } = parseModelSpec(modelSpec);
    const preferredAccounts = this.resolvePreferredAccounts(provider, merged);

    return {
      role,
      modelSpec,
      provider,
      model,
      authProfile: merged.authProfile,
      accountRef: preferredAccounts[0],
      preferredModels,
      preferredAccounts,
      source: this.resolveSource(role, merged, preferredModels),
      profileName: roleRule.profileName,
    };
  }

  getProviderConfig(provider: string): RuntimeProviderConfigLike | undefined {
    return this.runtime.providers?.[provider];
  }

  getProviderAccount(provider: string, accountRef?: string): RuntimeProviderAccountLike | undefined {
    if (!accountRef) return undefined;
    const normalized = normalizeAccountRef(provider, accountRef);
    const dot = normalized.indexOf(".");
    const providerName = normalized.slice(0, dot);
    const accountName = normalized.slice(dot + 1);
    if (providerName !== provider) return undefined;
    return this.runtime.providers?.[provider]?.accounts?.[accountName];
  }

  private resolveRoleRule(role: string): { profileName?: string; rule: NormalizedRule } {
    const routing = this.project.routing ? projectRoutingSchema.parse(this.project.routing) : undefined;
    const roleEntry = routing?.roles?.[role] ?? routing?.roles?.default;

    if (typeof roleEntry === "string") {
      if (roleEntry.includes("/")) {
        return { rule: normalizeRule({ model: roleEntry }) };
      }
      if (this.profiles[roleEntry]) {
        return { profileName: roleEntry, rule: normalizeRule({ profile: roleEntry }) };
      }
      return { rule: normalizeRule({ model: roleEntry }) };
    }

    if (roleEntry) {
      const normalized = normalizeRule(roleEntry);
      return {
        profileName: normalized.profile,
        rule: normalized,
      };
    }

    return this.defaultProfile && this.profiles[this.defaultProfile]
      ? { profileName: this.defaultProfile, rule: normalizeRule({ profile: this.defaultProfile }) }
      : { rule: normalizeRule({}) };
  }

  private mergeRuleChain(rule: NormalizedRule): NormalizedRule {
    const seen = new Set<string>();
    const stack: NormalizedRule[] = [];
    let current: NormalizedRule | undefined = rule;

    while (current) {
      stack.unshift(current);
      const profile: string | undefined = current.profile;
      if (!profile) break;
      if (seen.has(profile)) break;
      seen.add(profile);
      current = this.profiles[profile];
    }

    let merged = normalizeRule({});
    for (const item of stack) {
      merged = {
        profile: item.profile ?? merged.profile,
        model: item.model ?? merged.model,
        authProfile: item.authProfile ?? merged.authProfile,
        account: item.account ?? merged.account,
        preferredModels: item.preferredModels.length ? item.preferredModels : merged.preferredModels,
        allowedModels: item.allowedModels ?? merged.allowedModels,
        preferredAccounts: item.preferredAccounts.length ? item.preferredAccounts : merged.preferredAccounts,
        allowedAccounts: item.allowedAccounts ?? merged.allowedAccounts,
      };
    }

    return merged;
  }

  private resolvePreferredModels(role: string, rule: NormalizedRule): string[] {
    const candidates = unique([
      ...(rule.model ? [rule.model] : []),
      ...rule.preferredModels,
    ]);

    const allowed = rule.allowedModels?.length
      ? new Set(rule.allowedModels)
      : undefined;
    const filtered = allowed
      ? candidates.filter((candidate) => allowed.has(candidate))
      : candidates;

    if (filtered.length > 0) return filtered;
    if (allowed?.size) return [...allowed];
    return [];
  }

  private resolvePreferredAccounts(provider: string, rule: NormalizedRule): string[] {
    if (rule.authProfile) return [];

    const explicit = unique([
      ...(rule.account ? [normalizeAccountRef(provider, rule.account)] : []),
      ...rule.preferredAccounts.map((entry) => normalizeAccountRef(provider, entry)),
    ]);

    const allowed = rule.allowedAccounts?.length
      ? new Set(rule.allowedAccounts.map((entry) => normalizeAccountRef(provider, entry)))
      : undefined;
    const filtered = allowed
      ? explicit.filter((candidate) => allowed.has(candidate))
      : explicit;
    if (filtered.length > 0) return filtered;

    const defaultAccount = this.runtime.providers?.[provider]?.defaultAccount;
    if (defaultAccount) {
      const normalizedDefault = normalizeAccountRef(provider, defaultAccount);
      if (!allowed || allowed.has(normalizedDefault)) return [normalizedDefault];
    }

    return allowed ? [...allowed] : [];
  }

  private resolveRuntimeDefaultModel(role: string): string | undefined {
    if (role === "supervisor") return this.runtime.supervisorModel;
    if (role === "security") return this.runtime.securityModel;
    const key = ROUTING_ROLE_TO_MODEL_KEY[role] ?? role;
    return this.runtime.models?.[key] ?? this.runtime.models?.default;
  }

  private resolveLegacyModel(role: string): string {
    const override = this.project.model_overrides?.[role];
    if (override) return override;

    const runtimeDefault = this.resolveRuntimeDefaultModel(role);
    if (runtimeDefault) return runtimeDefault;

    if (this.project.provider) return this.project.provider;
    return "openai-codex/gpt-5.3-codex";
  }

  private resolveSource(role: string, rule: NormalizedRule, preferredModels: string[]): ResolvedModelRoute["source"] {
    if (rule.model || rule.preferredModels.length || rule.profile) return "routing";
    if (this.project.model_overrides?.[role]) return "legacy";
    if (this.resolveRuntimeDefaultModel(role)) return "runtime-default";
    if (this.project.provider) return "project-default";
    return "hardcoded-default";
  }
}

function normalizeRule(rule: Partial<RoutingRule>): NormalizedRule {
  return {
    profile: rule.profile,
    model: rule.model,
    authProfile: rule.auth_profile,
    account: rule.account,
    preferredModels: unique(rule.preferred_models ?? []),
    allowedModels: rule.allowed_models?.length ? unique(rule.allowed_models) : undefined,
    preferredAccounts: unique(rule.preferred_accounts ?? []),
    allowedAccounts: rule.allowed_accounts?.length ? unique(rule.allowed_accounts) : undefined,
  };
}

function normalizeAccountRef(provider: string, ref: string): string {
  return ref.includes(".") ? ref : `${provider}.${ref}`;
}

export function parseAccountRef(ref: string): { provider: string; account: string } {
  const dot = ref.indexOf(".");
  if (dot === -1) {
    throw new Error(`Invalid account ref "${ref}": expected "provider.account"`);
  }
  return {
    provider: ref.slice(0, dot),
    account: ref.slice(dot + 1),
  };
}

export function parseModelSpec(modelSpec: string): { provider: string; model: string } {
  const slash = modelSpec.indexOf("/");
  if (slash === -1) {
    throw new Error(`Invalid model spec "${modelSpec}": expected "provider/model"`);
  }
  return {
    provider: modelSpec.slice(0, slash),
    model: modelSpec.slice(slash + 1),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}