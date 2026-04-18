/**
 * OAuth credential store.
 *
 * Persists auth profiles to <project>/.saivage/auth-profiles.json.
 * Supports login, token refresh, and API key retrieval.
 * Mirrors the OpenClaw/pi-ai pattern.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { saivageDir, ensureDir } from "../config.js";
import { log } from "../log.js";
import { openaiCodexOAuthProvider } from "./openai-codex.js";
import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import type {
  AuthProfile,
  AuthProfileStore,
  OAuthCredentials,
  OAuthProviderDef,
} from "./types.js";

export type { OAuthProviderDef, OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

// --- Provider registry ---

const providers = new Map<string, OAuthProviderDef>([
  [openaiCodexOAuthProvider.id, openaiCodexOAuthProvider],
  [anthropicOAuthProvider.id, anthropicOAuthProvider],
  [githubCopilotOAuthProvider.id, githubCopilotOAuthProvider],
]);

export function getOAuthProvider(id: string): OAuthProviderDef | undefined {
  return providers.get(id);
}

export function getOAuthProviders(): OAuthProviderDef[] {
  return [...providers.values()];
}

// --- Storage ---

function storePath(): string {
  return join(saivageDir(), "auth-profiles.json");
}

export function loadProfiles(): AuthProfileStore {
  const fp = storePath();
  if (!existsSync(fp)) {
    return { version: 1, profiles: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(fp, "utf-8"));
    return raw as AuthProfileStore;
  } catch {
    return { version: 1, profiles: {} };
  }
}

export function saveProfiles(store: AuthProfileStore): void {
  ensureDir(saivageDir());
  writeFileSync(storePath(), JSON.stringify(store, null, 2) + "\n", "utf-8");
}

export function saveProfile(key: string, profile: AuthProfile): void {
  const store = loadProfiles();
  store.profiles[key] = profile;
  saveProfiles(store);
}

// --- Credential resolution (auto-refresh) ---

/**
 * Get a valid API key for the given OAuth provider.
 * Automatically refreshes expired tokens and persists updated credentials.
 * Returns null if no credentials exist for this provider.
 */
export async function getOAuthApiKey(providerId: string): Promise<string | null> {
  const provider = providers.get(providerId);
  if (!provider) return null;

  const store = loadProfiles();

  // Find first matching profile for this provider
  const entry = Object.entries(store.profiles).find(
    ([, p]) => p.provider === providerId,
  );
  if (!entry) return null;

  const [key, profile] = entry;

  // If not expired, return current access token
  if (Date.now() < profile.expires) {
    return provider.getApiKey(profile);
  }

  // Refresh
  log.info(`Refreshing OAuth token for ${providerId}...`);
  try {
    const refreshed = await provider.refreshToken(profile);
    const updated: AuthProfile = {
      ...profile,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
    };
    store.profiles[key] = updated;
    saveProfiles(store);
    log.info(`OAuth token refreshed for ${providerId}`);
    return provider.getApiKey(updated);
  } catch (err) {
    log.warn(
      `OAuth token refresh failed for ${providerId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Check if OAuth credentials exist for a provider (may be expired).
 */
export function hasOAuthCredentials(providerId: string): boolean {
  const store = loadProfiles();
  return Object.values(store.profiles).some((p) => p.provider === providerId);
}

/**
 * Map OAuth provider IDs to the Saivage provider names they authenticate.
 * openai-codex → openai (uses the same API with the access token)
 * anthropic → anthropic
 */
export function oauthToProviderName(oauthId: string): string {
  if (oauthId === "openai-codex") return "openai";
  if (oauthId === "github-copilot") return "copilot";
  return oauthId;
}
