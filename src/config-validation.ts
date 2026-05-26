/**
 * F04 — Boot-time model coverage validator.
 *
 * No silent defaults. Operators must configure a model for every role the
 * project actually uses. `bootstrap()` calls this once after building the
 * routing resolver; a failure means refusing to start with a precise message.
 */
import type { SaivageConfig } from "./config.js";
import type { ModelRoutingResolver } from "./routing/resolver.js";

export class MissingModelForRoleError extends Error {
  readonly roles: string[];
  readonly configPath: string;
  constructor(roles: string[], configPathStr: string) {
    super(
      `No model configured for role(s): ${roles.join(", ")}. Set models.default (or models.<role>) in ${configPathStr}.`,
    );
    this.name = "MissingModelForRoleError";
    this.roles = roles;
    this.configPath = configPathStr;
  }
}

export class NoAllowedRouteMatchError extends Error {
  readonly kind: "model" | "account";
  readonly role: string;
  readonly candidates: string[];
  readonly allowed: string[];
  readonly configPath: string;
  constructor(
    kind: "model" | "account",
    role: string,
    candidates: string[],
    allowed: string[],
    configPathStr: string,
  ) {
    super(
      `No ${kind} in the configured allow-list for role "${role}" matches any candidate. ` +
      `Candidates: [${candidates.join(", ")}]. Allowed: [${allowed.join(", ")}]. ` +
      `Config: ${configPathStr}`,
    );
    this.name = "NoAllowedRouteMatchError";
    this.kind = kind;
    this.role = role;
    this.candidates = candidates;
    this.allowed = allowed;
    this.configPath = configPathStr;
  }
}

/**
 * Always-required worker/coordinator roles, plus chat. `designer` and
 * `manager` are roster roles too but `designer` is not always invoked;
 * `manager` is dispatched via the parent runtime which resolves on demand.
 * Keep this list aligned with `src/agents/roster.ts`.
 */
const REQUIRED_MODEL_ROLES: readonly string[] = [
  "planner",
  "manager",
  "coder",
  "researcher",
  "data_agent",
  "reviewer",
  "inspector",
  "chat",
];

export function validateModelCoverage(
  config: SaivageConfig,
  routing: ModelRoutingResolver,
  configPathStr: string,
): void {
  const missing: string[] = [];
  for (const role of REQUIRED_MODEL_ROLES) {
    try {
      routing.resolve(role);
    } catch (err) {
      if (err instanceof MissingModelForRoleError) {
        missing.push(role);
        continue;
      }
      throw err;
    }
  }
  if (config.supervisor.enabled) {
    try {
      routing.resolve("supervisor");
    } catch (err) {
      if (err instanceof MissingModelForRoleError) {
        missing.push("supervisor");
      } else {
        throw err;
      }
    }
  }
  if (missing.length > 0) {
    throw new MissingModelForRoleError(missing, configPathStr);
  }
}
