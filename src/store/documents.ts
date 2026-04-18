/**
 * Saivage — Document Store
 * Generic JSON CRUD with atomic writes and Zod validation.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z, ZodTypeAny } from "zod";

/** Read a JSON document from disk, validating against a Zod schema. */
export function readDoc<S extends ZodTypeAny>(path: string, schema: S): z.output<S> {
  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw);
  return schema.parse(data);
}

/** Read a JSON document, returning null if the file does not exist. */
export function readDocOrNull<S extends ZodTypeAny>(
  path: string,
  schema: S,
): z.output<S> | null {
  if (!existsSync(path)) return null;
  return readDoc(path, schema);
}

/** Read a JSON file without schema validation, returning null if missing. */
export function readJsonOrNull(path: string): unknown | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

/** Read with schema validation, falling back to raw JSON on validation error. */
export function readDocLenient<S extends ZodTypeAny>(
  path: string,
  schema: S,
): z.output<S> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw);
  const result = schema.safeParse(data);
  return result.success ? result.data : data;
}

/**
 * Write a JSON document atomically (tmp + rename).
 * Validates against the Zod schema before writing.
 */
export function writeDoc<T>(
  path: string,
  data: T,
  schema: z.ZodType<T>,
): void {
  const validated = schema.parse(data);
  const tmp = path + ".tmp";
  ensureParentDir(path);
  writeFileSync(tmp, JSON.stringify(validated, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/**
 * Append an item to a JSON array document.
 * The schema validates the container document, and the itemKey is the
 * array field to append to. E.g. append to `{ stages: [...] }`.
 */
export function appendDoc<T extends Record<string, unknown>>(
  path: string,
  itemKey: string & keyof T,
  item: unknown,
  schema: z.ZodType<T>,
  defaultDoc?: Omit<T, typeof itemKey>,
): void {
  let doc: T;
  if (existsSync(path)) {
    doc = readDoc(path, schema);
  } else {
    doc = { ...defaultDoc, [itemKey]: [] } as unknown as T;
  }
  const arr = doc[itemKey];
  if (!Array.isArray(arr)) {
    throw new Error(`Field "${itemKey}" is not an array`);
  }
  arr.push(item);
  writeDoc(path, doc, schema);
}

/** List files in a directory (returns filenames, not full paths). */
export function listDir(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath);
}

/** List files matching a filter in a directory. */
export function listDocs(
  dirPath: string,
  filter?: (name: string) => boolean,
): string[] {
  const entries = listDir(dirPath);
  return filter ? entries.filter(filter) : entries;
}

/** Delete a file if it exists. */
export function deleteDoc(path: string): boolean {
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Ensure a directory exists (recursive). */
export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/** Ensure the parent directory of a path exists. */
function ensureParentDir(filePath: string): void {
  ensureDir(dirname(filePath));
}
