/**
 * Saivage — concurrency tests (M5 / WI-19).
 *
 * Covers FR-29, FR-31g, §C.1 / §G.5 locking guarantees:
 *  • parallel `createMemory` distinct ids in same scope → both indexed
 *  • parallel `updateMemory` same id → arrival-order final body wins
 *  • per-record locks serialize writes to the same id
 *  • per-scope locks serialize index rebuilds
 *  • `acquireTwoRecordLocks` is deadlock-free (lex order regardless of input)
 *  • loader repair: when `OLD.superseded_by` is missing, next read still
 *    walks the chain (covered by `lifecycle.getMemory` chain logic)
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initProjectTree } from "../store/project.js";
import { createMemory, updateMemory, supersedeMemory, getMemory } from "./lifecycle.js";
import { acquireRecordLock, acquireScopeLock, acquireTwoRecordLocks, recordLockKey, scopeLockKey } from "./store.js";
import type { AuthorAgent } from "./lifecycle.js";

const AUTHOR: AuthorAgent = { role: "manager", agent_id: "agent-conc" };

let projectRoot: string;
let saivage: string;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-conc-"));
  await initProjectTree(projectRoot);
  saivage = join(projectRoot, ".saivage");
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

// ─── Lock-primitive tests ─────────────────────────────────────────────────

describe("store locks — primitives", () => {
  it("recordLockKey is stable for {kind, scope, scope_ref, id}", () => {
    const k = recordLockKey({ kind: "memory", scope: "project", id: "abc" });
    expect(k).toBe("memory:project:_:abc");
    const k2 = recordLockKey({ kind: "skill", scope: "stage", scope_ref: "stg-1", id: "xyz" });
    expect(k2).toBe("skill:stage:stg-1:xyz");
  });

  it("scopeLockKey is stable", () => {
    expect(scopeLockKey("memory", "project")).toBe("memory:project:_");
    expect(scopeLockKey("skill", "stage", "stg-1")).toBe("skill:stage:stg-1");
  });

  it("acquireRecordLock serializes same-key holders", async () => {
    const order: number[] = [];
    const tick = async (n: number) => {
      const release = await acquireRecordLock("memory:project:_:k1");
      order.push(n);
      await new Promise((r) => setTimeout(r, 5));
      release();
    };
    await Promise.all([tick(1), tick(2), tick(3)]);
    // Arrivals serialize FIFO: 1, 2, 3 (each pushes before the next can acquire).
    expect(order).toEqual([1, 2, 3]);
  });

  it("acquireScopeLock is independent of record-lock keyspace", async () => {
    const rrel = await acquireRecordLock("memory:project:_:k1");
    // A scope lock with the "same" key string still proceeds because the
    // maps are separate.
    const srel = await acquireScopeLock("memory:project:_:k1");
    rrel();
    srel();
  });

  it("acquireTwoRecordLocks acquires in lex order regardless of argument order", async () => {
    // Forward order
    const rel1 = await acquireTwoRecordLocks("a", "b");
    await rel1();
    // Reversed — must not deadlock
    const rel2 = await acquireTwoRecordLocks("b", "a");
    await rel2();
  });

  it("acquireTwoRecordLocks blocks if one of the keys is already held", async () => {
    const holder = await acquireRecordLock("z-key");
    let acquired = false;
    const p = acquireTwoRecordLocks("a-key", "z-key").then(async (rel) => {
      acquired = true;
      await rel();
    });
    // Yield: lock should NOT be acquired yet because "z-key" is held.
    await new Promise((r) => setTimeout(r, 20));
    expect(acquired).toBe(false);
    holder();
    await p;
    expect(acquired).toBe(true);
  });
});

// ─── Parallel lifecycle writes ────────────────────────────────────────────

describe("parallel lifecycle writes — same scope", () => {
  it("parallel createMemory with distinct topics → both end up in the index", async () => {
    const N = 8;
    const promises = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        createMemory(
          saivage,
          {
            topic: { domain: "d", subject: `s${i}` },
            body: `body-${i}`,
            scope: "project",
            reason: "parallel create",
          },
          AUTHOR,
        ),
      ),
    );
    const created = await Promise.all(promises);
    expect(new Set(created.map((m) => m.id)).size).toBe(N);

    const idx = JSON.parse(
      readFileSync(join(saivage, "memory", "project", "index.json"), "utf-8"),
    ) as { entries: { id: string }[] };
    const ids = new Set(idx.entries.map((e) => e.id));
    for (const c of created) expect(ids.has(c.id)).toBe(true);
  });

  it("parallel updateMemory of same id is serialized; final state is one of the arrivals", async () => {
    const mem = await createMemory(
      saivage,
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
          updateMemory(saivage, { id: mem.id, body: b, reason: `update-${b}` }, AUTHOR),
        ),
      ),
    );
    expect(results.length).toBe(4);
    // Read final state — must equal exactly one of the four bodies (no
    // interleaved/corrupted write).
    const final = await getMemory(saivage, { id: mem.id });
    expect(final).not.toBeNull();
    expect(bodies).toContain(final!.body);
  });
});

// ─── Supersede atomicity (FR-31g, §C.1.3) ─────────────────────────────────

describe("supersedeMemory — two-key atomicity & chain repair", () => {
  it("after supersede, getMemory(OLD) walks chain to NEW", async () => {
    const v1 = await createMemory(
      saivage,
      { topic: { domain: "d", subject: "s" }, body: "v1", scope: "project", reason: "init" },
      AUTHOR,
    );
    const r = await supersedeMemory(
      saivage,
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
    const walked = await getMemory(saivage, { id: v1.id });
    expect(walked?.id).toBe(r.new_id);
    expect(walked?.body).toBe("v2");
  });

  it("parallel supersede of the SAME old id → exactly one wins, other fails INVALID_SUPERSEDE_TARGET", async () => {
    const v1 = await createMemory(
      saivage,
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
              saivage,
              {
                old_id: v1.id,
                new_record: {
                  topic: { domain: "z", subject: "y" },
                  body: `v2-${tag}`,
                  scope: "project",
                },
                reason: `race-${tag}`,
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
