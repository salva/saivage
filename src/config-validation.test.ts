import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateModelCoverage, MissingModelForRoleError, NoAllowedRouteMatchError } from "./config-validation.js";
import { ModelRoutingResolver } from "./routing/resolver.js";
import { loadConfig } from "./config.js";
import type { SaivageConfig } from "./config.js";
import {
  DEFAULT_CREDENTIAL_LEXEMES,
  DEFAULT_CONFIG_POINTER_SUFFIXES,
} from "./security/secrets.js";

function defaultSecurity(): SaivageConfig["security"] {
  return {
    envScrubber: {
      credentialLexemes: [...DEFAULT_CREDENTIAL_LEXEMES],
      configPointerSuffixes: [...DEFAULT_CONFIG_POINTER_SUFFIXES],
    },
  };
}

function makeConfig(overrides: Partial<SaivageConfig> = {}): SaivageConfig {
  return {
    models: {},
    providers: {},
    failover: {},
    modelEquivalents: {},
    server: { port: 8080, host: "0.0.0.0" },
    agent: { maxConcurrentAgents: 3 },
    runtime: {
      maxServices: 50,
      restartOnCrash: true,
      continuousImprovement: true,
      healthCheckIntervalMs: 30_000,
      idleShutdownMs: 300_000,
    },
    security: defaultSecurity(),
    supervisor: {
      enabled: true,
      intervalMs: 1200_000,
      consecutiveStuckVerdicts: 3,
      logLines: 400,
    },
    ...overrides,
  } as unknown as SaivageConfig;
}

describe("validateModelCoverage", () => {
  it("happy path: models.default set covers all roles", () => {
    const cfg = makeConfig({
      models: { default: "github-copilot/gpt-5.4" } as SaivageConfig["models"],
      supervisor: { ...makeConfig().supervisor, model: "github-copilot/gpt-5.4" } as SaivageConfig["supervisor"],
    });
    const routing = new ModelRoutingResolver({}, {
      models: { default: "github-copilot/gpt-5.4" },
      supervisorModel: "github-copilot/gpt-5.4",
    });
    expect(() => validateModelCoverage(cfg, routing, "/x/.saivage/saivage.json")).not.toThrow();
  });

  it("throws when worker roles have no model", () => {
    const cfg = makeConfig({
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
    });
    const routing = new ModelRoutingResolver({}, {});
    expect(() => validateModelCoverage(cfg, routing, "/x/.saivage/saivage.json"))
      .toThrow(MissingModelForRoleError);
  });

  it("supervisor disabled + no model => no supervisor in error", () => {
    const cfg = makeConfig({
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
    });
    const routing = new ModelRoutingResolver({}, {});
    try {
      validateModelCoverage(cfg, routing, "/x/.saivage/saivage.json");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingModelForRoleError);
      expect((err as MissingModelForRoleError).roles).not.toContain("supervisor");
      expect((err as MissingModelForRoleError).roles).not.toContain("security");
    }
  });

  it("supervisor enabled + no model anywhere => supervisor in error", () => {
    const cfg = makeConfig({
      models: { default: "github-copilot/gpt-5.4" } as SaivageConfig["models"],
    });
    const routing = new ModelRoutingResolver({}, {
      models: { default: "github-copilot/gpt-5.4" },
    });
    try {
      validateModelCoverage(cfg, routing, "/x/.saivage/saivage.json");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingModelForRoleError);
      expect((err as MissingModelForRoleError).roles).toContain("supervisor");
    }
  });

  it("error message names the config path", () => {
    const cfg = makeConfig({
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
    });
    const routing = new ModelRoutingResolver({}, {});
    try {
      validateModelCoverage(cfg, routing, "/proj/.saivage/saivage.json");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("/proj/.saivage/saivage.json");
    }
  });

  it("disabled-everything bootability: workers still required", () => {
    const cfg = makeConfig({
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
    });
    const routing = new ModelRoutingResolver({}, {});
    try {
      validateModelCoverage(cfg, routing, "/x/.saivage/saivage.json");
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as MissingModelForRoleError;
      expect(e.roles).toContain("planner");
      expect(e.roles).toContain("coder");
      expect(e.roles).not.toContain("supervisor");
      expect(e.roles).not.toContain("security");
    }
  });

  it("propagates NoAllowedRouteMatchError verbatim with full payload instead of collapsing into MissingModelForRoleError (G25)", () => {
    const cfg = makeConfig({
      models: { default: "github-copilot/gpt-5.4" } as SaivageConfig["models"],
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
    });
    const routing = new ModelRoutingResolver(
      {
        routing: {
          roles: {
            coder: {
              preferred_models: ["github-copilot/claude-sonnet-4.6"],
              allowed_models: ["github-copilot/gpt-5.4"],
            },
          },
        },
      },
      { models: { default: "github-copilot/gpt-5.4" } },
    );
    try {
      validateModelCoverage(cfg, routing, "/proj/.saivage/saivage.json");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
      expect(err).not.toBeInstanceOf(MissingModelForRoleError);
      const e = err as NoAllowedRouteMatchError;
      expect(e.kind).toBe("model");
      expect(e.role).toBe("coder");
      expect(e.candidates).toEqual(["github-copilot/claude-sonnet-4.6"]);
      expect(e.allowed).toEqual(["github-copilot/gpt-5.4"]);
      expect(typeof e.configPath).toBe("string");
      expect(e.configPath.length).toBeGreaterThan(0);
    }
  });
});

describe("production-source sweep (F04 step 11)", () => {
  it("contains no hardcoded model identifiers outside test files", () => {
    const repo = resolve(__dirname, "..");
    let stdout = "";
    try {
      stdout = execSync(
        `rg -l 'github-copilot/gpt-5\\.|anthropic/claude-sonnet-4-|openai-codex/gpt-5\\.3-codex' src/ --type ts || true`,
        { cwd: repo, encoding: "utf8" },
      );
    } catch {
      stdout = "";
    }
    const offenders = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .filter((s) => !s.endsWith(".test.ts"));
    expect(offenders).toEqual([]);
  });
});

describe("security.envScrubber", async () => {
  // Self-contained fixture: this file does not otherwise touch
  // .saivage/saivage.json on disk, so the env scrubber tests own
  // their PROJECT_ROOT / SAIVAGE_ROOT setup.

  async function withProject(
    securityBlock: unknown,
  ): Promise<{ cleanup: () => void; cfg: SaivageConfig } | { cleanup: () => void; error: Error }> {
    const projectRoot = mkdtempSync(join(tmpdir(), "saivage-envscrubber-"));
    const savedProject = process.env.PROJECT_ROOT;
    const savedRoot = process.env.SAIVAGE_ROOT;
    process.env.PROJECT_ROOT = projectRoot;
    process.env.SAIVAGE_ROOT = join(projectRoot, ".saivage");
    mkdirSync(process.env.SAIVAGE_ROOT, { recursive: true });
    writeFileSync(
      join(process.env.SAIVAGE_ROOT, "saivage.json"),
      JSON.stringify({ security: securityBlock }),
      "utf-8",
    );
    const cleanup = () => {
      if (savedProject === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = savedProject;
      if (savedRoot === undefined) delete process.env.SAIVAGE_ROOT;
      else process.env.SAIVAGE_ROOT = savedRoot;
      rmSync(projectRoot, { recursive: true, force: true });
    };
    try {
      const cfg = (await loadConfig(projectRoot)) as SaivageConfig;
      return { cleanup, cfg };
    } catch (error) {
      return { cleanup, error: error as Error };
    }
  }

  it("envScrubber is absent → defaults applied", async () => {
    const result = await withProject({});
    try {
      if ("error" in result) throw result.error;
      expect(result.cfg.security.envScrubber.credentialLexemes).toEqual([
        ...DEFAULT_CREDENTIAL_LEXEMES,
      ]);
      expect(result.cfg.security.envScrubber.configPointerSuffixes).toEqual([
        ...DEFAULT_CONFIG_POINTER_SUFFIXES,
      ]);
    } finally {
      result.cleanup();
    }
  });

  it("envScrubber={} → defaults applied", async () => {
    const result = await withProject({ envScrubber: {} });
    try {
      if ("error" in result) throw result.error;
      expect(result.cfg.security.envScrubber.credentialLexemes).toEqual([
        ...DEFAULT_CREDENTIAL_LEXEMES,
      ]);
      expect(result.cfg.security.envScrubber.configPointerSuffixes).toEqual([
        ...DEFAULT_CONFIG_POINTER_SUFFIXES,
      ]);
    } finally {
      result.cleanup();
    }
  });

  it("rejects empty credentialLexemes array", async () => {
    const result = await withProject({ envScrubber: { credentialLexemes: [] } });
    try {
      expect("error" in result).toBe(true);
    } finally {
      result.cleanup();
    }
  });

  it("rejects lowercase lexeme entry", async () => {
    const result = await withProject({ envScrubber: { credentialLexemes: ["api_key"] } });
    try {
      expect("error" in result).toBe(true);
    } finally {
      result.cleanup();
    }
  });

  it("rejects lexeme entry starting with digit", async () => {
    const result = await withProject({ envScrubber: { credentialLexemes: ["1KEY"] } });
    try {
      expect("error" in result).toBe(true);
    } finally {
      result.cleanup();
    }
  });

  it("rejects suffix without leading underscore", async () => {
    const result = await withProject({ envScrubber: { configPointerSuffixes: ["URL"] } });
    try {
      expect("error" in result).toBe(true);
    } finally {
      result.cleanup();
    }
  });

  it("rejects suffix with lowercase", async () => {
    const result = await withProject({ envScrubber: { configPointerSuffixes: ["_url"] } });
    try {
      expect("error" in result).toBe(true);
    } finally {
      result.cleanup();
    }
  });

  it("rejects stale scanner keys", async () => {
    const staleKey = ["injection", "Scanner"].join("");
    const result = await withProject({ [staleKey]: true });
    try {
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error.message).toContain(staleKey);
    } finally {
      result.cleanup();
    }
  });

  it("S-R-A: full-replacement singleton credentialLexemes: [\"PII\"]", async () => {
    const result = await withProject({
      envScrubber: { credentialLexemes: ["PII"] },
    });
    try {
      if ("error" in result) throw result.error;
      expect(result.cfg.security.envScrubber.credentialLexemes).toEqual(["PII"]);
      expect(result.cfg.security.envScrubber.configPointerSuffixes).toEqual([
        ...DEFAULT_CONFIG_POINTER_SUFFIXES,
      ]);
    } finally {
      result.cleanup();
    }
  });

  it("S-R-B: full-replacement singleton configPointerSuffixes: [\"_BUILDFILE\"]", async () => {
    const result = await withProject({
      envScrubber: { configPointerSuffixes: ["_BUILDFILE"] },
    });
    try {
      if ("error" in result) throw result.error;
      expect(result.cfg.security.envScrubber.credentialLexemes).toEqual([
        ...DEFAULT_CREDENTIAL_LEXEMES,
      ]);
      expect(result.cfg.security.envScrubber.configPointerSuffixes).toEqual(["_BUILDFILE"]);
    } finally {
      result.cleanup();
    }
  });
});
