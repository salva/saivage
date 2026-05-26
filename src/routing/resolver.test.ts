import { describe, expect, it } from "vitest";
import { ModelRoutingResolver, RoutingProfileCycleError } from "./resolver.js";

describe("ModelRoutingResolver", () => {
  it("preserves legacy override and runtime fallback behavior", () => {
    const resolver = new ModelRoutingResolver(
      {
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

  it("classifies allowed_models-only routing rules as routing-derived (F04 r3)", () => {
    const resolver = new ModelRoutingResolver(
      {
        routing: {
          roles: {
            coder: { allowed_models: ["github-copilot/gpt-5.4"] },
          },
        },
      },
      {},
    );

    const route = resolver.resolve("coder");
    expect(route.modelSpec).toBe("github-copilot/gpt-5.4");
    expect(route.source).toBe("routing");
  });

  it("rejects a direct profile cycle at construction time", () => {
    expect(() => new ModelRoutingResolver(
      {
        routing: {
          profiles: {
            A: { profile: "B", preferred_models: ["x/y"] },
            B: { profile: "A" },
          },
          roles: { coder: "A" },
        },
      },
      {},
    )).toThrowError(RoutingProfileCycleError);
  });

  it("rejects a profile self-loop at construction time", () => {
    try {
      new ModelRoutingResolver(
        {
          routing: {
            profiles: { A: { profile: "A" } },
            roles: { coder: "A" },
          },
        },
        {},
      );
      throw new Error("expected constructor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingProfileCycleError);
      expect((err as RoutingProfileCycleError).cycle).toEqual(["A", "A"]);
    }
  });

  it("rejects an unused transitive profile cycle at construction time", () => {
    try {
      new ModelRoutingResolver(
        {
          routing: {
            profiles: {
              A: { profile: "B" },
              B: { profile: "C" },
              C: { profile: "B" },
              solo: { preferred_models: ["x/y"] },
            },
            roles: { coder: "solo" },
          },
        },
        {},
      );
      throw new Error("expected constructor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingProfileCycleError);
      expect((err as RoutingProfileCycleError).cycle).toEqual(["B", "C", "B"]);
    }
  });

  it("rejects a deep profile cycle at construction time", () => {
    try {
      new ModelRoutingResolver(
        {
          routing: {
            profiles: {
              A: { profile: "B" },
              B: { profile: "C" },
              C: { profile: "D" },
              D: { profile: "A" },
            },
            roles: { coder: "A" },
          },
        },
        {},
      );
      throw new Error("expected constructor to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingProfileCycleError);
      expect((err as RoutingProfileCycleError).cycle).toEqual(["A", "B", "C", "D", "A"]);
    }
  });
});