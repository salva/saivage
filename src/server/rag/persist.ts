import { writeFile, readFile, rename, unlink } from "node:fs/promises";
import {
  SaivageConfigSchema,
  configPath,
  type SaivageConfig,
} from "../../config.js";
import { pathExists } from "../../store/documents.js";

export type SaivagePersistStage = "read" | "validate" | "write";

export class SaivagePersistError extends Error {
  readonly details: { stage: SaivagePersistStage };
  constructor(message: string, details: { stage: SaivagePersistStage }) {
    super(message);
    this.name = "SaivagePersistError";
    this.details = details;
  }
}

/**
 * Persist a mutation of `.saivage/saivage.json` using a raw-JSON read,
 * schema validation of both the pre- and post-mutation document, and an
 * atomic temp-write + rename. Bypasses the env-var interpolation pass
 * used by `loadConfig`, so the on-disk file keeps `${VAR}` placeholders.
 *
 * Stages classify failure surfaces for `RAG_PERSIST_FAILED.details.stage`:
 *  - `"read"`     — filesystem read failed.
 *  - `"validate"` — JSON parse / schema validation failed (either side).
 *  - `"write"`    — temp file write or rename failed.
 */
export async function saveSaivageConfig(
  projectRoot: string,
  mutate: (cfg: SaivageConfig) => SaivageConfig,
): Promise<void> {
  const fp = configPath(projectRoot);

  let rawText = "{}";
  try {
    if (await pathExists(fp)) {
      rawText = await readFile(fp, "utf-8");
    }
  } catch (err) {
    throw new SaivagePersistError((err as Error).message, { stage: "read" });
  }

  let current: SaivageConfig;
  try {
    current = SaivageConfigSchema.parse(JSON.parse(rawText));
  } catch (err) {
    throw new SaivagePersistError((err as Error).message, { stage: "validate" });
  }

  let next: SaivageConfig;
  try {
    next = SaivageConfigSchema.parse(mutate(current));
  } catch (err) {
    throw new SaivagePersistError((err as Error).message, { stage: "validate" });
  }

  const tmp = `${fp}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, fp);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw new SaivagePersistError((err as Error).message, { stage: "write" });
  }
}
