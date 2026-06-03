import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { InProcessToolHandler } from "../runtime.js";
import type { ToolEntry } from "../types.js";
import type { BuiltinContext } from "./context.js";
import { authorizePathMutation } from "./paths.js";

const execFileAsync = promisify(execFile);

const gitTools: ToolEntry[] = [
  { name: "git_status", description: "Show working tree status", inputSchema: { type: "object", properties: {} } },
  { name: "git_create_branch", description: "Create and checkout a new branch", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "git_checkout", description: "Checkout a branch or ref", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "git_commit", description: "Stage specified files and commit", inputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, message: { type: "string" }, task_id: { type: "string" } }, required: ["files", "message"] } },
  { name: "git_merge", description: "Merge a branch", inputSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] } },
  { name: "git_diff", description: "Show diff", inputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, ref1: { type: "string" }, ref2: { type: "string" } } } },
  { name: "git_delete_branch", description: "Delete a branch", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "git_log", description: "Show recent commit log", inputSchema: { type: "object", properties: { n: { type: "number" }, branch: { type: "string" } } } },
];

async function gitExec(gitArgs: string[], cwd: string, context: BuiltinContext): Promise<string> {
  const { stdout } = await execFileAsync("git", gitArgs, { cwd, maxBuffer: context.limits.maxOutputBytes });
  return stdout.trim();
}

export function makeGitService(context: BuiltinContext): {
  tools: ToolEntry[];
  handler: InProcessToolHandler;
} {
  const handler: InProcessToolHandler = async (toolName, args, ctx) => {
    const cwd = context.project.projectRoot;

    switch (toolName) {
      case "git_status": {
        const raw = await gitExec(["status", "--porcelain"], cwd, context);
        const lines = raw.split("\n").filter(Boolean);
        const modified: string[] = [];
        const added: string[] = [];
        const deleted: string[] = [];
        const untracked: string[] = [];
        for (const line of lines) {
          const status = line.substring(0, 2);
          const file = line.substring(3);
          if (status.includes("?")) untracked.push(file);
          else if (status.includes("D")) deleted.push(file);
          else if (status.includes("A")) added.push(file);
          else modified.push(file);
        }
        return { content: { modified, added, deleted, untracked }, isError: false };
      }

      case "git_create_branch": {
        const name = args.name as string;
        await gitExec(["checkout", "-b", name], cwd, context);
        return { content: { branch: name, created: true }, isError: false };
      }

      case "git_checkout": {
        const ref = args.ref as string;
        await gitExec(["checkout", ref], cwd, context);
        return { content: { ref, checked_out: true }, isError: false };
      }

      case "git_commit": {
        const files = args.files as string[] | undefined;
        if (!files || files.length === 0) {
          return { content: { error: "files is required — explicit file list enforces per-agent commit scoping" }, isError: true };
        }
        const message = args.message as string;
        const taskId = args.task_id as string | undefined;
        const prefix = taskId ? `[tsk-${taskId}] ` : "";

        for (const f of files) {
          const authorized = authorizePathMutation(ctx, f, context.project.projectRoot);
          if ("error" in authorized) return { content: authorized.error, isError: true };
          await gitExec(["add", "--", f], cwd, context);
        }

        try {
          await gitExec(["commit", "-m", prefix + message], cwd, context);
        } catch (err: unknown) {
          const msg = (err as Error).message ?? "";
          if (msg.includes("nothing to commit")) {
            return { content: { sha: "none", message: "Nothing to commit" }, isError: false };
          }
          const status = await gitExec(["status", "--porcelain"], cwd, context);
          if (status.includes("UU") || status.includes("AA")) {
            const conflictFiles = status
              .split("\n")
              .filter((l) => l.startsWith("UU") || l.startsWith("AA"))
              .map((l) => l.substring(3));
            return { content: { error: "CONFLICT", files: conflictFiles }, isError: true };
          }
          throw err;
        }

        const sha = await gitExec(["rev-parse", "HEAD"], cwd, context);
        return { content: { sha }, isError: false };
      }

      case "git_merge": {
        const branch = args.branch as string;
        const output = await gitExec(["merge", branch], cwd, context);
        return { content: { merged: true, output }, isError: false };
      }

      case "git_diff": {
        const files = args.files as string[] | undefined;
        const ref1 = args.ref1 as string | undefined;
        const ref2 = args.ref2 as string | undefined;
        const gitArgs = ["diff"];
        if (ref1) gitArgs.push(ref1);
        if (ref2) gitArgs.push(ref2);
        if (files?.length) {
          gitArgs.push("--");
          gitArgs.push(...files);
        }
        const diff = await gitExec(gitArgs, cwd, context);
        return { content: { diff }, isError: false };
      }

      case "git_delete_branch": {
        const name = args.name as string;
        await gitExec(["branch", "-d", name], cwd, context);
        return { content: { branch: name, deleted: true }, isError: false };
      }

      case "git_log": {
        const n = (args.n as number | undefined) ?? 10;
        const branch = args.branch as string | undefined;
        const gitArgs = ["log", "--format=%H%x00%s%x00%an%x00%aI", `-n`, String(n)];
        if (branch) gitArgs.push(branch);
        const raw = await gitExec(gitArgs, cwd, context);
        const commits = raw
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [sha, message, author, date] = line.split("\0");
            return { sha, message, author, date };
          });
        return { content: { commits }, isError: false };
      }

      default:
        return { content: { error: `Unknown git tool: ${toolName}` }, isError: true };
    }
  };

  return { tools: gitTools, handler };
}
