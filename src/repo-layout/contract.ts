/**
 * Generic repo-layout contract loader.
 *
 * Saivage is project-agnostic. A target project may opt in to repo-layout
 * enforcement by writing ``.saivage/repo-layout.json`` with the schema
 * described below. Nothing in this module hardcodes any specific project's
 * topic names, paths, or vocabulary.
 *
 * Schema (informally):
 *
 *   {
 *     "version": 1,
 *     "topics": {
 *       "<topic-id>": {
 *         "artifact_dir": "<repo-relative directory>",
 *         "stage_id_re": "<regex matched against the stage id>",
 *         "new_stages_allowed": <bool; default true>
 *       }
 *     },
 *     "allowed_top_level_dirs": ["..."],
 *     "forbidden_paths": ["/glob/**"],
 *     "tracked_dot_saivage_whitelist": [".saivage/..."]
 *   }
 *
 * Behavior when the file is absent: validation is skipped (returns
 * ``{ present: false }``); callers must treat absence as "no constraint".
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ContractTopic {
  readonly name: string;
  readonly artifactDir: string;
  readonly stageIdRe: RegExp;
  readonly newStagesAllowed: boolean;
}

export interface Contract {
  readonly version: number;
  readonly topics: ReadonlyArray<ContractTopic>;
  readonly allowedTopLevelDirs: ReadonlySet<string>;
  readonly forbiddenPaths: ReadonlyArray<string>;
  readonly trackedDotSaivageWhitelist: ReadonlySet<string>;
}

export interface ContractLoadResult {
  readonly present: boolean;
  readonly contract?: Contract;
  readonly error?: string;
}

const REQUIRED_TOPIC_FIELDS = ["artifact_dir", "stage_id_re"] as const;

interface RawTopic {
  artifact_dir?: unknown;
  stage_id_re?: unknown;
  new_stages_allowed?: unknown;
}

interface RawContract {
  version?: unknown;
  topics?: Record<string, RawTopic>;
  allowed_top_level_dirs?: unknown;
  forbidden_paths?: unknown;
  tracked_dot_saivage_whitelist?: unknown;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`repo-layout contract: '${field}' must be an array of strings`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`repo-layout contract: '${field}' contains a non-string`);
    }
  }
  return value as string[];
}

export function parseContract(raw: unknown): Contract {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("repo-layout contract: root must be an object");
  }
  const r = raw as RawContract;

  if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 1) {
    throw new Error("repo-layout contract: 'version' must be a positive integer");
  }

  if (typeof r.topics !== "object" || r.topics === null) {
    throw new Error("repo-layout contract: 'topics' must be an object");
  }

  const topics: ContractTopic[] = [];
  for (const [name, raw] of Object.entries(r.topics)) {
    for (const field of REQUIRED_TOPIC_FIELDS) {
      if (!(field in raw)) {
        throw new Error(`repo-layout contract: topic '${name}' missing '${field}'`);
      }
    }
    if (typeof raw.artifact_dir !== "string" || raw.artifact_dir.length === 0) {
      throw new Error(`repo-layout contract: topic '${name}' artifact_dir must be a non-empty string`);
    }
    if (typeof raw.stage_id_re !== "string" || raw.stage_id_re.length === 0) {
      throw new Error(`repo-layout contract: topic '${name}' stage_id_re must be a non-empty string`);
    }
    let stageIdRe: RegExp;
    try {
      stageIdRe = new RegExp(raw.stage_id_re);
    } catch (e) {
      throw new Error(
        `repo-layout contract: topic '${name}' stage_id_re is not a valid regex: ${(e as Error).message}`,
        { cause: e },
      );
    }
    const newStagesAllowed = raw.new_stages_allowed === undefined ? true : !!raw.new_stages_allowed;
    topics.push({
      name,
      artifactDir: raw.artifact_dir,
      stageIdRe,
      newStagesAllowed,
    });
  }

  const allowedTopLevelDirs = new Set(assertStringArray(r.allowed_top_level_dirs ?? [], "allowed_top_level_dirs"));
  const forbiddenPaths = assertStringArray(r.forbidden_paths ?? [], "forbidden_paths");
  const trackedDotSaivageWhitelist = new Set(
    assertStringArray(r.tracked_dot_saivage_whitelist ?? [], "tracked_dot_saivage_whitelist"),
  );

  return Object.freeze({
    version: r.version,
    topics: Object.freeze(topics),
    allowedTopLevelDirs,
    forbiddenPaths: Object.freeze(forbiddenPaths.slice()),
    trackedDotSaivageWhitelist,
  });
}

/**
 * Load the contract from ``<projectRoot>/.saivage/repo-layout.json``.
 *
 * Returns ``{ present: false }`` when the file is absent. Returns
 * ``{ present: true, contract }`` on success. Returns
 * ``{ present: true, error }`` when the file exists but is malformed.
 */
export function loadContract(projectRoot: string): ContractLoadResult {
  const path = join(projectRoot, ".saivage", "repo-layout.json");
  if (!existsSync(path)) {
    return { present: false };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    return { present: true, error: `read failed: ${(e as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { present: true, error: `not valid JSON: ${(e as Error).message}` };
  }
  try {
    return { present: true, contract: parseContract(raw) };
  } catch (e) {
    return { present: true, error: (e as Error).message };
  }
}
