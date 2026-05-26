/**
 * OAuth credential store.
 *
 * Persists auth profiles to <project>/.saivage/auth-profiles.json.
 * Supports login, token refresh, and API key retrieval.
 *
 * All filesystem access is asynchronous (G36). Concurrent writers
 * (multiple Saivage processes against the same bind-mounted
 * .saivage/) serialize through a lockfile next to the store; every
 * write reloads the on-disk state inside the critical section, so
 * there is no in-memory cache to drift from disk.
 */
import {
  readFile,
  rename,
  unlink,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
// Sync unlink is used only inside the process-exit handler below to
// release lockfiles this process still holds. The exit path cannot
// await; the inline disable carries that justification.
// eslint-disable-next-line no-restricted-imports
import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import { saivageDir } from "../config.js";
import { log } from "../log.js";
import { openaiCodexOAuthProvider } from "./openai-codex.js";
import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import type {
  AuthProfile,
  AuthProfileStore,
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

// --- Paths ---

function storePath(): string {
  return join(saivageDir(), "auth-profiles.json");
}

function lockPath(): string {
  return join(saivageDir(), "auth-profiles.json.lock");
}

// --- Exit-time lockfile cleanup ---

const heldLocks = new Set<string>();
let exitHandlersInstalled = false;

function installExitHandlers(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  const cleanup = (): void => {
    for (const path of heldLocks) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone or unwritable; nothing actionable on exit.
      }
    }
  };
  process.once("exit", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
}

function registerExitCleanup(path: string): void {
  installExitHandlers();
  heldLocks.add(path);
}

function unregisterExitCleanup(path: string): void {
  heldLocks.delete(path);
}

// --- Lock protocol ---

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_INITIAL_DELAY_MS = 10;
const LOCK_MAX_DELAY_MS = 1_000;
const LOCK_BACKOFF_MULT = 1.5;

interface LockMetadata {
  pid: number;
  hostname: string;
  startedAt: number;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return !!err && typeof err === "object" && (err as NodeJS.ErrnoException).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryReclaimStaleLock(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return false;
  }
  let meta: LockMetadata;
  try {
    meta = JSON.parse(raw) as LockMetadata;
  } catch {
    return false;
  }
  if (typeof meta.pid !== "number" || typeof meta.hostname !== "string") return false;
  if (meta.hostname !== hostname()) return false;
  // process.kill(pid, 0) probes liveness without sending a signal.
  // ESRCH ⇒ the holder is gone; reclaim by unlinking the lockfile.
  try {
    process.kill(meta.pid, 0);
    return false;
  } catch (err) {
    if (!isErrnoCode(err, "ESRCH")) return false;
  }
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function withProfilesLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = saivageDir();
  await mkdir(dir, { recursive: true });
  const path = lockPath();
  const startedWaiting = Date.now();
  let delay = LOCK_INITIAL_DELAY_MS;
  let handle: FileHandle | null = null;
  while (handle === null) {
    try {
      handle = await open(path, "wx", 0o600);
    } catch (err) {
      if (!isErrnoCode(err, "EEXIST")) throw err;
      if (await tryReclaimStaleLock(path)) continue;
      if (Date.now() - startedWaiting > LOCK_TIMEOUT_MS) {
        throw new Error(`[auth] timed out acquiring ${path}`);
      }
      await sleep(delay);
      delay = Math.min(Math.floor(delay * LOCK_BACKOFF_MULT), LOCK_MAX_DELAY_MS);
    }
  }
  try {
    const meta: LockMetadata = {
      pid: process.pid,
      hostname: hostname(),
      startedAt: Date.now(),
    };
    await handle.writeFile(JSON.stringify(meta), "utf-8");
  } finally {
    await handle.close();
  }
  registerExitCleanup(path);
  try {
    return await fn();
  } finally {
    try { await unlink(path); } catch { /* already gone */ }
    unregisterExitCleanup(path);
  }
}

// --- Atomic write ---

async function writeProfilesAtomically(store: AuthProfileStore): Promise<void> {
  const dir = saivageDir();
  await mkdir(dir, { recursive: true });
  const fp = storePath();
  const tmp = `${fp}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const payload = JSON.stringify(store, null, 2) + "\n";

  const handle = await open(tmp, "wx", 0o600);
  let wrote = false;
  try {
    await handle.writeFile(payload, "utf-8");
    try { await handle.sync(); } catch { /* fsync may fail on tmpfs / Windows */ }
    wrote = true;
  } finally {
    await handle.close();
    if (!wrote) {
      try { await unlink(tmp); } catch { /* tmp may not exist */ }
    }
  }

  try {
    await rename(tmp, fp);
  } catch (err) {
    try { await unlink(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }

  try {
    const dirHandle = await open(dirname(fp), "r");
    try { await dirHandle.sync(); } catch { /* not supported on every FS */ }
    finally { await dirHandle.close(); }
  } catch {
    // Some platforms (Windows) don't allow opening directories for fsync.
  }
}

// --- Read-modify-write helper ---

async function mutateProfiles(
  fn: (current: AuthProfileStore) => AuthProfileStore | Promise<AuthProfileStore>,
): Promise<void> {
  await withProfilesLock(async () => {
    const current = await loadProfilesUnlocked();
    const next = await fn(current);
    await writeProfilesAtomically(next);
  });
}

async function loadProfilesUnlocked(): Promise<AuthProfileStore> {
  const fp = storePath();
  let raw: string;
  try {
    raw = await readFile(fp, "utf-8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return { version: 1, profiles: {} };
    throw err;
  }
  try {
    return JSON.parse(raw) as AuthProfileStore;
  } catch {
    return { version: 1, profiles: {} };
  }
}

// --- Storage ---

export async function loadProfiles(): Promise<AuthProfileStore> {
  return loadProfilesUnlocked();
}

export async function saveProfiles(store: AuthProfileStore): Promise<void> {
  await mutateProfiles(() => store);
}

export async function saveProfile(key: string, profile: AuthProfile): Promise<void> {
  await mutateProfiles((s) => {
    s.profiles[key] = profile;
    return s;
  });
}

export async function removeProfiles(
  predicate: (key: string, profile: AuthProfile) => boolean,
): Promise<number> {
  let removed = 0;
  await mutateProfiles((s) => {
    for (const [k, p] of Object.entries(s.profiles)) {
      if (predicate(k, p)) {
        delete s.profiles[k];
        removed += 1;
      }
    }
    return s;
  });
  return removed;
}

export async function getProfileByKey(profileKey: string): Promise<AuthProfile | null> {
  const store = await loadProfiles();
  return store.profiles[profileKey] ?? null;
}

// --- Credential resolution (auto-refresh) ---

/**
 * Get a valid API key for the given OAuth provider.
 * Automatically refreshes expired tokens and persists updated credentials.
 * Returns null if no credentials exist for this provider.
 */
export async function getOAuthApiKey(
  providerId: string,
  options: { profileKey?: string; headers?: Record<string, string> } = {},
): Promise<string | null> {
  const provider = providers.get(providerId);
  if (!provider) return null;

  const store = await loadProfiles();

  const entry = options.profileKey
    ? resolveProfileEntry(store, providerId, options.profileKey)
    : Object.entries(store.profiles).find(([, p]) => p.provider === providerId);
  if (!entry) return null;

  const [key, profile] = entry;

  // If not expired, return current access token
  if (Date.now() < profile.expires) {
    return provider.getApiKey(profile);
  }

  // Refresh
  log.info(`Refreshing OAuth token for ${providerId}...`);
  try {
    const refreshed = await provider.refreshToken(profile, { headers: options.headers });
    // Reload under the lock so a concurrent login/refresh on another
    // profile (or another process) is not lost.
    await mutateProfiles((latest) => {
      const cur = latest.profiles[key];
      if (!cur) return latest;
      latest.profiles[key] = {
        ...cur,
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      };
      return latest;
    });
    log.info(`OAuth token refreshed for ${providerId}`);
    return provider.getApiKey({
      ...profile,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
    });
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
export async function hasOAuthCredentials(providerId: string): Promise<boolean> {
  const store = await loadProfiles();
  return Object.values(store.profiles).some((p) => p.provider === providerId);
}

export async function hasOAuthProfile(profileKey: string, providerId?: string): Promise<boolean> {
  const profile = await getProfileByKey(profileKey);
  if (!profile) return false;
  return providerId ? profile.provider === providerId : true;
}

function resolveProfileEntry(
  store: AuthProfileStore,
  providerId: string,
  profileKey: string,
): [string, AuthProfile] | undefined {
  const profile = store.profiles[profileKey];
  if (!profile || profile.provider !== providerId) return undefined;
  return [profileKey, profile];
}
