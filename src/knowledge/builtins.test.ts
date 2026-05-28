import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProjectTree } from "../store/project.js";
import { openSidecar } from "./sidecar.js";
import { upsertBuiltinSkills, defaultBuiltinSkillsRoot, nfcLower } from "./builtins.js";
import { KnowledgeStoreError } from "./store.js";
import type { KnowledgeStore } from "./init.js";

interface TestStore extends KnowledgeStore {
  reingestCalls: number;
}

function makeFixtureSkill(root: string, topic: string, frontmatter: string, body: string): void {
  const dir = join(root, topic);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf-8");
}

async function makeStore(projectRoot: string): Promise<TestStore> {
  const sidecar = await openSidecar(projectRoot);
  const wrapper = {
    sidecar,
    ragManager: {} as KnowledgeStore["ragManager"],
    ragDatasets: [] as KnowledgeStore["ragDatasets"],
    projectRoot,
    reingestCalls: 0,
    reingestKind: vi.fn(),
  } as unknown as TestStore;
  wrapper.reingestKind = vi.fn(async () => {
    wrapper.reingestCalls += 1;
  });
  return wrapper;
}

describe("upsertBuiltinSkills", () => {
  let projectRoot: string;
  let store: TestStore;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "builtins-"));
    await initProjectTree(projectRoot);
    store = await makeStore(projectRoot);
  });
  afterEach(() => {
    store.sidecar.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns 0 and is a no-op when the builtin root does not exist", async () => {
    const result = await upsertBuiltinSkills(store, join(projectRoot, "nope"));
    expect(result).toEqual({ upserted: 0 });
    const rows = store.sidecar.db.prepare("SELECT COUNT(*) AS c FROM record").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it("upserts every SKILL.md as origin=builtin with the canonical id and is idempotent", async () => {
    const builtin = join(projectRoot, "fixtures");
    makeFixtureSkill(
      builtin,
      "alpha",
      [
        "name: alpha",
        "description: first",
        "triggers: [agent:coder]",
        "target_agents: [coder]",
        "survive_compaction: false",
      ].join("\n"),
      "Alpha body.",
    );
    makeFixtureSkill(
      builtin,
      "beta",
      [
        "name: BETA",
        "description: second",
        "triggers: [agent:reviewer]",
        "target_agents: [reviewer]",
        "survive_compaction: true",
      ].join("\n"),
      "Beta body.",
    );

    const r1 = await upsertBuiltinSkills(store, builtin);
    expect(r1.upserted).toBe(2);
    expect(store.reingestCalls).toBe(1);

    const ids = (store.sidecar.db
      .prepare("SELECT id FROM record WHERE origin = 'builtin' ORDER BY id")
      .all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["builtin:alpha", "builtin:beta"]);

    const alpha = store.sidecar.db
      .prepare("SELECT body, pending_reingest FROM record WHERE id = 'builtin:alpha'")
      .get() as { body: string; pending_reingest: number };
    expect(alpha.body).toBe("Alpha body.");
    expect(alpha.pending_reingest).toBe(1);

    const skillRow = store.sidecar.db
      .prepare("SELECT name FROM record_skill WHERE id = 'builtin:beta'")
      .get() as { name: string };
    expect(skillRow.name).toBe("BETA");

    const r2 = await upsertBuiltinSkills(store, builtin);
    expect(r2.upserted).toBe(2);
    const count = (store.sidecar.db
      .prepare("SELECT COUNT(*) AS c FROM record WHERE origin = 'builtin'")
      .get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it("rejects names that fail the slug regex", async () => {
    const builtin = join(projectRoot, "bad-slug");
    makeFixtureSkill(
      builtin,
      "topic",
      [
        "name: 'has space'",
        "description: bad",
        "triggers: []",
        "target_agents: [coder]",
        "survive_compaction: false",
      ].join("\n"),
      "body",
    );
    await expect(upsertBuiltinSkills(store, builtin)).rejects.toBeInstanceOf(KnowledgeStoreError);
    await expect(upsertBuiltinSkills(store, builtin)).rejects.toMatchObject({
      code: "INVALID_BUILTIN_NAME",
    });
  });

  it("rejects NFC-lower collisions across two SKILL.md files", async () => {
    const builtin = join(projectRoot, "collisions");
    makeFixtureSkill(
      builtin,
      "one",
      [
        "name: Alpha",
        "description: first",
        "triggers: []",
        "target_agents: [coder]",
        "survive_compaction: false",
      ].join("\n"),
      "body 1",
    );
    makeFixtureSkill(
      builtin,
      "two",
      [
        "name: alpha",
        "description: second",
        "triggers: []",
        "target_agents: [coder]",
        "survive_compaction: false",
      ].join("\n"),
      "body 2",
    );
    await expect(upsertBuiltinSkills(store, builtin)).rejects.toMatchObject({
      code: "INVALID_BUILTIN_NAME",
    });
  });

  it("nfcLower normalises before lowercasing", () => {
    expect(nfcLower("CAFÉ")).toBe("café");
    expect(nfcLower("alpha")).toBe("alpha");
  });

  it("picks up the bundled <bundle>/skills/builtin tree by default", async () => {
    const result = await upsertBuiltinSkills(store, defaultBuiltinSkillsRoot());
    expect(result.upserted).toBeGreaterThan(0);
    const ids = (store.sidecar.db
      .prepare("SELECT id FROM record WHERE origin = 'builtin' ORDER BY id")
      .all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("builtin:coding");
  });
});
