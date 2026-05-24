import { z } from "zod";
import { ROSTER } from "../agents/roster.js";
import { MissingModelForRoleError } from "../config-validation.js";
import { configPath } from "../config.js";

export const ROUTING_ROLE_TO_MODEL_KEY: Record<string, string> = {
  ...Object.fromEntries(ROSTER.map((entry) => [entry.role, entry.defaultModelKey])),
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

export interface RuntimeProviderAccountLike {
  apiKey?: string;
  baseUrl?: string;
  authProfile?: string;
  priority?: number;
  models?: string[];
  headers?: Record<string, string>;
  quota?: {
    usedTokens?: number;
    totalTokens?: number;
    remainingTokens?: number;
    remainingRatio?: number;
  };
}

export interface RuntimeProviderConfigLike extends RuntimeProviderAccountLike {
  defaultAccount?: string;
  accounts?: Record<string, RuntimeProviderAccountLike | undefined>;
  defaultContextWindow?: number;
}

export interface ProjectRoutingConfigLike {
  model_overrides?: Record<string, string>;
  routing?: ProjectRoutingConfig;
}

export interface RuntimeRoutingConfigLike {
  models?: Record<string, string | string[] | undefined>;
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
  source: "routing" | "legacy" | "runtime-default";
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
    const candidate = preferredModels[0] ?? this.resolveLegacyModels(role)[0];
    if (!candidate) throw new MissingModelForRoleError([role], configPath());
    const modelSpec = candidate;
    const parsed = tryParseModelSpec(modelSpec);
    const provider = parsed?.provider ?? "";
    const model = parsed?.model ?? modelSpec;
    const preferredAccounts = parsed ? this.resolvePreferredAccounts(provider, merged) : [];

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
    return this.resolveLegacyModels(role);
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

  private resolveRuntimeDefaultModels(role: string): string[] {
    if (role === "supervisor") return normalizeModelList(this.runtime.supervisorModel);
    if (role === "security") return normalizeModelList(this.runtime.securityModel);
    const key = ROUTING_ROLE_TO_MODEL_KEY[role] ?? role;
    return normalizeModelList(this.runtime.models?.[key] ?? this.runtime.models?.default);
  }

  private resolveLegacyModels(role: string): string[] {
    const override = this.project.model_overrides?.[role];
    if (override) return [override];

    const runtimeDefault = this.resolveRuntimeDefaultModels(role);
    if (runtimeDefault.length) return runtimeDefault;

    throw new MissingModelForRoleError([role], configPath());
  }

  private resolveSource(role: string, rule: NormalizedRule, preferredModels: string[]): ResolvedModelRoute["source"] {
    if (rule.model || rule.preferredModels.length || rule.allowedModels?.length || rule.profile) return "routing";
    if (this.project.model_overrides?.[role]) return "legacy";
    if (this.resolveRuntimeDefaultModels(role).length) return "runtime-default";
    throw new Error("unreachable: resolveLegacyModels would have thrown first");
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

function tryParseModelSpec(modelSpec: string): { provider: string; model: string } | undefined {
  return modelSpec.includes("/") ? parseModelSpec(modelSpec) : undefined;
}

function normalizeModelList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? unique(value) : [value];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
