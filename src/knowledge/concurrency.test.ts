/**
 * Saivage — concurrency tests on the SQLite sidecar (F01 B04 variant of WI-19).
 *
 * Covers FR-29, FR-31g, §C.1 / §G.5 lifecycle serialisation guarantees.
 * Under the sidecar, scope-uniqueness checks + writes share a single
 * better-sqlite3 transaction, so we no longer maintain explicit
 * per-scope in-process queues. Tests now inspect the sidecar directly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initProjectTree } from "../store/project.js";
import { acquireRuntimeLock, type RuntimeLock } from "../runtime/recovery.js";
import {
  createSkill,
  createMemory,
  updateMemory,
  supersedeSkill,
  supersedeMemory,
  getMemory,
  type AuthorAgent,
} from "./lifecycle.js";
import { makeTestStore } from "./_testfixtures/store.js";
import { activeRecordsByScope, getRecord } from "./sidecar-queries.js";
import type { KnowledgeStore } from "./init.js";

const AUTHOR: AuthorAgent = { role: "manager", agent_id: "agent-conc" };

let projectRoot: string;
let saivage: string;
let runtimeLock: RuntimeLock | null;
let store: KnowledgeStore;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-conc-"));
  await initProjectTree(projectRoot);
  saivage = join(projectRoot, ".saivage");
  runtimeLock = await acquireRuntimeLock(saivage);
  store = await makeTestStore(projectRoot);
});
afterEach(() => {
  store?.sidecar.close();
  runtimeLock?.release();
  runtimeLock = null;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("parallel lifecycle writes — same scope", () => {
  it("parallel createSkill with duplicate names → exactly one wins", async () => {
    const calls = await Promise.allSettled([
      createSkill(
        store,
        { name: "dup", description: "d", body: "body-a", scope: "project", reason: "race-a" },
        AUTHOR,
      ),
      createSkill(
        store,
        { name: "dup", description: "d", body: "body-b", scope: "project", reason: "race-b" },
        AUTHOR,
      ),
    ]);
    const winners = calls.filter((r): r is PromiseFulfilledResult<{ id: string; status: "active" }> => r.status === "fulfilled");
    const losers = calls.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0].reason as { code?: string }).code).toBe("NAME_COLLISION");

    const active = activeRecordsByScope(store.sidecar, "skill", "project");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(winners[0].value.id);
  });

  it("parallel createMemory with duplicate topics → exactly one wins", async () => {
    const calls = await Promise.allSettled([
      createMemory(
        store,
        { topic: { domain: "dup", subject: "topic" }, body: "body-a", scope: "project", reason: "race-a" },
        AUTHOR,
      ),
      createMemory(
        store,
        { topic: { domain: "dup", subject: "topic" }, body: "body-b", scope: "project", reason: "race-b" },
        AUTHOR,
      ),
    ]);
    const winners = calls.filter((r): r is PromiseFulfilledResult<{ id: string; status: "active" }> => r.status === "fulfilled");
    const losers = calls.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0].reason as { code?: string }).code).toBe("TOPIC_COLLISION");
  });

  it("a rejected holder does not poison the scope lifecycle queue", async () => {
    await expect(
      createSkill(
        store,
        { name: "bad", description: "d", body: ".env", scope: "project", reason: "blocked" },
        AUTHOR,
      ),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });

    await expect(
      createSkill(
        store,
        { name: "good", description: "d", body: "safe body", scope: "project", reason: "ok" },
        AUTHOR,
      ),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("parallel createMemory with distinct topics → both end up in the sidecar", async () => {
    const N = 8;
    const promises = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        createMemory(
          store,
          {
            topic: { domain: "d", subject: "s" + i },
            body: "body-" + i,
            scope: "project",
            reason: "parallel create",
          },
          AUTHOR,
        ),
      ),
    );
    const created = await Promise.all(promises);
    expect(new Set(created.map((m) => m.id)).size).toBe(N);

    const active = activeRecordsByScope(store.sidecar, "memory", "project");
    const ids = new Set(active.map((r) => r.id));
    for (const c of created) expect(ids.has(c.id)).toBe(true);
  });

  it("parallel updateMemory of same id is serialized; final state is one of the arrivals", async () => {
    const mem = await createMemory(
      store,
      {
        topic: { domain: "x", subject: "y" },
        body: "v0",
        scope: "project",
        reason: "seed",
      },
      AUTHOR,
    );

    const bodies = ["A", "B", "C", "D"];
    const results = await Promise.all(
      bodies.map((b) =>
        Promise.resolve().then(() =>
          updateMemory(store, { id: mem.id, body: b, reason: "update-" + b }, AUTHOR),
        ),
      ),
    );
    expect(results.length).toBe(4);
    const final = await getMemory(store, { id: mem.id });
    expect(final).not.toBeNull();
    expect(bodies).toContain(final?.body);
  });
});

describe("supersedeMemory — two-key atomicity & chain repair", () => {
  it("after supersede, getMemory(OLD) walks chain to NEW", async () => {
    const v1 = await createMemory(
      store,
      { topic: { domain: "d", subject: "s" }, body: "v1", scope: "project", reason: "init" },
      AUTHOR,
    );
    const r = await supersedeMemory(
      store,
      {
        old_id: v1.id,
        new_record: {
          topic: { domain: "d", subject: "s" },
          body: "v2",
          scope: "project",
        },
        reason: "promote",
      },
      AUTHOR,
    );
    const walked = await getMemory(store, { id: v1.id });
    expect(walked?.id).toBe(r.new_id);
    expect(walked?.body).toBe("v2");
  });

  it("parallel supersedeSkill of the SAME old id → exactly one wins", async () => {
    const old = await createSkill(
      store,
      { name: "old-skill", description: "d", body: "v1", scope: "project", reason: "init" },
      AUTHOR,
    );

    const calls = await Promise.allSettled(
      ["a", "b"].map((tag) =>
        supersedeSkill(
          store,
          {
            old_id: old.id,
            new_record: {
              name: "new-skill-" + tag,
              description: "d",
              body: "v2-" + tag,
              scope: "project",
              reason: "new-" + tag,
            },
            reason: "supersede-" + tag,
          },
          AUTHOR,
        ),
      ),
    );
    const winners = calls.filter((r): r is PromiseFulfilledResult<{ new_id: string; old_id: string }> => r.status === "fulfilled");
    const losers = calls.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0].reason as { code?: string }).code).toBe("INVALID_SUPERSEDE_TARGET");

    const oldRow = getRecord(store.sidecar, old.id);
    expect(oldRow?.superseded_by).toBe(winners[0].value.new_id);
  });

  it("parallel supersede of the SAME old id → exactly one wins, other fails INVALID_SUPERSEDE_TARGET", async () => {
    const v1 = await createMemory(
      store,
      { topic: { domain: "z", subject: "y" }, body: "v1", scope: "project", reason: "init" },
      AUTHOR,
    );

    const winners: { ok: true; new_id: string }[] = [];
    const losers: { ok: false; code: string }[] = [];
    await Promise.all(
      ["a", "b", "c"].map((tag) =>
        Promise.resolve()
          .then(() =>
            supersedeMemory(
              store,
              {
                old_id: v1.id,
                new_record: {
                  topic: { domain: "z", subject: "y" },
                  body: "v2-" + tag,
                  scope: "project",
                },
                reason: "race-" + tag,
              },
              AUTHOR,
            ),
          )
          .then((r) => winners.push({ ok: true, new_id: r.new_id }))
          .catch((e: Error & { code?: string }) => losers.push({ ok: false, code: e.code ?? "?" })),
      ),
    );
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(2);
    for (const l of losers) expect(l.code).toBe("INVALID_SUPERSEDE_TARGET");
  });
});
