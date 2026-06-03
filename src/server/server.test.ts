import { describe, it, expect, afterEach } from "vitest";
import {
  isPathHiddenForFileRoot,
  isPathInside,
  safeConfigResponse,
  safeDebugStateResponse,
  safeProvidersResponse,
} from "./server.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

function containsKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((nested) => containsKey(nested, key));
}

describe("isPathInside", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      const path = created.pop();
      if (path) rmSync(path, { recursive: true, force: true });
    }
  });

  it("treats the base directory itself as inside", () => {
    const base = mkdtempSync(join(tmpdir(), "saivage-pathcheck-"));
    created.push(base);
    expect(isPathInside(base, base)).toBe(true);
  });

  it("accepts proper descendants", () => {
    const base = mkdtempSync(join(tmpdir(), "saivage-pathcheck-"));
    created.push(base);
    expect(isPathInside(base, join(base, "a"))).toBe(true);
    expect(isPathInside(base, join(base, "a", "b", "c.txt"))).toBe(true);
  });

  it("rejects sibling paths whose name shares a prefix", () => {
    const base = mkdtempSync(join(tmpdir(), "saivage-pathcheck-"));
    created.push(base);
    // Sibling that startsWith() would falsely accept.
    expect(isPathInside(base, `${base}x`)).toBe(false);
    expect(isPathInside(base, `${base}-attack/file`)).toBe(false);
  });

  it("rejects parent traversal", () => {
    const base = mkdtempSync(join(tmpdir(), "saivage-pathcheck-"));
    created.push(base);
    expect(isPathInside(base, join(base, ".."))).toBe(false);
    expect(isPathInside(base, join(base, "..", "etc", "passwd"))).toBe(false);
  });
});

describe("safe API response shapes", () => {
  const route = {
    role: "planner",
    modelSpec: "github-copilot/gpt-5.4",
    provider: "github-copilot",
    model: "gpt-5.4",
    authProfile: "work-profile",
    accountRef: "github-copilot.work",
    preferredModels: ["github-copilot/gpt-5.4"],
    preferredAccounts: ["github-copilot.work"],
    source: "routing" as const,
    profileName: "work",
  };

  const projectConfig = {
    project_name: "fixture",
    objectives: ["keep secrets out of API responses"],
    routing: {
      roles: {
        planner: { auth_profile: "work-profile", account: "github-copilot.work" },
      },
    },
    skills: { max_per_agent: 5 },
    agents: {
      planner: { compaction_threshold_pct: 80, max_compactions: 3 },
    },
  };

  it("omits auth profiles and account refs from /api/config shape", () => {
    const response = safeConfigResponse({
      project: {
        config: projectConfig,
        projectRoot: "/work/project",
        saivageDir: "/work/project/.saivage",
      },
      routing: {
        resolve: (role: string) => ({ ...route, role }),
      },
    } as never);

    expect(response).toEqual({
      project_name: "fixture",
      objectives: ["keep secrets out of API responses"],
      skills: { max_per_agent: 5 },
      agents: { planner: { compaction_threshold_pct: 80, max_compactions: 3 } },
      project_root: "/work/project",
      saivage_dir: "/work/project/.saivage",
      provider: "github-copilot/gpt-5.4",
      routing: {
        planner: {
          role: "planner",
          modelSpec: "github-copilot/gpt-5.4",
          provider: "github-copilot",
          model: "gpt-5.4",
          preferredModels: ["github-copilot/gpt-5.4"],
          source: "routing",
        },
        chat: {
          role: "chat",
          modelSpec: "github-copilot/gpt-5.4",
          provider: "github-copilot",
          model: "gpt-5.4",
          preferredModels: ["github-copilot/gpt-5.4"],
          source: "routing",
        },
      },
    });
    expect(containsKey(response, "authProfile")).toBe(false);
    expect(containsKey(response, "auth_profile")).toBe(false);
    expect(containsKey(response, "accountRef")).toBe(false);
    expect(containsKey(response, "preferredAccounts")).toBe(false);
    expect(containsKey(response, "profileName")).toBe(false);
    expect(containsKey(response, "account")).toBe(false);
    expect(containsKey(response, "routing")).toBe(true);
  });

  it("omits raw project routing and runtime config from /api/debug/state shape", () => {
    const response = safeDebugStateResponse({
      runtimeState: { status: "idle", pid: 1234 },
      planDoc: null,
      projectConfig,
    } as never);

    expect(response).toEqual({
      runtime: { status: "idle", pid: 1234 },
      plan: null,
      history: null,
      config: {
        project_name: "fixture",
        objectives: ["keep secrets out of API responses"],
        skills: { max_per_agent: 5 },
        agents: { planner: { compaction_threshold_pct: 80, max_compactions: 3 } },
      },
    });
    expect(containsKey(response, "saivage_config")).toBe(false);
    expect(containsKey(response, "routing")).toBe(false);
    expect(containsKey(response, "auth_profile")).toBe(false);
    expect(containsKey(response, "account")).toBe(false);
  });

  it("keeps /api/providers to provider/model metadata and generic availability", async () => {
    const response = await safeProvidersResponse({
      listProviders: () => ["ok", "broken"],
      listModels: async (name: string) => {
        if (name === "broken") {
          throw new Error("failed for https://token@example.invalid with auth profile secret-profile");
        }
        return ["model-a", "model-b"];
      },
    } as never);

    expect(response).toEqual({
      providers: [
        { name: "ok", models: ["model-a", "model-b"] },
        { name: "broken", models: [], unavailable: true },
      ],
    });
    expect(JSON.stringify(response)).not.toContain("token@example");
    expect(JSON.stringify(response)).not.toContain("secret-profile");
    expect(containsKey(response, "error")).toBe(false);
    expect(containsKey(response, "authProfile")).toBe(false);
    expect(containsKey(response, "accountRef")).toBe(false);
  });
});

describe("isPathHiddenForFileRoot", () => {
  it("hides known sensitive files from both file roots", () => {
    for (const root of ["project", "saivage"] as const) {
      expect(isPathHiddenForFileRoot(root, "auth-profiles.json")).toBe(true);
      expect(isPathHiddenForFileRoot(root, "saivage.json")).toBe(true);
      expect(isPathHiddenForFileRoot(root, ".env")).toBe(true);
      expect(isPathHiddenForFileRoot(root, ".env.local")).toBe(true);
      expect(isPathHiddenForFileRoot(root, "keys/id_rsa.pem")).toBe(true);
      expect(isPathHiddenForFileRoot(root, "keys/service.key")).toBe(true);
      expect(isPathHiddenForFileRoot(root, "secrets/token.txt")).toBe(true);
      expect(isPathHiddenForFileRoot(root, "backups/config.json")).toBe(true);
    }
  });

  it("hides project-only heavy roots without hiding ordinary files", () => {
    expect(isPathHiddenForFileRoot("project", ".saivage/config.json")).toBe(true);
    expect(isPathHiddenForFileRoot("project", "dist/index.js")).toBe(true);
    expect(isPathHiddenForFileRoot("project", "build/output.js")).toBe(true);
    expect(isPathHiddenForFileRoot("saivage", "dist/index.js")).toBe(false);
    expect(isPathHiddenForFileRoot("project", "docs/guide/providers.md")).toBe(false);
    expect(isPathHiddenForFileRoot("saivage", "plan.json")).toBe(false);
  });
});
