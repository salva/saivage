#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { simpleGit, type SimpleGit } from "simple-git";

let gitInstance: SimpleGit | null = null;

function git(): SimpleGit {
  if (!gitInstance) {
    const cwd = process.env["SAIVAGE_GIT_CWD"] ?? process.env["PROJECT_ROOT"] ?? process.cwd();
    gitInstance = simpleGit(cwd);
  }
  return gitInstance;
}

const server = new McpServer({ name: "git", version: "0.1.0" });

server.tool(
  "status",
  "Show working tree status",
  {
    cwd: z.string().optional().describe("Working directory override"),
  },
  async ({ cwd }) => {
    const g = cwd ? simpleGit(cwd) : git();
    const status = await g.status();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            current: status.current,
            tracking: status.tracking,
            staged: status.staged,
            modified: status.modified,
            not_added: status.not_added,
            conflicted: status.conflicted,
            ahead: status.ahead,
            behind: status.behind,
          }),
        },
      ],
    };
  },
);

server.tool(
  "create_branch",
  "Create and checkout a new branch",
  {
    name: z.string().describe("Branch name"),
    from: z.string().default("HEAD").describe("Base ref"),
    cwd: z.string().optional(),
  },
  async ({ name, from, cwd }) => {
    const g = cwd ? simpleGit(cwd) : git();
    await g.checkoutBranch(name, from);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ created: true, branch: name }) },
      ],
    };
  },
);

server.tool(
  "checkout",
  "Checkout an existing branch or ref",
  {
    ref: z.string().describe("Branch name or ref"),
    cwd: z.string().optional(),
  },
  async ({ ref, cwd }) => {
    const g = cwd ? simpleGit(cwd) : git();
    await g.checkout(ref);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ checkedOut: ref }) },
      ],
    };
  },
);

server.tool(
  "commit",
  "Stage all changes and commit",
  {
    message: z.string().describe("Commit message"),
    paths: z.array(z.string()).default(["."] ).describe("Paths to stage"),
    cwd: z.string().optional(),
  },
  async ({ message, paths, cwd }) => {
    const g = cwd ? simpleGit(cwd) : git();
    await g.add(paths);
    const result = await g.commit(message);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            committed: true,
            hash: result.commit,
            summary: result.summary,
          }),
        },
      ],
    };
  },
);

server.tool(
  "merge",
  "Merge a branch into the current branch",
  {
    branch: z.string().describe("Branch to merge"),
    noFf: z.boolean().default(false).describe("Create a merge commit even for fast-forward"),
    cwd: z.string().optional(),
  },
  async ({ branch, noFf, cwd }) => {
    const g = cwd ? simpleGit(cwd) : git();
    const options = noFf ? ["--no-ff"] : [];
    const result = await g.merge([branch, ...options]);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            merged: true,
            result: result.result,
          }),
        },
      ],
    };
  },
);

server.tool(
  "diff",
  "Show diff for the working tree or between refs",
  {
    ref1: z.string().optional().describe("First ref (default: HEAD)"),
    ref2: z.string().optional().describe("Second ref"),
    paths: z.array(z.string()).default([]).describe("Limit diff to paths"),
    cwd: z.string().optional(),
  },
  async ({ ref1, ref2, paths, cwd }) => {
    const g = cwd ? simpleGit(cwd) : git();
    const args: string[] = [];
    if (ref1) args.push(ref1);
    if (ref2) args.push(ref2);
    if (paths.length > 0) {
      args.push("--");
      args.push(...paths);
    }
    const diffOutput = await g.diff(args);
    return {
      content: [
        { type: "text" as const, text: diffOutput || "(no differences)" },
      ],
    };
  },
);

server.tool(
  "delete_branch",
  "Delete a branch",
  {
    name: z.string().describe("Branch to delete"),
    force: z.boolean().default(false).describe("Force delete"),
    cwd: z.string().optional(),
  },
  async ({ name, force, cwd }) => {
    const g = cwd ? simpleGit(cwd) : git();
    if (force) {
      await g.branch(["-D", name]);
    } else {
      await g.branch(["-d", name]);
    }
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ deleted: true, branch: name }) },
      ],
    };
  },
);

server.tool(
  "log",
  "Show recent commit log",
  {
    maxCount: z.number().default(10).describe("Max commits to show"),
    branch: z.string().optional().describe("Branch to log"),
    cwd: z.string().optional(),
  },
  async ({ maxCount, branch, cwd }) => {
    const g = cwd ? simpleGit(cwd) : git();
    const options: string[] = [`-${maxCount}`, "--pretty=format:%H|%s|%an|%ai"];
    if (branch) options.push(branch);
    const logOutput = await g.raw(["log", ...options]);
    const commits = logOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, message, author, date] = line.split("|");
        return { hash, message, author, date };
      });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(commits) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
