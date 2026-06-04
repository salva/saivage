import { open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ensureDir } from "./documents.js";

export interface AtomicJsonWriteOptions<T> {
  schema?: z.ZodType<T>;
  fsync?: boolean;
  mode?: number;
}

export async function writeAtomicJson<T>(
  filePath: string,
  value: T,
  options: AtomicJsonWriteOptions<T> = {},
): Promise<void> {
  const data = options.schema ? options.schema.parse(value) : value;
  await ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    if (options.fsync === true) {
      const handle = await open(tmp, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
