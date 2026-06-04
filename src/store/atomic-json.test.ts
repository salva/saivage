import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeAtomicJson } from "./atomic-json.js";

describe("writeAtomicJson", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "atomic-json-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes JSON through a temp file and rename", async () => {
    const file = path.join(root, "nested", "state.json");
    await writeAtomicJson(file, { ok: true });
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ ok: true });
    expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("validates with the supplied schema before writing", async () => {
    const file = path.join(root, "state.json");
    await expect(
      writeAtomicJson(file, { ok: "yes" }, { schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes the temp file when rename fails", async () => {
    const file = path.join(root, "target-dir");
    mkdirSync(file);
    await expect(writeAtomicJson(file, { ok: true })).rejects.toThrow();
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
