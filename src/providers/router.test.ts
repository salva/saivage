import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelRouter } from "./router.js";
import type { SaivageConfig } from "../config.js";

function makeConfig(overrides: Partial<SaivageConfig> = {}): SaivageConfig {
  return {
    models: {
      orchestrator: "anthropic/claude-sonnet-4-20250514",
      coder: "anthropic/claude-sonnet-4-20250514",
      researcher: "openai/gpt-4o",
      executor: "anthropic/claude-haiku-3",
      chat: "anthropic/claude-sonnet-4-20250514",
      default: "anthropic/claude-sonnet-4-20250514",
    },
    providers: {},
    failover: {},
    server: { port: 7777, host: "0.0.0.0" },
    agent: { maxConcurrentAgents: 3 },
    generator: { language: "typescript", testBeforeRegister: true, sandbox: true },
    runtime: {
      maxServices: 50,
      restartOnCrash: true,
      healthCheckIntervalMs: 30000,
      idleShutdownMs: 300000,
    },
    versions: { storagePath: "~/.saivage/versions", retainCount: 5 },
    sandbox: { timeoutMs: 120000, secondaryInstancePort: 7778 },
    watchdog: { enabled: true, healthCheckIntervalMs: 5000, restartTimeoutMs: 60000 },
    security: { injectionScanner: true, maxScanLengthBytes: 100000 },
    ...overrides,
  };
}

describe("ModelRouter", () => {
  it("resolves model for role", () => {
    const router = new ModelRouter(makeConfig());
    expect(router.resolveModelForRole("coder")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("falls back to default for unknown role", () => {
    const router = new ModelRouter(makeConfig());
    expect(router.resolveModelForRole("unknown")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("lists registered providers", () => {
    const router = new ModelRouter(makeConfig());
    const providers = router.listProviders();
    // Ollama is always registered
    expect(providers).toContain("ollama");
  });
});
