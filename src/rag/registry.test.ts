import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadRegistry,
  saveRegistry,
  upsertRegistryEntry,
  removeRegistryEntry,
  registryPath,
  type RegistryEntry,
} from "./registry.js";

const stamp = {
  provider: "openai",
  model: "text-embedding-3-small",
  dim: 256,
  releaseFingerprint: "abc",
};

function entry(id: string): RegistryEntry {
  return { id, projectId: "p1", source: "doc", providerStamp: stamp, createdAt: "2026-05-25T00:00:00.000Z" };
}

describe("registry", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "rag-reg-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loadRegistry returns [] when file missing", async () => {
    expect(await loadRegistry(root)).toEqual([]);
  });

  it("saveRegistry writes atomically and loadRegistry round-trips", async () => {
    const e = [entry("a"), entry("b")];
    await saveRegistry(root, e);
    expect(await loadRegistry(root)).toEqual(e);
  });

  it("upsertRegistryEntry adds and updates", async () => {
    await upsertRegistryEntry(root, entry("a"));
    await upsertRegistryEntry(root, entry("b"));
    let now = await loadRegistry(root);
    expect(now.map((x) => x.id)).toEqual(["a", "b"]);
    const updated = { ...entry("a"), source: "code" as const };
    await upsertRegistryEntry(root, updated);
    now = await loadRegistry(root);
    expect(now.find((x) => x.id === "a")?.source).toBe("code");
  });

  it("removeRegistryEntry removes by id", async () => {
    await saveRegistry(root, [entry("a"), entry("b")]);
    await removeRegistryEntry(root, "a");
    const now = await loadRegistry(root);
    expect(now.map((x) => x.id)).toEqual(["b"]);
  });

  it("registryPath is .saivage/rag/registry.json", () => {
    expect(registryPath(root)).toBe(path.join(root, ".saivage", "rag", "registry.json"));
  });
});
