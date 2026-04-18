/**
 * PlanManager — Three-tier planning hierarchy (Spec 14).
 *
 * Manages:
 *   Master Plan  (.saivage/planning/master-plan.md)
 *   Stage Plans  (.saivage/planning/stages/stage-N.md)
 *   Journal      (.saivage/planning/journal.md)
 *   Exploration   (.saivage/planning/exploration.md)
 *
 * Replaces the flat PlanDocsManager from Spec 13.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";

// ── Types ──────────────────────────────────────────────────────────

export interface StageInfo {
  id: number;
  title: string;
  goal: string;
  status: "pending" | "active" | "completed" | "skipped";
  entryCriteria: string;
  exitCriteria: string;
  started?: string;
  completed?: string;
}

export interface MasterPlan {
  version: number;
  created: string;
  lastUpdated: string;
  activeStage: number | null;
  iterative: boolean;
  vision: string;
  objectives: string[];
  successCriteria: string[];
  stages: StageInfo[];
}

export interface StageTask {
  ref: string; // e.g. "2.3" — stageId.taskNum
  title: string;
  goal: string;
  agentType: string;
  dependsOn: string[]; // refs within stage, e.g. ["2.1", "2.2"]
  status: string;
  result?: string;
}

export interface StagePlan {
  stageId: number;
  title: string;
  status: string;
  created: string;
  lastUpdated: string;
  goal: string;
  approach: string;
  tasks: StageTask[];
  notes: string;
}

// ── Frontmatter ────────────────────────────────────────────────────

function parseFrontmatter(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([\w_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val === "null" || val === "~" || val === "") meta[kv[1]] = null;
    else if (val === "true") meta[kv[1]] = true;
    else if (val === "false") meta[kv[1]] = false;
    else if (/^-?\d+$/.test(val)) meta[kv[1]] = parseInt(val, 10);
    else meta[kv[1]] = val;
  }
  return { meta, body: match[2] };
}

// ── Master Plan markdown ───────────────────────────────────────────

function parseMasterPlanMarkdown(content: string): MasterPlan {
  const { meta, body } = parseFrontmatter(content);

  const plan: MasterPlan = {
    version: (meta.version as number) ?? 1,
    created:
      (meta.created as string) ?? new Date().toISOString().split("T")[0],
    lastUpdated:
      (meta.last_updated as string) ?? new Date().toISOString().split("T")[0],
    activeStage: (meta.active_stage as number) ?? null,
    iterative: meta.iterative === true || meta.iterative === "true",
    vision: "",
    objectives: [],
    successCriteria: [],
    stages: [],
  };

  const visionMatch = body.match(/## Vision\n([\s\S]*?)(?=\n## )/);
  if (visionMatch) plan.vision = visionMatch[1].trim();

  const objMatch = body.match(/## Objectives\n([\s\S]*?)(?=\n## )/);
  if (objMatch) {
    plan.objectives = objMatch[1]
      .trim()
      .split("\n")
      .filter((l) => /^\d+\./.test(l.trim()))
      .map((l) => l.replace(/^\d+\.\s*/, "").trim());
  }

  const scMatch = body.match(/## Success Criteria\n([\s\S]*?)(?=\n## |$)/);
  if (scMatch) {
    plan.successCriteria = scMatch[1]
      .trim()
      .split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.replace(/^-\s*/, "").trim());
  }

  const stageRe =
    /### Stage (\d+):\s*(.+)\n([\s\S]*?)(?=\n### Stage |\n## [^#]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = stageRe.exec(body)) !== null) {
    const block = m[3];
    const field = (name: string): string => {
      const fm = block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`));
      return fm ? fm[1].trim() : "";
    };
    const statusStr = field("Status");
    const status = (
      ["pending", "active", "completed", "skipped"].includes(statusStr)
        ? statusStr
        : "pending"
    ) as StageInfo["status"];

    plan.stages.push({
      id: parseInt(m[1], 10),
      title: m[2].trim(),
      goal: field("Goal"),
      status,
      entryCriteria: field("Entry criteria"),
      exitCriteria: field("Exit criteria"),
      started: field("Started") || undefined,
      completed: field("Completed") || undefined,
    });
  }

  return plan;
}

function serializeMasterPlan(plan: MasterPlan): string {
  const fm = [
    "---",
    `version: ${plan.version}`,
    `created: ${plan.created}`,
    `last_updated: ${plan.lastUpdated}`,
    `active_stage: ${plan.activeStage ?? "null"}`,
    `iterative: ${plan.iterative}`,
    "---",
  ].join("\n");

  const objectives = plan.objectives
    .map((o, i) => `${i + 1}. ${o}`)
    .join("\n");
  const criteria = plan.successCriteria.map((c) => `- ${c}`).join("\n");

  let stages = "";
  for (const s of plan.stages) {
    stages += `\n### Stage ${s.id}: ${s.title}\n`;
    stages += `- **Status:** ${s.status}\n`;
    stages += `- **Goal:** ${s.goal}\n`;
    stages += `- **Entry criteria:** ${s.entryCriteria}\n`;
    stages += `- **Exit criteria:** ${s.exitCriteria}\n`;
    if (s.started) stages += `- **Started:** ${s.started}\n`;
    if (s.completed) stages += `- **Completed:** ${s.completed}\n`;
  }

  return `${fm}

# Master Plan

## Vision
${plan.vision}

## Objectives
${objectives}

## Success Criteria
${criteria}

## Stages
${stages}`;
}

// ── Stage Plan markdown ────────────────────────────────────────────

function parseStagePlanMarkdown(content: string): StagePlan {
  const { meta, body } = parseFrontmatter(content);

  const plan: StagePlan = {
    stageId: (meta.stage as number) ?? 0,
    title: (meta.title as string) ?? "",
    status: (meta.status as string) ?? "active",
    created:
      (meta.created as string) ?? new Date().toISOString().split("T")[0],
    lastUpdated:
      (meta.last_updated as string) ?? new Date().toISOString().split("T")[0],
    goal: "",
    approach: "",
    tasks: [],
    notes: "",
  };

  const goalMatch = body.match(/## Goal\n([\s\S]*?)(?=\n## )/);
  if (goalMatch) plan.goal = goalMatch[1].trim();

  const approachMatch = body.match(/## Approach\n([\s\S]*?)(?=\n## )/);
  if (approachMatch) plan.approach = approachMatch[1].trim();

  const taskRe =
    /### Task (\d+\.\d+):\s*(.+)\n([\s\S]*?)(?=\n### Task |\n## |$)/g;
  let tm: RegExpExecArray | null;
  while ((tm = taskRe.exec(body)) !== null) {
    const ref = tm[1];
    const title = tm[2].trim();
    const block = tm[3];
    const field = (name: string): string => {
      const fm = block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`));
      return fm ? fm[1].trim() : "";
    };

    const depsStr = field("Depends on");
    const dependsOn = depsStr
      ? depsStr
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean)
      : [];

    plan.tasks.push({
      ref,
      title,
      goal: title, // title is the short goal; detailed goal lives in TodoItem
      agentType: field("Agent") || "coder",
      dependsOn,
      status: field("Status") || "pending",
      result: field("Result") || undefined,
    });
  }

  const notesMatch = body.match(/## Notes\n([\s\S]*)$/);
  if (notesMatch) plan.notes = notesMatch[1].trim();

  return plan;
}

function serializeStagePlan(plan: StagePlan): string {
  const fm = [
    "---",
    `stage: ${plan.stageId}`,
    `title: "${plan.title}"`,
    `status: ${plan.status}`,
    `created: ${plan.created}`,
    `last_updated: ${plan.lastUpdated}`,
    "---",
  ].join("\n");

  let tasks = "";
  for (const t of plan.tasks) {
    tasks += `\n### Task ${t.ref}: ${t.title}\n`;
    tasks += `- **Status:** ${t.status}\n`;
    tasks += `- **Agent:** ${t.agentType}\n`;
    if (t.dependsOn.length > 0) {
      tasks += `- **Depends on:** ${t.dependsOn.join(", ")}\n`;
    }
    if (t.result) {
      tasks += `- **Result:** ${t.result}\n`;
    }
  }

  return `${fm}

# Stage ${plan.stageId}: ${plan.title}

## Goal
${plan.goal}

## Approach
${plan.approach}

## Tasks
${tasks}
## Notes
${plan.notes}
`;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Convert a stage-task ref like "2.3" to a todo ID like "stage-2-task-3" */
export function taskRefToTodoId(ref: string): string {
  const clean = ref.replace(/^Task\s+/, "");
  const [stage, task] = clean.split(".");
  return `stage-${stage}-task-${task}`;
}

/** Convert a todo ID like "stage-2-task-3" to a ref like "2.3" */
export function todoIdToTaskRef(todoId: string): string | null {
  const m = todoId.match(/^stage-(\d+)-task-(\d+)$/);
  if (!m) return null;
  return `${m[1]}.${m[2]}`;
}

// ── PlanManager class ──────────────────────────────────────────────

export class PlanManager {
  private readonly dir: string;
  private readonly stagesDir: string;

  constructor(projectRoot: string, planDocsPath: string) {
    this.dir = join(projectRoot, planDocsPath);
    this.stagesDir = join(this.dir, "stages");
  }

  get docsDir(): string {
    return this.dir;
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.stagesDir))
      mkdirSync(this.stagesDir, { recursive: true });
  }

  // ── Master Plan ──────────────────────────────────────────────────

  isBootstrapped(): boolean {
    return existsSync(join(this.dir, "master-plan.md"));
  }

  hasLegacyDocs(): boolean {
    return existsSync(join(this.dir, "objectives.md"));
  }

  readMasterPlan(): MasterPlan | null {
    const fp = join(this.dir, "master-plan.md");
    if (!existsSync(fp)) return null;
    try {
      return parseMasterPlanMarkdown(readFileSync(fp, "utf-8"));
    } catch (err) {
      log.warn(`Failed to parse master plan: ${err}`);
      return null;
    }
  }

  writeMasterPlan(plan: MasterPlan): void {
    this.ensureDir();
    plan.lastUpdated = new Date().toISOString().split("T")[0];
    writeFileSync(
      join(this.dir, "master-plan.md"),
      serializeMasterPlan(plan),
      "utf-8",
    );
    log.info("Master plan updated");
  }

  getActiveStage(): StageInfo | null {
    const plan = this.readMasterPlan();
    if (!plan) return null;
    return plan.stages.find((s) => s.status === "active") ?? null;
  }

  /**
   * Mark current active stage as completed and activate the next pending stage.
   * Returns the newly activated stage, or null if no more stages.
   */
  advanceStage(): StageInfo | null {
    const plan = this.readMasterPlan();
    if (!plan) return null;

    const current = plan.stages.find((s) => s.status === "active");
    if (current) {
      current.status = "completed";
      current.completed = new Date().toISOString().split("T")[0];
    }

    const next = plan.stages.find((s) => s.status === "pending");
    if (next) {
      next.status = "active";
      next.started = new Date().toISOString().split("T")[0];
      plan.activeStage = next.id;
    } else {
      plan.activeStage = null;
    }

    this.writeMasterPlan(plan);
    return next ?? null;
  }

  // ── Stage Plans ──────────────────────────────────────────────────

  readStagePlan(stageId: number): StagePlan | null {
    const fp = join(this.stagesDir, `stage-${stageId}.md`);
    if (!existsSync(fp)) return null;
    try {
      return parseStagePlanMarkdown(readFileSync(fp, "utf-8"));
    } catch (err) {
      log.warn(`Failed to parse stage plan ${stageId}: ${err}`);
      return null;
    }
  }

  writeStagePlan(stageId: number, plan: StagePlan): void {
    this.ensureDir();
    plan.lastUpdated = new Date().toISOString().split("T")[0];
    writeFileSync(
      join(this.stagesDir, `stage-${stageId}.md`),
      serializeStagePlan(plan),
      "utf-8",
    );
    log.info(`Stage plan ${stageId} updated`);
  }

  /**
   * Write-through: update a task's status/result in the stage plan file.
   */
  updateTaskInStagePlan(
    stageId: number,
    taskRef: string,
    update: { status: string; result?: string },
  ): void {
    const plan = this.readStagePlan(stageId);
    if (!plan) return;

    const normalizedRef = taskRef.replace(/^Task\s+/, "");
    const task = plan.tasks.find((t) => t.ref === normalizedRef);
    if (!task) {
      log.warn(`Task ${taskRef} not found in stage ${stageId} plan`);
      return;
    }

    task.status = update.status;
    if (update.result !== undefined) task.result = update.result;
    this.writeStagePlan(stageId, plan);
  }

  // ── Supporting Documents ─────────────────────────────────────────

  appendJournal(entry: string): void {
    this.ensureDir();
    const fp = join(this.dir, "journal.md");
    if (!existsSync(fp)) {
      writeFileSync(fp, "# Development Journal\n\n---\n\n", "utf-8");
    }
    appendFileSync(fp, entry, "utf-8");
  }

  readJournalTail(maxLines: number): string {
    const fp = join(this.dir, "journal.md");
    if (!existsSync(fp)) return "";
    try {
      const full = readFileSync(fp, "utf-8");
      const lines = full.split("\n");
      if (lines.length <= maxLines) return full;
      return lines.slice(-maxLines).join("\n");
    } catch {
      return "";
    }
  }

  readExploration(): string {
    const fp = join(this.dir, "exploration.md");
    if (!existsSync(fp)) return "";
    try {
      return readFileSync(fp, "utf-8");
    } catch {
      return "";
    }
  }

  writeExploration(content: string): void {
    this.ensureDir();
    writeFileSync(join(this.dir, "exploration.md"), content, "utf-8");
  }

  // ── Legacy Migration ─────────────────────────────────────────────

  /**
   * Detect and migrate legacy flat planning docs (Spec 13 format).
   * Returns the content for seeding, or null if no legacy docs exist.
   */
  migrateLegacy(): {
    objectives: string;
    longTermPlan: string;
    shortTermPlan: string;
  } | null {
    const legacyFiles: Record<string, string> = {
      "objectives.md": join(this.dir, "objectives.md"),
      "long-term-plan.md": join(this.dir, "long-term-plan.md"),
      "short-term-plan.md": join(this.dir, "short-term-plan.md"),
    };

    if (!existsSync(legacyFiles["objectives.md"])) return null;

    const result = {
      objectives: existsSync(legacyFiles["objectives.md"])
        ? readFileSync(legacyFiles["objectives.md"], "utf-8")
        : "",
      longTermPlan: existsSync(legacyFiles["long-term-plan.md"])
        ? readFileSync(legacyFiles["long-term-plan.md"], "utf-8")
        : "",
      shortTermPlan: existsSync(legacyFiles["short-term-plan.md"])
        ? readFileSync(legacyFiles["short-term-plan.md"], "utf-8")
        : "",
    };

    // Move to legacy/ subfolder
    const legacyDir = join(this.dir, "legacy");
    if (!existsSync(legacyDir)) mkdirSync(legacyDir, { recursive: true });

    for (const [name, fp] of Object.entries(legacyFiles)) {
      if (existsSync(fp)) {
        renameSync(fp, join(legacyDir, name));
      }
    }

    log.info("Legacy planning docs migrated to legacy/ subfolder");
    return result;
  }
}
