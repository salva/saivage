import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialResolver } from "./credential-resolver.js";
import { getOAuthApiKey, getProfileByKey } from "../auth/index.js";

vi.mock("../auth/index.js", () => ({
  getOAuthApiKey: vi.fn(),
  getProfileByKey: vi.fn(),
}));

const mockGetOAuthApiKey = vi.mocked(getOAuthApiKey);
const mockGetProfileByKey = vi.mocked(getProfileByKey);

describe("CredentialResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOAuthApiKey.mockResolvedValue(null);
    mockGetProfileByKey.mockResolvedValue(undefined);
  });

  it("prefers requested account api keys over provider api keys", async () => {
    const resolver = new CredentialResolver({
      primary: {
        apiKey: "provider-key",
        accounts: {
          main: { apiKey: "account-key" },
        },
      },
    });

    await expect(resolver.resolveApiKey("primary", { accountRef: "primary.main" })).resolves.toBe("account-key");
  });

  it("uses the provider default account when no account is requested", async () => {
    const resolver = new CredentialResolver({
      primary: {
        apiKey: "provider-key",
        defaultAccount: "main",
        accounts: {
          main: { apiKey: "account-key" },
        },
      },
    });

    expect(resolver.resolveRequestedAccountName("primary")).toBe("main");
    await expect(resolver.resolveApiKey("primary")).resolves.toBe("account-key");
  });

  it("suppresses default account selection for explicit auth profiles", async () => {
    mockGetProfileByKey.mockResolvedValue({
      key: "work",
      provider: "primary",
      label: "Work",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      credentials: {},
    });
    mockGetOAuthApiKey.mockResolvedValue("oauth-key");
    const resolver = new CredentialResolver({
      primary: {
        defaultAccount: "main",
        accounts: {
          main: { apiKey: "account-key" },
        },
      },
    });

    expect(resolver.resolveRequestedAccountName("primary", { authProfileKey: "work" })).toBeUndefined();
    await expect(resolver.resolveApiKey("primary", { authProfileKey: "work" })).resolves.toBe("oauth-key");
    expect(mockGetOAuthApiKey).toHaveBeenCalledWith("primary", { profileKey: "work", headers: undefined });
  });
});
