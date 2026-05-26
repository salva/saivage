import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");
const SCAN_ROOTS = ["src", "web/src", "docs"];
const SELF = "src/security/no-cop.test.ts";
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".json",
  ".md",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);
const FORBIDDEN = [
  "PromptInjection",
  "promptInjectionCop",
  "prompt-injection-cop",
  "scanUntrustedText",
  "prompt_injection_scan",
  "injectionScanner",
  "injectionModel",
  "maxScanLengthBytes",
  "securityModel",
  "security: \"security\"",
  "SecurityStatusRing",
  "securityStatusRing",
  "/api/debug/security",
];

function shouldSkipDirectory(relativePath: string): boolean {
  return [
    "docs/api",
    "docs/.vitepress/cache",
    "docs/.vitepress/dist",
    "node_modules",
  ].some((skip) => relativePath === skip || relativePath.startsWith(`${skip}/`));
}

function shouldScanFile(path: string): boolean {
  if (relative(REPO_ROOT, path) === SELF) return false;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(path.slice(dot));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const rel = relative(REPO_ROOT, path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!shouldSkipDirectory(rel)) out.push(...walkFiles(path));
    } else if (stat.isFile() && shouldScanFile(path)) {
      out.push(path);
    }
  }
  return out;
}

describe("legacy prompt-injection cop removal", () => {
  it("has no residue in live source, web, or docs", () => {
    const offenders: string[] = [];
    for (const scanRoot of SCAN_ROOTS) {
      for (const file of walkFiles(join(REPO_ROOT, scanRoot))) {
        const text = readFileSync(file, "utf-8");
        for (const needle of FORBIDDEN) {
          if (text.includes(needle)) {
            offenders.push(`${relative(REPO_ROOT, file)}: ${needle}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
