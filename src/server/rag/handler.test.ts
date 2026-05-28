/**
 * F02 B06 — handler tests. Use a mock `RagService` to verify role gating,
 * mutex semantics, schema validation, and operator-context bypass.
 */
import { describe, it, expect, vi } from "vitest";
import { makeRagHandler } from "./handler.js";
import type { RagService } from "./service.js";
import type { ToolCallContext } from "../../mcp/toolContext.js";

function makeService(over: Partial<RagService> = {}): RagService {
  const manager = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    register: vi.fn(),
    ingest: vi.fn(),
    query: vi.fn(),
    stats: vi.fn(),
    drop: vi.fn(),
  } as unknown as RagService["manager"];
  return {
    manager,
    datasets: [],
    watchStatus: new Map(),
    adminRoles: new Set<import("../../agents/types.js").AgentRole>(),
    control: { busy: false },
    enabled: true,
    projectRoot: "/tmp/proj",
    ...over,
  };
}

const baseCtx: ToolCallContext = {
  role: "coder",
  agentId: "a1",
  projectRoot: "/tmp/proj",
};

describe("makeRagHandler", () => {
  it("returns RAG_DISABLED when service.enabled is false", async () => {
    const h = makeRagHandler(makeService({ enabled: false }));
    const r = await h("rag_list", {}, baseCtx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatchObject({ ok: false, code: "RAG_DISABLED" });
  });

  it("RAG_UNAUTHORIZED_ROLE when admin tool called by non-admin non-operator", async () => {
    const h = makeRagHandler(makeService());
    const r = await h("rag_drop", { collection_id: "x" }, baseCtx);
    expect(r.content).toMatchObject({ ok: false, code: "RAG_UNAUTHORIZED_ROLE" });
  });

  it("operatorContext bypasses admin role check", async () => {
    const svc = makeService();
    (svc.manager.drop as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (await import("../../rag/errors.js")).DatasetNotFoundError({ datasetId: "x" }),
    );
    const h = makeRagHandler(svc);
    const r = await h("rag_drop", { collection_id: "x" }, { ...baseCtx, operatorContext: true });
    expect(r.content).toMatchObject({ ok: false, code: "RAG_DATASET_NOT_FOUND" });
  });

  it("adminRoles grants access", async () => {
    const svc = makeService();
    svc.adminRoles.add("planner");
    const h = makeRagHandler(svc);
    const r = await h("rag_list", {}, { ...baseCtx, role: "planner" });
    expect(r.isError).toBe(false);
    expect(r.content).toMatchObject({ ok: true });
  });

  it("RAG_INVALID_ARGS on schema failure", async () => {
    const h = makeRagHandler(makeService());
    const r = await h("rag_stats", {}, baseCtx);
    expect(r.content).toMatchObject({ ok: false, code: "RAG_INVALID_ARGS" });
  });

  it("RAG_CONTROL_BUSY when control mutex is held", async () => {
    const svc = makeService({ control: { busy: true } });
    svc.adminRoles.add("coder");
    const h = makeRagHandler(svc);
    const r = await h(
      "rag_admin",
      { collection_id: "d", action: "reconcile" },
      baseCtx,
    );
    expect(r.content).toMatchObject({ ok: false, code: "RAG_CONTROL_BUSY" });
  });

  it("rag_ingest does NOT take the control mutex", async () => {
    const svc = makeService({ control: { busy: true } });
    svc.adminRoles.add("coder");
    (svc.manager.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { sources: [{ root: "/tmp/x" }] },
    });
    (svc.manager.ingest as ReturnType<typeof vi.fn>).mockResolvedValue({
      filesScanned: 0, filesChanged: 0, chunksUpserted: 0, chunksDeleted: 0,
      chunksDroppedSecrets: 0, tokensEmbedded: 0, embeddingMs: 0, storeMs: 0,
    });
    const h = makeRagHandler(svc);
    const r = await h("rag_ingest", { collection_id: "x" }, baseCtx);
    expect(r.content).toMatchObject({ ok: true });
  });

  it("rag_list success returns ragOk envelope", async () => {
    const h = makeRagHandler(makeService());
    const r = await h("rag_list", {}, baseCtx);
    expect(r.isError).toBe(false);
    expect(r.content).toMatchObject({ ok: true, content: { collections: [] } });
  });
});
