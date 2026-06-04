import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialResolver } from "./credential-resolver.js";
import { ProviderRegistry } from "./provider-registry.js";

vi.mock("../auth/index.js", () => ({
  hasOAuthCredentials: vi.fn().mockResolvedValue(false),
}));

describe("ProviderRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers base providers and caches account-specific provider instances", async () => {
    const providerConfigs = {
      openai: {
        apiKey: "provider-key",
        accounts: {
          main: { apiKey: "account-key" },
        },
      },
    };
    const credentials = new CredentialResolver(providerConfigs);
    const registry = new ProviderRegistry(providerConfigs, credentials);

    await registry.initBaseProviders();

    const base = registry.get("openai");
    const account = registry.getForRequest("openai", { accountRef: "openai.main" });

    expect(base).toBeDefined();
    expect(account).toBeDefined();
    expect(account).not.toBe(base);
    expect(registry.getForRequest("openai", { accountRef: "openai.main" })).toBe(account);
  });

  it("uses the base provider when an explicit auth profile is requested", async () => {
    const providerConfigs = {
      openai: {
        apiKey: "provider-key",
        defaultAccount: "main",
        accounts: {
          main: { apiKey: "account-key" },
        },
      },
    };
    const credentials = new CredentialResolver(providerConfigs);
    const registry = new ProviderRegistry(providerConfigs, credentials);

    await registry.initBaseProviders();

    const base = registry.get("openai");
    expect(registry.getForRequest("openai", { authProfileKey: "work" })).toBe(base);
  });
});
