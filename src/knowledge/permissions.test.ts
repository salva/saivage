import { describe, expect, it } from "vitest";
import type { KnowledgeAgentRole } from "./types.js";
import { canCall, checkScope, type KnowledgeKind, type KnowledgeOp } from "./permissions.js";

const ROLES: KnowledgeAgentRole[] = [
  "planner",
  "manager",
  "coder",
  "researcher",
  "data_agent",
  "inspector",
  "reviewer",
  "designer",
  "chat",
];

/**
 * Source-of-truth matrix mirroring SPEC §F. Cells: "Y", "Y†" (worker
 * scope restriction), or "-" (denied). Tests enumerate every cell.
 */
const EXPECTED: Record<KnowledgeAgentRole, Record<string, "Y" | "Y†" | "-">> = {
  planner: {
    "create-skill": "-",
    "create-memory": "Y",
    "supersede-skill": "-",
    "supersede-memory": "Y",
    "archive-skill": "-",
    "archive-memory": "Y",
    "read-skill": "Y",
    "read-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  manager: {
    "create-skill": "Y",
    "create-memory": "Y",
    "supersede-skill": "Y",
    "supersede-memory": "Y",
    "archive-skill": "Y",
    "archive-memory": "Y",
    "read-skill": "Y",
    "read-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  coder: {
    "create-skill": "-",
    "create-memory": "Y†",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  researcher: {
    "create-skill": "-",
    "create-memory": "Y†",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  data_agent: {
    "create-skill": "-",
    "create-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "read-skill": "Y",
    "read-memory": "-",
    "search-skill": "Y",
    "search-memory": "-",
  },
  inspector: {
    "create-skill": "-",
    "create-memory": "Y",
    "supersede-skill": "Y",
    "supersede-memory": "Y",
    "archive-skill": "Y",
    "archive-memory": "Y",
    "read-skill": "Y",
    "read-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  reviewer: {
    "create-skill": "-",
    "create-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  designer: {
    "create-skill": "-",
    "create-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
  chat: {
    "create-skill": "-",
    "create-memory": "-",
    "supersede-skill": "-",
    "supersede-memory": "-",
    "archive-skill": "-",
    "archive-memory": "-",
    "read-skill": "Y",
    "read-memory": "Y",
    "search-skill": "Y",
    "search-memory": "Y",
  },
};

describe("canCall — full §F matrix", () => {
  for (const role of ROLES) {
    for (const [cellKey, expected] of Object.entries(EXPECTED[role])) {
      const [opStr, kindStr] = cellKey.split("-");
      const op = opStr as KnowledgeOp;
      const kind = kindStr as KnowledgeKind;
      const allowed = expected !== "-";
      it(`${role} / ${op}-${kind} → ${allowed ? "allowed" : "denied"}`, () => {
        expect(canCall(role, op, kind)).toBe(allowed);
      });
    }
  }
});

describe("canCall — derived ops", () => {
  it("update follows create", () => {
    expect(canCall("coder", "update", "memory")).toBe(true);
    expect(canCall("coder", "update", "skill")).toBe(false);
    expect(canCall("manager", "update", "skill")).toBe(true);
  });

  it("delete follows archive", () => {
    expect(canCall("inspector", "delete", "skill")).toBe(true);
    expect(canCall("planner", "delete", "skill")).toBe(false);
    expect(canCall("coder", "delete", "memory")).toBe(false);
  });

  it("list follows read", () => {
    expect(canCall("data_agent", "list", "skill")).toBe(true);
    expect(canCall("data_agent", "list", "memory")).toBe(false);
  });
});

describe("checkScope — Y† worker scope restriction", () => {
  const stageId = "stg-1";

  it.each(["coder", "researcher"] as const)("%s create_memory(stage,curr) is allowed", (role) => {
    const r = checkScope(role, "create", "memory", "stage", stageId, { stageId });
    expect(r.ok).toBe(true);
  });

  it.each(["coder", "researcher"] as const)("%s create_memory(project) is rejected", (role) => {
    const r = checkScope(role, "create", "memory", "project", undefined, { stageId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNAUTHORIZED_SCOPE");
  });

  it.each(["coder", "researcher"] as const)("%s create_memory(stage,other-stage) is rejected", (role) => {
    const r = checkScope(role, "create", "memory", "stage", "stg-other", { stageId });
    expect(r.ok).toBe(false);
  });

  it("worker without active stage ctx is rejected for stage write", () => {
    const r = checkScope("coder", "create", "memory", "stage", "stg-1", {});
    expect(r.ok).toBe(false);
  });

  it("update_memory inherits Y† restriction", () => {
    expect(checkScope("coder", "update", "memory", "project", undefined, { stageId }).ok).toBe(false);
    expect(checkScope("coder", "update", "memory", "stage", stageId, { stageId }).ok).toBe(true);
  });

  it("non-worker Y cells are unrestricted", () => {
    expect(checkScope("manager", "create", "memory", "project", undefined, {}).ok).toBe(true);
    expect(checkScope("planner", "create", "memory", "project", undefined, {}).ok).toBe(true);
    expect(checkScope("inspector", "supersede", "memory", "project", undefined, {}).ok).toBe(true);
  });

  it("read/list/search are always unrestricted when allowed", () => {
    expect(checkScope("data_agent", "read", "skill", "project", undefined, {}).ok).toBe(true);
    expect(checkScope("chat", "search", "memory", "stage", "x", {}).ok).toBe(true);
  });
});
