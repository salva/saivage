import { join, relative, resolve } from "node:path";

import { decidePathMutation } from "../../agents/conventions.js";
import type { ToolCallContext } from "../toolContext.js";

export function assertInside(baseDir: string, candidate: string, label: string): string {
  const base = resolve(baseDir);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
    return target;
  }
  throw new Error(`${label} must stay inside ${base}`);
}

export function resolvePath(p: string, root: string): string {
  const target = p.startsWith("/") ? p : join(root, p);
  return assertInside(root, target, "Path");
}

export function authorizePathMutation(
  ctx: ToolCallContext | undefined,
  p: string,
  root: string,
): { path: string; relativePath: string } | { error: { error: string; code: "BLOCKED_PATH"; path: string } } {
  const decision = decidePathMutation(ctx ?? { role: "planner", agentId: "builtin", projectRoot: root, operatorContext: true }, p);
  if (decision.ok) return { path: decision.path, relativePath: decision.relativePath };
  return { error: { error: decision.reason, code: "BLOCKED_PATH", path: decision.relativePath } };
}
