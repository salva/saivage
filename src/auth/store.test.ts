import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, platform, hostname } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanForSyncFs } from "../testing/noSyncFsScanner.js";

const FIXTURE_PATH = fileURLToPath(new URL("./__fixtures__/concurrent-writer.ts", import.meta.url));

interface Env {
  projectRoot: string;
  saivageDir: string;
  storePath: string;
  lockPath: string;
}

async function setupEnv(): Promise<Env> {
  const projectRoot = await mkdtemp(join(tmpdir(), "saivage-authstore-"));
  const saivageDir = join(projectRoot, ".saivage");
  await mkdir(saivageDir, { recursive: true });
  process.env["SAIVAGE_ROOT"] = saivageDir;
  return {
    projectRoot,
    saivageDir,
    storePath: join(saivageDir, "auth-profiles.json"),
    lockPath: join(saivageDir, "auth-profiles.json.lock"),
  };
}

async function cleanupEnv(env: Env): Promise<void> {
  delete process.env["SAIVAGE_ROOT"];
  await rm(env.projectRoot, { recursive: true, force: true });
}

function runWriter(env: Env, key: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = fork(FIXTURE_PATH, [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        SAIVAGE_ROOT: env.saivageDir,
        SAIVAGE_TARGET_KEY: key,
        SAIVAGE_TARGET_BODY_BASE64: Buffer.from(JSON.stringify(body), "utf-8").toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`writer exited with ${code}: ${stderr}`));
      else resolve(code ?? 0);
    });
  });
}

describe("G36: auth profile store async-fs", () => {
  let env: Env;

  beforeEach(async () => {
    env = await setupEnv();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await cleanupEnv(env);
  });

  it("case 1: saveProfile writes 0o600 file via async fs", async () => {
    const { saveProfile, loadProfiles } = await import("./store.js");
    await saveProfile("anthropic.main", {
      type: "oauth",
      provider: "anthropic",
      access: "secret",
      refresh: "refresh",
      expires: Date.now() + 60_000,
    });

    if (platform() !== "win32") {
      const st = await stat(env.storePath);
      expect(st.mode & 0o777).toBe(0o600);
    }
    expect((await readFile(env.storePath, "utf-8")).includes("anthropic.main")).toBe(true);
    const round = await loadProfiles();
    expect(round.profiles["anthropic.main"]).toBeDefined();
  });

  it("case 2: cross-process writes serialize through the lockfile (last-write-wins by key)", async () => {
    // Two writers with different keys both survive because mutateProfiles
    // reloads inside the critical section.
    await Promise.all([
      runWriter(env, "anthropic.main", {
        type: "oauth", provider: "anthropic", access: "tokA",
        refresh: "r", expires: Date.now() + 60_000,
      }),
      runWriter(env, "openai-codex.main", {
        type: "oauth", provider: "openai-codex", access: "tokB",
        refresh: "r", expires: Date.now() + 60_000,
      }),
    ]);
    const { loadProfiles } = await import("./store.js");
    const store = await loadProfiles();
    expect(store.profiles["anthropic.main"]).toBeDefined();
    expect(store.profiles["openai-codex.main"]).toBeDefined();
  });

  it("case 3: a cross-process write performed while another is mid-flight is not lost", async () => {
    // Start three writers concurrently against three different keys.
    await Promise.all([
      runWriter(env, "p1", { type: "oauth", provider: "anthropic", access: "1",
        refresh: "r", expires: Date.now() + 60_000 }),
      runWriter(env, "p2", { type: "oauth", provider: "anthropic", access: "2",
        refresh: "r", expires: Date.now() + 60_000 }),
      runWriter(env, "p3", { type: "oauth", provider: "anthropic", access: "3",
        refresh: "r", expires: Date.now() + 60_000 }),
    ]);
    const { loadProfiles } = await import("./store.js");
    const store = await loadProfiles();
    expect(Object.keys(store.profiles).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("case 4: writeFile failure inside the atomic write surfaces and leaves no tmp", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        open: async (path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1], mode?: Parameters<typeof actual.open>[2]) => {
          const handle = await actual.open(path, flags, mode);
          if (typeof path === "string" && path.endsWith(".tmp")) {
            handle.writeFile = (async () => { throw new Error("disk full"); }) as typeof handle.writeFile;
          }
          return handle;
        },
      };
    });
    const { saveProfile } = await import("./store.js");
    await expect(saveProfile("k", {
      type: "oauth", provider: "anthropic", access: "x",
      refresh: "r", expires: Date.now() + 60_000,
    })).rejects.toThrow(/disk full/);
    vi.doUnmock("node:fs/promises");
    const fsp = await import("node:fs/promises");
    const entries = await fsp.readdir(env.saivageDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    await expect(stat(env.storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("case 5: rename failure surfaces and leaves no tmp", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rename: async () => {
          throw Object.assign(new Error("EXDEV cross-device link"), { code: "EXDEV" });
        },
      };
    });
    const { saveProfile } = await import("./store.js");
    await expect(saveProfile("k", {
      type: "oauth", provider: "anthropic", access: "x",
      refresh: "r", expires: Date.now() + 60_000,
    })).rejects.toThrow(/EXDEV/);
    vi.doUnmock("node:fs/promises");
    const fsp = await import("node:fs/promises");
    const entries = await fsp.readdir(env.saivageDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("case 6: stale lockfile from a dead PID on this host is reclaimed", async () => {
    // Plant a lockfile with a PID that cannot exist on this host.
    // 0x7fffffff is well above the platform max; process.kill(_, 0) will ESRCH.
    const deadPid = 0x7fffffff;
    await writeFile(env.lockPath, JSON.stringify({
      pid: deadPid,
      hostname: hostname(),
      startedAt: Date.now() - 60_000,
    }), { mode: 0o600 });
    const { saveProfile, loadProfiles } = await import("./store.js");
    await saveProfile("k", {
      type: "oauth", provider: "anthropic", access: "x",
      refresh: "r", expires: Date.now() + 60_000,
    });
    const s = await loadProfiles();
    expect(s.profiles["k"]).toBeDefined();
    // Lockfile gone after the write completes.
    await expect(stat(env.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("case 7: loadProfiles on empty .saivage returns the empty store shape", async () => {
    const { loadProfiles } = await import("./store.js");
    const s = await loadProfiles();
    expect(s).toEqual({ version: 1, profiles: {} });
  });

  it("case 8: scanForSyncFs reports no violations in src/auth/", async () => {
    const violations = await scanForSyncFs({
      roots: ["src/auth"],
      // The exit-handler unlinkSync is the only documented sync call.
      allowedNamedImports: ["createWriteStream", "unlinkSync"],
      allowedSyncCalls: ["unlinkSync"],
    });
    expect(violations).toEqual([]);
  });
});
