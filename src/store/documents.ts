/**
 * Saivage — Document Store
 * Generic JSON CRUD with atomic writes and Zod validation.
 */

import {
  open,
  readFile,
  rename,
  unlink,
  readdir,
  mkdir,
  stat,
  access,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z, ZodTypeAny } from "zod";

/** Read a JSON document from disk, validating against a Zod schema. */
export async function readDoc<S extends ZodTypeAny>(path: string, schema: S): Promise<z.output<S>> {
  const raw = await readFile(path, "utf-8");
  const data = JSON.parse(raw);
  return schema.parse(data);
}

/** Read a JSON document, returning null if the file does not exist. */
export async function readDocOrNull<S extends ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.output<S> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const data = JSON.parse(raw);
  return schema.parse(data);
}

/** Read a JSON file without schema validation, returning null if missing. */
export async function readJsonOrNull(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw);
}

/** Read with schema validation, falling back to raw JSON on validation error. */
export async function readDocLenient<S extends ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.output<S> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const data = JSON.parse(raw);
  const result = schema.safeParse(data);
  return result.success ? result.data : data;
}

/**
 * Write a JSON document atomically (tmp + fsync + rename + fsync parent).
 * Validates against the Zod schema before writing.
 */
export async function writeDoc<T>(
  path: string,
  data: T,
  schema: z.ZodType<T>,
): Promise<void> {
  const validated = schema.parse(data);
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await ensureParentDir(path);
  const payload = JSON.stringify(validated, null, 2) + "\n";

  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(payload, "utf-8");
    try { await handle.sync(); } catch { /* fsync may fail on tmpfs / Windows */ }
  } finally {
    await handle.close();
  }

  await rename(tmp, path);

  try {
    const dirHandle = await open(dirname(path), "r");
    try { await dirHandle.sync(); } catch { /* not supported on every FS */ }
    finally { await dirHandle.close(); }
  } catch {
    // Some platforms (Windows) don't allow opening directories for fsync.
  }
}

/**
 * Append an item to a JSON array document.
 */
export async function appendDoc<T extends Record<string, unknown>>(
  path: string,
  itemKey: string & keyof T,
  item: unknown,
  schema: z.ZodType<T>,
  defaultDoc?: Omit<T, typeof itemKey>,
): Promise<void> {
  let doc: T;
  const existing = await readDocOrNull(path, schema);
  if (existing !== null) {
    doc = existing as T;
  } else {
    doc = { ...defaultDoc, [itemKey]: [] } as unknown as T;
  }
  const arr = doc[itemKey];
  if (!Array.isArray(arr)) {
    throw new Error(`Field "${itemKey}" is not an array`);
  }
  arr.push(item);
  await writeDoc(path, doc, schema);
}

/** List files in a directory (returns filenames, not full paths). */
export async function listDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** List files matching a filter in a directory. */
export async function listDocs(
  dirPath: string,
  filter?: (name: string) => boolean,
): Promise<string[]> {
  const entries = await listDir(dirPath);
  return filter ? entries.filter(filter) : entries;
}

/** Delete a file if it exists. */
export async function deleteDoc(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Rename a file, atomically replacing the destination if it exists. */
export async function renameDoc(src: string, dst: string): Promise<void> {
  await rename(src, dst);
}

/** Ensure a directory exists (recursive). */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/** Ensure the parent directory of a path exists. */
async function ensureParentDir(filePath: string): Promise<void> {
  await ensureDir(dirname(filePath));
}

/**
 * Sweep orphan `*.tmp` files left behind by interrupted `writeDoc` calls.
 */
export async function sweepStaleTempFiles(
  dirPath: string,
  maxAgeMs: number = 5 * 60 * 1000,
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let entries: string[];
  try { entries = await readdir(dirPath); } catch { return 0; }
  for (const name of entries) {
    if (!name.endsWith(".tmp")) continue;
    const fp = join(dirPath, name);
    try {
      const st = await stat(fp);
      if (st.isFile() && st.mtimeMs < cutoff) {
        await unlink(fp);
        removed += 1;
      }
    } catch { /* concurrent delete or permission — ignore */ }
  }
  return removed;
}

/** Async helper: returns true if a path exists (any kind). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
