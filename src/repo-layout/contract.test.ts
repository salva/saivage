import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract, parseContract } from "./contract.js";
import { validateStageId } from "./validate-stage-id.js";

function makeProject(contractJson?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "saivage-repo-layout-test-"));
  mkdirSync(join(dir, ".saivage"), { recursive: true });
  if (contractJson !== undefined) {
    writeFileSync(join(dir, ".saivage", "repo-layout.json"), JSON.stringify(contractJson));
  }
  return dir;
}

// Synthetic topic vocabulary — intentionally not tied to any real project.
const SYNTHETIC: object = {
  version: 1,
  topics: {
    alpha: {
      artifact_dir: "out/alpha",
      stage_id_re: "^step[0-9]+_alpha_",
      new_stages_allowed: true,
    },
    beta: {
      artifact_dir: "out/beta",
      stage_id_re: "^step[0-9]+_beta_",
      new_stages_allowed: true,
    },
    gamma: {
      artifact_dir: "out/gamma",
      stage_id_re: "^step[0-9]+_gamma_",
      new_stages_allowed: false,
    },
  },
  allowed_top_level_dirs: ["out", "tests"],
  forbidden_paths: ["/legacy/**"],
  tracked_dot_saivage_whitelist: [".saivage/repo-layout.json"],
};

describe("loadContract", () => {
  it("reports absent when the file does not exist", () => {
    const dir = makeProject();
    const result = loadContract(dir);
    expect(result.present).toBe(false);
    expect(result.contract).toBeUndefined();
  });

  it("loads and parses a valid contract", () => {
    const dir = makeProject(SYNTHETIC);
    const result = loadContract(dir);
    expect(result.present).toBe(true);
    expect(result.error).toBeUndefined();
    const c = result.contract;
    if (!c) throw new Error("expected contract");
    expect(c.version).toBe(1);
    expect(c.topics.map((t) => t.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(c.allowedTopLevelDirs.has("out")).toBe(true);
    expect(c.trackedDotSaivageWhitelist.has(".saivage/repo-layout.json")).toBe(true);
  });

  it("rejects malformed JSON", () => {
    const dir = makeProject();
    writeFileSync(join(dir, ".saivage", "repo-layout.json"), "{not json");
    const result = loadContract(dir);
    expect(result.present).toBe(true);
    expect(result.error).toMatch(/not valid JSON/);
  });

  it("rejects a topic missing required fields", () => {
    expect(() =>
      parseContract({
        version: 1,
        topics: { x: { stage_id_re: "^x_" } },
      }),
    ).toThrowError(/artifact_dir/);
  });

  it("rejects an invalid regex", () => {
    expect(() =>
      parseContract({
        version: 1,
        topics: { x: { artifact_dir: "out/x", stage_id_re: "([" } },
      }),
    ).toThrowError(/not a valid regex/);
  });

  it("defaults new_stages_allowed to true", () => {
    const c = parseContract({
      version: 1,
      topics: { x: { artifact_dir: "out/x", stage_id_re: "^x_" } },
    });
    expect(c.topics[0]?.newStagesAllowed).toBe(true);
  });
});

describe("validateStageId", () => {
  const contract = parseContract(SYNTHETIC);

  it("returns the topic for a unique match in an open topic", () => {
    const r = validateStageId(contract, "step001_alpha_first");
    expect(r.topic).toBe("alpha");
    expect(r.reason).toBeNull();
  });

  it("returns no_topic_match for unknown stage ids", () => {
    const r = validateStageId(contract, "totally_unrelated_thing");
    expect(r.topic).toBeNull();
    expect(r.reason).toBe("no_topic_match");
    expect(r.matches).toEqual([]);
  });

  it("returns multiple_topic_match when regexes overlap", () => {
    const overlapping = parseContract({
      version: 1,
      topics: {
        one: { artifact_dir: "o/1", stage_id_re: "^step[0-9]+_" },
        two: { artifact_dir: "o/2", stage_id_re: "^step001_" },
      },
    });
    const r = validateStageId(overlapping, "step001_anything");
    expect(r.topic).toBeNull();
    expect(r.reason).toBe("multiple_topic_match");
    expect([...r.matches].sort()).toEqual(["one", "two"]);
  });

  it("returns topic_closed when matched topic has new_stages_allowed false", () => {
    const r = validateStageId(contract, "step007_gamma_anything");
    expect(r.topic).toBeNull();
    expect(r.reason).toBe("topic_closed");
    expect(r.matches).toEqual(["gamma"]);
  });
});
