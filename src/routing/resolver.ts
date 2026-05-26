import { z } from "zod";
import { ROSTER } from "../agents/roster.js";
import { MissingModelForRoleError, NoAllowedRouteMatchError } from "../config-validation.js";
import { configPath } from "../config.js";

export class RoutingProfileCycleError extends Error {
  readonly cycle: string[];
  readonly configPath: string;
  constructor(cycle: string[], configPathStr: string) {
    super(
      `Routing profile cycle detected: ${cycle.join(" -> ")}. ` +
        `Fix the "profile" chain in ${configPathStr}.`,
    );
    this.name = "RoutingProfileCycleError";
    this.cycle = cycle;
    this.configPath = configPathStr;
  }
}

export const ROUTING_ROLE_TO_MODEL_KEY: Record<string, string> = {
  ...Object.fromEntries(ROSTER.map((entry) => [entry.role, entry.defaultModelKey])),
  supervisor: "supervisor",
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

export interface ProjectRoutingInput {
  routing?: z.output<typeof projectRoutingSchema>;
}

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

export interface RuntimeRoutingConfigLike {
  models?: Record<string, string | string[] | undefined>;
  providers?: Record<string, RuntimeProviderConfigLike | undefined>;
  supervisorModel?: string;
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
  source: "routing" | "runtime-default";
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
  private readonly project: ProjectRoutingInput;
  private readonly runtime: RuntimeRoutingConfigLike;
  private readonly routing?: ProjectRoutingConfig;
  private readonly profiles: Record<string, NormalizedRule>;
  private readonly defaultProfile?: string;

  constructor(project: ProjectRoutingInput, runtime: RuntimeRoutingConfigLike) {
    this.project = project;
    this.runtime = runtime;
    this.routing = project.routing;
    this.profiles = Object.fromEntries(
      Object.entries(this.routing?.profiles ?? {}).map(([name, rule]) => [name, normalizeRule(rule)]),
    );
    this.defaultProfile = this.routing?.default_profile;
    this.validateProfileGraph();
  }

  private validateProfileGraph(): void {
    const done = new Set<string>();
    for (const name of Object.keys(this.profiles)) {
      if (done.has(name)) continue;
      const path: string[] = [];
      const onPath = new Set<string>();
      let cursor: string | undefined = name;
      while (cursor) {
        if (onPath.has(cursor)) {
          const start = path.indexOf(cursor);
          throw new RoutingProfileCycleError(
            [...path.slice(start), cursor],
            configPath(),
          );
        }
        if (done.has(cursor)) break;
        onPath.add(cursor);
        path.push(cursor);
        const next: string | undefined = this.profiles[cursor]?.profile;
        cursor = next && this.profiles[next] ? next : undefined;
      }
      for (const visited of path) done.add(visited);
    }
  }

  resolve(role: string): ResolvedModelRoute {
    const roleRule = this.resolveRoleRule(role);
    const merged = this.mergeRuleChain(roleRule.rule);
    const preferredModels = this.resolvePreferredModels(role, merged);
    const candidate = preferredModels[0] ?? this.resolveRuntimeDefaultModels(role)[0];
    if (!candidate) throw new MissingModelForRoleError([role], configPath());
    const modelSpec = candidate;
    const parsed = tryParseModelSpec(modelSpec);
    const provider = parsed?.provider ?? "";
    const model = parsed?.model ?? modelSpec;
    const preferredAccounts = parsed ? this.resolvePreferredAccounts(role, provider, merged) : [];

    return {
      role,
      modelSpec,
      provider,
      model,
      authProfile: merged.authProfile,
      accountRef: preferredAccounts[0],
      preferredModels,
      preferredAccounts,
      source: this.resolveSource(merged),
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
    const roleEntry = this.routing?.roles?.[role] ?? this.routing?.roles?.default;

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
    const stack: NormalizedRule[] = [];
    let current: NormalizedRule | undefined = rule;

    while (current) {
      stack.unshift(current);
      const profile: string | undefined = current.profile;
      if (!profile) break;
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
    const allowed = rule.allowedModels?.length ? unique(rule.allowedModels) : undefined;

    if (!allowed) {
      return candidates.length ? candidates : this.resolveRuntimeDefaultModels(role);
    }
    if (candidates.length === 0) {
      return allowed;
    }

    const allowedSet = new Set(allowed);
    const filtered = candidates.filter((c) => allowedSet.has(c));
    if (filtered.length > 0) return filtered;

    throw new NoAllowedRouteMatchError("model", role, candidates, allowed, configPath());
  }

  private resolvePreferredAccounts(role: string, provider: string, rule: NormalizedRule): string[] {
    if (rule.authProfile) return [];

    const explicit = unique([
      ...(rule.account ? [normalizeAccountRef(provider, rule.account)] : []),
      ...rule.preferredAccounts.map((entry) => normalizeAccountRef(provider, entry)),
    ]);
    const defaultAccount = this.runtime.providers?.[provider]?.defaultAccount;
    const normalizedDefault = defaultAccount
      ? normalizeAccountRef(provider, defaultAccount)
      : undefined;
    const candidates = unique([
      ...explicit,
      ...(normalizedDefault ? [normalizedDefault] : []),
    ]);

    const allowed = rule.allowedAccounts?.length
      ? unique(rule.allowedAccounts.map((entry) => normalizeAccountRef(provider, entry)))
      : undefined;

    if (!allowed) {
      if (explicit.length) return explicit;
      return normalizedDefault ? [normalizedDefault] : [];
    }

    if (candidates.length === 0) {
      return allowed;
    }

    const allowedSet = new Set(allowed);
    const filteredExplicit = explicit.filter((c) => allowedSet.has(c));
    if (filteredExplicit.length > 0) return filteredExplicit;
    if (normalizedDefault && allowedSet.has(normalizedDefault)) return [normalizedDefault];

    throw new NoAllowedRouteMatchError("account", role, candidates, allowed, configPath());
  }

  private resolveRuntimeDefaultModels(role: string): string[] {
    if (role === "supervisor") {
      const models = normalizeModelList(this.runtime.supervisorModel);
      if (models.length) return models;
      throw new MissingModelForRoleError([role], configPath());
    }
    const key = ROUTING_ROLE_TO_MODEL_KEY[role] ?? role;
    const models = normalizeModelList(this.runtime.models?.[key] ?? this.runtime.models?.default);
    if (models.length) return models;
    throw new MissingModelForRoleError([role], configPath());
  }

  private resolveSource(rule: NormalizedRule): ResolvedModelRoute["source"] {
    if (rule.model || rule.preferredModels.length || rule.allowedModels?.length || rule.profile) return "routing";
    return "runtime-default";
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
