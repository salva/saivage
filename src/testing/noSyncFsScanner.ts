import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

const SYNC_FS_IDENTIFIERS = [
  "readFileSync", "writeFileSync", "mkdirSync", "readdirSync",
  "statSync", "openSync", "readSync", "closeSync",
  "unlinkSync", "existsSync", "chmodSync", "rmSync", "rmdirSync",
  "appendFileSync", "copyFileSync", "renameSync", "symlinkSync",
  "linkSync", "realpathSync", "accessSync", "lstatSync",
] as const;

const NODE_FS_SPECIFIERS = ['"node:fs"', "'node:fs'"];

export interface SyncFsScanOptions {
  /** Repo-relative roots to walk (e.g. `["src/mcp"]`). */
  roots: string[];
  /**
   * Identifiers permitted in named imports from `node:fs`.
   * Empty array means no named import from `node:fs` is allowed.
   * Default: `["createWriteStream"]`.
   */
  allowedNamedImports?: readonly string[];
  /**
   * `*Sync` identifiers permitted as call expressions. Use for the
   * narrow cases where sync FS is unavoidable (e.g. process-exit
   * handlers releasing lockfiles). Default: empty.
   */
  allowedSyncCalls?: readonly string[];
  /** File extensions to scan. Default: `[".ts"]`. */
  extensions?: readonly string[];
  /** Substrings; any file whose path contains one is skipped. */
  skipPathContains?: readonly string[];
}

export interface SyncFsViolation {
  file: string;
  kind: "namespace-import" | "default-import" | "disallowed-named-import" | "sync-call";
  detail: string;
}

export async function scanForSyncFs(opts: SyncFsScanOptions): Promise<SyncFsViolation[]> {
  const allowed = new Set(opts.allowedNamedImports ?? ["createWriteStream"]);
  const allowedCalls = new Set(opts.allowedSyncCalls ?? []);
  const exts = opts.extensions ?? [".ts"];
  const skip = opts.skipPathContains ?? [".test.ts", ".d.ts"];
  const files: string[] = [];
  for (const root of opts.roots) await walk(root, files, exts, skip);
  const violations: SyncFsViolation[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf-8");
    if (!NODE_FS_SPECIFIERS.some((s) => src.includes(s))) {
      // No node:fs import at all; still scan for *Sync calls in case
      // a future regression imports via require().
      collectSyncCalls(file, src, violations, allowedCalls);
      continue;
    }
    // Generalized regex: handles default, namespace, named, and mixed
    // forms. We tokenize each import statement that ends at node:fs.
    const importRe = /import\s+([^"';]+?)\s+from\s+["']node:fs["']/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      const clause = m[1].trim();
      // Default import: `import fs from "node:fs"`.
      const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*(,|$)/);
      const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      const namedMatch = clause.match(/\{([^}]*)\}/);
      if (namespaceMatch) {
        violations.push({ file, kind: "namespace-import", detail: clause });
      }
      if (defaultMatch && !clause.startsWith("{")) {
        // A bare default import (or `default, { named }`) gives
        // unrestricted access to the sync surface.
        violations.push({ file, kind: "default-import", detail: clause });
      }
      if (namedMatch) {
        const names = namedMatch[1]
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        for (const name of names) {
          if (!allowed.has(name)) {
            violations.push({
              file,
              kind: "disallowed-named-import",
              detail: name,
            });
          }
        }
      }
    }
    collectSyncCalls(file, src, violations, allowedCalls);
  }
  return violations;
}

function collectSyncCalls(file: string, src: string, out: SyncFsViolation[], allowed: ReadonlySet<string>): void {
  const callRe = new RegExp(`\\b(${SYNC_FS_IDENTIFIERS.join("|")})\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) {
    if (allowed.has(m[1])) continue;
    out.push({ file, kind: "sync-call", detail: m[1] });
  }
}

async function walk(
  dir: string,
  out: string[],
  exts: readonly string[],
  skip: readonly string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out, exts, skip);
      continue;
    }
    if (!exts.some((ext) => full.endsWith(ext))) continue;
    if (skip.some((s) => full.includes(s))) continue;
    out.push(full);
  }
}
