import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { validateModelCoverage, MissingModelForRoleError } from "./config-validation.js";
import { ModelRoutingResolver } from "./routing/resolver.js";
import type { SaivageConfig } from "./config.js";

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
    security: { injectionScanner: true, maxScanLengthBytes: 100_000 },
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
      security: { ...makeConfig().security, injectionModel: "github-copilot/gpt-5.4" } as SaivageConfig["security"],
    });
    const routing = new ModelRoutingResolver({}, {
      models: { default: "github-copilot/gpt-5.4" },
      supervisorModel: "github-copilot/gpt-5.4",
      securityModel: "github-copilot/gpt-5.4",
    });
    expect(() => validateModelCoverage(cfg, routing, "/x/.saivage/saivage.json")).not.toThrow();
  });

  it("throws when worker roles have no model", () => {
    const cfg = makeConfig({
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
      security: { ...makeConfig().security, injectionScanner: false } as SaivageConfig["security"],
    });
    const routing = new ModelRoutingResolver({}, {});
    expect(() => validateModelCoverage(cfg, routing, "/x/.saivage/saivage.json"))
      .toThrow(MissingModelForRoleError);
  });

  it("supervisor disabled + no model => no supervisor in error", () => {
    const cfg = makeConfig({
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
      security: { ...makeConfig().security, injectionScanner: false } as SaivageConfig["security"],
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
      security: { ...makeConfig().security, injectionScanner: false } as SaivageConfig["security"],
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

  it("security enabled + no model anywhere => security in error", () => {
    const cfg = makeConfig({
      models: { default: "github-copilot/gpt-5.4" } as SaivageConfig["models"],
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
    });
    const routing = new ModelRoutingResolver({}, {
      models: { default: "github-copilot/gpt-5.4" },
    });
    try {
      validateModelCoverage(cfg, routing, "/x/.saivage/saivage.json");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingModelForRoleError);
      expect((err as MissingModelForRoleError).roles).toContain("security");
    }
  });

  it("error message names the config path", () => {
    const cfg = makeConfig({
      supervisor: { ...makeConfig().supervisor, enabled: false } as SaivageConfig["supervisor"],
      security: { ...makeConfig().security, injectionScanner: false } as SaivageConfig["security"],
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
      security: { ...makeConfig().security, injectionScanner: false } as SaivageConfig["security"],
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
