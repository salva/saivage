import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, join } from "node:path";
import type { ProjectContext } from "../store/project.js";
import { pathExists } from "../store/documents.js";

const SENSITIVE_FILE_NAMES = new Set([
  "auth-profiles.json",
  "saivage.json",
  ".env",
]);

const SENSITIVE_DIR_NAMES = new Set([
  ".git",
  ".saivage",
  ".saivage-work",
  ".secrets",
  "backup",
  "backups",
  "node_modules",
  "secrets",
]);

const PROJECT_ONLY_HIDDEN_DIR_NAMES = new Set(["build", "dist"]);

export interface FileBrowserEntry {
  name: string;
  type: "dir" | "file";
  size?: number;
  modified?: string;
}

export type FileBrowserListResult =
  | { status: 200; body: { entries: FileBrowserEntry[] } }
  | { status: 400; body: { error: "Invalid path" } }
  | { status: 403; body: { error: "Access denied" } };

export type FileBrowserReadResult =
  | { status: 200; body: { path: string; content: string; size: number; type?: "json" | "md" | "txt"; truncated: boolean } }
  | { status: 400; body: { error: "path is required" | "Invalid path" | "Path is a directory" } }
  | { status: 403; body: { error: "Access denied" } }
  | { status: 404; body: { error: "Not found" } }
  | { status: 500; body: { error: "Read failed" } };

/**
 * Returns true if `target` is the same as or a descendant of `base` after
 * path resolution. `startsWith` is the wrong primitive: it would treat
 * `/foo/barx` as inside `/foo/bar`. `relative()` returns an empty string for
 * the base itself and never starts with `..` for proper descendants.
 */
export function isPathInside(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (resolvedBase === resolvedTarget) return true;
  const rel = relative(resolvedBase, resolvedTarget);
  if (rel === "" || rel === ".") return true;
  if (rel.startsWith("..")) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return true;
}

function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_NAMES.has(name) ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.endsWith(".key");
}

export function isPathHiddenForFileRoot(root: "project" | "saivage", relPath: string): boolean {
  if (!relPath || relPath === ".") return false;
  const segments = relPath.split("/").filter(Boolean);
  if (segments.some((segment) => SENSITIVE_DIR_NAMES.has(segment))) return true;
  if (root === "project" && segments.some((segment) => PROJECT_ONLY_HIDDEN_DIR_NAMES.has(segment))) return true;
  const last = segments.at(-1) ?? "";
  return isSensitiveFileName(last);
}

export class FileBrowserService {
  constructor(private readonly project: Pick<ProjectContext, "projectRoot" | "saivageDir">) {}

  async list(query: { path?: string; root?: string }): Promise<FileBrowserListResult> {
    const queryPath = query.path ?? "";
    const baseDir = this.resolveFileRoot(query.root);
    const rootKind = this.resolveRootKind(query.root);

    if (queryPath.includes("..")) {
      return { status: 400, body: { error: "Invalid path" } };
    }

    const targetDir = queryPath ? resolve(baseDir, queryPath.replace(/^\//, "")) : baseDir;

    if (!isPathInside(baseDir, targetDir)) {
      return { status: 400, body: { error: "Invalid path" } };
    }

    const relPath = relative(baseDir, targetDir);
    if (isPathHiddenForFileRoot(rootKind, relPath)) {
      return { status: 403, body: { error: "Access denied" } };
    }

    if (!(await pathExists(targetDir))) {
      return { status: 200, body: { entries: [] } };
    }

    try {
      const items = await readdir(targetDir);
      const entries = await Promise.all(
        items
          .filter((name) => !isPathHiddenForFileRoot(rootKind, relPath ? `${relPath}/${name}` : name))
          .map(async (name) => {
            const fullPath = join(targetDir, name);
            try {
              const st = await stat(fullPath);
              return {
                name,
                type: st.isDirectory() ? "dir" as const : "file" as const,
                size: st.isFile() ? st.size : undefined,
                modified: st.mtime.toISOString(),
              };
            } catch {
              return { name, type: "file" as const };
            }
          }),
      );
      return { status: 200, body: { entries } };
    } catch {
      return { status: 200, body: { entries: [] } };
    }
  }

  async read(query: { path?: string; root?: string }): Promise<FileBrowserReadResult> {
    const queryPath = query.path;
    if (!queryPath) {
      return { status: 400, body: { error: "path is required" } };
    }

    if (queryPath.includes("..")) {
      return { status: 400, body: { error: "Invalid path" } };
    }

    const baseDir = this.resolveFileRoot(query.root);
    const rootKind = this.resolveRootKind(query.root);
    const targetFile = resolve(baseDir, queryPath.replace(/^\//, ""));

    if (!isPathInside(baseDir, targetFile)) {
      return { status: 400, body: { error: "Invalid path" } };
    }

    const relPath = relative(baseDir, targetFile);
    if (isPathHiddenForFileRoot(rootKind, relPath)) {
      return { status: 403, body: { error: "Access denied" } };
    }

    if (!(await pathExists(targetFile))) {
      return { status: 404, body: { error: "Not found" } };
    }

    try {
      const st = await stat(targetFile);
      if (st.isDirectory()) {
        return { status: 400, body: { error: "Path is a directory" } };
      }
      if (st.size > 1_048_576) {
        const partial = (await readFile(targetFile, "utf-8")).slice(0, 1_048_576);
        return { status: 200, body: { path: relPath, content: partial, size: st.size, truncated: true } };
      }
      const content = await readFile(targetFile, "utf-8");
      const ext = relPath.split(".").pop()?.toLowerCase();
      const type = ext === "json" ? "json" : ext === "md" ? "md" : "txt";
      return { status: 200, body: { path: relPath, content, size: st.size, type, truncated: false } };
    } catch {
      return { status: 500, body: { error: "Read failed" } };
    }
  }

  private resolveFileRoot(root: string | undefined): string {
    return root === "project" ? this.project.projectRoot : this.project.saivageDir;
  }

  private resolveRootKind(root: string | undefined): "project" | "saivage" {
    return root === "project" ? "project" : "saivage";
  }
}
