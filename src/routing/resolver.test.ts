import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelRoutingResolver, RoutingProfileCycleError, projectRoutingSchema } from "./resolver.js";
import { NoAllowedRouteMatchError } from "../config-validation.js";

const routing = (
  raw: z.input<typeof projectRoutingSchema>,
): z.output<typeof projectRoutingSchema> => projectRoutingSchema.parse(raw);

describe("ModelRoutingResolver", () => {
  it("falls back to runtime-default models when no routing rule is set", () => {
    const resolver = new ModelRoutingResolver(
      {},
      {
        models: {
          orchestrator: "anthropic/claude-sonnet-4-20250514",
          chat: "github-copilot/gpt-5.4",
        },
      },
    );

    expect(resolver.resolve("chat")).toMatchObject({
      modelSpec: "github-copilot/gpt-5.4",
      source: "runtime-default",
    });
  });

  it("resolves a routing profile with preferred model and account", () => {
    const resolver = new ModelRoutingResolver(
      {
        routing: routing({
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
        }),
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
        routing: routing({
          roles: {
            chat: {
              model: "github-copilot/gpt-5.4",
              auth_profile: "github-copilot-work",
              account: "main",
            },
          },
        }),
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
        routing: routing({
          roles: {
            coder: { allowed_models: ["github-copilot/gpt-5.4"] },
          },
        }),
      },
      {},
    );

    const route = resolver.resolve("coder");
    expect(route.modelSpec).toBe("github-copilot/gpt-5.4");
    expect(route.source).toBe("routing");
  });

  it("throws NoAllowedRouteMatchError with full payload when preferred_models is filtered out (G25)", () => {
    const resolver = new ModelRoutingResolver(
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
      {},
    );
    try {
      resolver.resolve("coder");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
      const e = err as NoAllowedRouteMatchError;
      expect(e.kind).toBe("model");
      expect(e.role).toBe("coder");
      expect(e.candidates).toEqual(["github-copilot/claude-sonnet-4.6"]);
      expect(e.allowed).toEqual(["github-copilot/gpt-5.4"]);
      expect(typeof e.configPath).toBe("string");
      expect(e.configPath.length).toBeGreaterThan(0);
    }
  });

  it("throws NoAllowedRouteMatchError with full payload when rule.model is filtered out by allowed_models (G25)", () => {
    const resolver = new ModelRoutingResolver(
      {
        routing: {
          roles: {
            coder: {
              model: "github-copilot/claude-sonnet-4.6",
              allowed_models: ["github-copilot/gpt-5.4"],
            },
          },
        },
      },
      {},
    );
    try {
      resolver.resolve("coder");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
      const e = err as NoAllowedRouteMatchError;
      expect(e.kind).toBe("model");
      expect(e.role).toBe("coder");
      expect(e.candidates).toEqual(["github-copilot/claude-sonnet-4.6"]);
      expect(e.allowed).toEqual(["github-copilot/gpt-5.4"]);
      expect(typeof e.configPath).toBe("string");
      expect(e.configPath.length).toBeGreaterThan(0);
    }
  });

  it("returns the filtered intersection when preferred_models and allowed_models overlap (G25)", () => {
    const resolver = new ModelRoutingResolver(
      {
        routing: {
          roles: {
            coder: {
              preferred_models: ["github-copilot/gpt-5.4", "github-copilot/claude-sonnet-4.6"],
              allowed_models: ["github-copilot/gpt-5.4"],
            },
          },
        },
      },
      {},
    );
    expect(resolver.resolve("coder").preferredModels).toEqual(["github-copilot/gpt-5.4"]);
  });

  it("throws NoAllowedRouteMatchError with full payload when both explicit and default account are filtered (G25)", () => {
    const resolver = new ModelRoutingResolver(
      {
        routing: {
          roles: {
            coder: {
              model: "github-copilot/gpt-5.4",
              account: "user-a",
              allowed_accounts: ["github-copilot.user-b"],
            },
          },
        },
      },
      { providers: { "github-copilot": { defaultAccount: "user-c" } } },
    );
    try {
      resolver.resolve("coder");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
      const e = err as NoAllowedRouteMatchError;
      expect(e.kind).toBe("account");
      expect(e.role).toBe("coder");
      expect(e.candidates).toEqual(["github-copilot.user-a", "github-copilot.user-c"]);
      expect(e.allowed).toEqual(["github-copilot.user-b"]);
      expect(typeof e.configPath).toBe("string");
      expect(e.configPath.length).toBeGreaterThan(0);
    }
  });

  it("throws NoAllowedRouteMatchError with full payload when only the provider defaultAccount is a candidate and it is filtered out (G25)", () => {
    const resolver = new ModelRoutingResolver(
      {
        routing: {
          roles: {
            coder: {
              model: "github-copilot/gpt-5.4",
              allowed_accounts: ["github-copilot.user-b"],
            },
          },
        },
      },
      { providers: { "github-copilot": { defaultAccount: "user-a" } } },
    );
    try {
      resolver.resolve("coder");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoAllowedRouteMatchError);
      const e = err as NoAllowedRouteMatchError;
      expect(e.kind).toBe("account");
      expect(e.role).toBe("coder");
      expect(e.candidates).toEqual(["github-copilot.user-a"]);
      expect(e.allowed).toEqual(["github-copilot.user-b"]);
      expect(typeof e.configPath).toBe("string");
      expect(e.configPath.length).toBeGreaterThan(0);
    }
  });

  it("returns the provider default account when it is in allowed_accounts (G25)", () => {
    const resolver = new ModelRoutingResolver(
      {
        routing: {
          roles: {
            coder: {
              model: "github-copilot/gpt-5.4",
              allowed_accounts: ["github-copilot.user-b"],
            },
          },
        },
      },
      { providers: { "github-copilot": { defaultAccount: "user-b" } } },
    );
    expect(resolver.resolve("coder").preferredAccounts).toEqual(["github-copilot.user-b"]);
  });

  it("returns allowed_accounts when no explicit and no default account is configured (G25)", () => {
    const resolver = new ModelRoutingResolver(
      {
        routing: {
          roles: {
            coder: {
              model: "github-copilot/gpt-5.4",
              allowed_accounts: ["github-copilot.user-b"],
            },
          },
        },
      },
      { providers: { "github-copilot": {} } },
    );
    expect(resolver.resolve("coder").preferredAccounts).toEqual(["github-copilot.user-b"]);
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