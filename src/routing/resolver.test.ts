import { describe, expect, it } from "vitest";
import { ModelRoutingResolver } from "./resolver.js";

describe("ModelRoutingResolver", () => {
  it("preserves legacy override and runtime fallback behavior", () => {
    const resolver = new ModelRoutingResolver(
      {
        provider: "github-copilot/gpt-5.4",
        model_overrides: {
          planner: "github-copilot/claude-sonnet-4.6",
        },
      },
      {
        models: {
          orchestrator: "anthropic/claude-sonnet-4-20250514",
          chat: "github-copilot/gpt-5.4",
        },
      },
    );

    expect(resolver.resolve("planner")).toMatchObject({
      modelSpec: "github-copilot/claude-sonnet-4.6",
      source: "legacy",
    });
    expect(resolver.resolve("chat")).toMatchObject({
      modelSpec: "github-copilot/gpt-5.4",
      source: "runtime-default",
    });
  });

  it("resolves a routing profile with preferred model and account", () => {
    const resolver = new ModelRoutingResolver(
      {
        provider: "github-copilot/gpt-5.4",
        routing: {
          profiles: {
            safe_coding: {
              preferred_models: [
                "github-copilot/gpt-5.4",
                "github-copilot/claude-sonnet-4.6",
              ],
              preferred_accounts: ["main"],
            },
          },
          roles: {
            planner: "safe_coding",
          },
        },
      },
      {
        models: {
          orchestrator: "anthropic/claude-sonnet-4-20250514",
        },
        providers: {
          "github-copilot": {
            defaultAccount: "backup",
            accounts: {
              main: { authProfile: "github-copilot-main" },
            },
          },
        },
      },
    );

    expect(resolver.resolve("planner")).toMatchObject({
      modelSpec: "github-copilot/gpt-5.4",
      accountRef: "github-copilot.main",
      preferredAccounts: ["github-copilot.main"],
      profileName: "safe_coding",
      source: "routing",
    });
  });

  it("supports direct account and auth-profile pinning", () => {
    const resolver = new ModelRoutingResolver(
      {
        provider: "github-copilot/gpt-5.4",
        routing: {
          roles: {
            chat: {
              model: "github-copilot/gpt-5.4",
              auth_profile: "github-copilot-work",
              account: "main",
            },
          },
        },
      },
      {
        providers: {
          "github-copilot": {
            defaultAccount: "backup",
          },
        },
      },
    );

    expect(resolver.resolve("chat")).toMatchObject({
      modelSpec: "github-copilot/gpt-5.4",
      authProfile: "github-copilot-work",
      accountRef: undefined,
      source: "routing",
    });
  });

  it("uses shared runtime defaults for supervisor and security roles", () => {
    const resolver = new ModelRoutingResolver(
      {},
      {
        supervisorModel: "github-copilot/gpt-5.4",
        securityModel: "github-copilot/claude-sonnet-4.6",
      },
    );

    expect(resolver.resolve("supervisor")).toMatchObject({
      modelSpec: "github-copilot/gpt-5.4",
      source: "runtime-default",
    });
    expect(resolver.resolve("security")).toMatchObject({
      modelSpec: "github-copilot/claude-sonnet-4.6",
      source: "runtime-default",
    });
  });
});