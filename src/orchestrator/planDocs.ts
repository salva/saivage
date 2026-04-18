import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";

export interface PlanDocuments {
  objectives: string;
  longTermPlan: string;
  shortTermPlan: string;
  exploration: string;
  journal: string;
}

const DOC_FILES = {
  objectives: "objectives.md",
  longTermPlan: "long-term-plan.md",
  shortTermPlan: "short-term-plan.md",
  exploration: "exploration.md",
  journal: "journal.md",
} as const;

export class PlanDocsManager {
  private readonly dir: string;

  constructor(projectRoot: string, planDocsPath: string) {
    this.dir = join(projectRoot, planDocsPath);
  }

  get docsDir(): string {
    return this.dir;
  }

  /** Check if planning docs have been bootstrapped */
  isBootstrapped(): boolean {
    return existsSync(join(this.dir, DOC_FILES.objectives));
  }

  /** Ensure the directory exists */
  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Read all planning documents */
  readAll(): PlanDocuments {
    return {
      objectives: this.read("objectives"),
      longTermPlan: this.read("longTermPlan"),
      shortTermPlan: this.read("shortTermPlan"),
      exploration: this.read("exploration"),
      journal: this.read("journal"),
    };
  }

  /** Read a single document */
  read(doc: keyof typeof DOC_FILES): string {
    const fp = join(this.dir, DOC_FILES[doc]);
    if (!existsSync(fp)) return "";
    try {
      return readFileSync(fp, "utf-8");
    } catch {
      return "";
    }
  }

  /** Write a single document (full replace) */
  write(doc: keyof typeof DOC_FILES, content: string): void {
    this.ensureDir();
    const fp = join(this.dir, DOC_FILES[doc]);
    writeFileSync(fp, content, "utf-8");
    log.info(`Planning doc updated: ${DOC_FILES[doc]}`);
  }

  /** Append to a document (for journal entries) */
  append(doc: keyof typeof DOC_FILES, content: string): void {
    this.ensureDir();
    const fp = join(this.dir, DOC_FILES[doc]);
    appendFileSync(fp, content, "utf-8");
  }

  /** Bootstrap initial documents from config objectives */
  bootstrap(objectives: string[], projectDescription: string): void {
    this.ensureDir();

    if (!existsSync(join(this.dir, DOC_FILES.objectives))) {
      const objectivesList = objectives
        .map((o, i) => `${i + 1}. ${o}`)
        .join("\n");
      this.write(
        "objectives",
        `# Project Objectives

## Vision
${projectDescription || "(No project description configured.)"}

## Objectives
${objectivesList}

## Success Criteria
- Each objective has measurable progress
- End-to-end workflows are functional before polish
- Code is tested and documented
`,
      );
    }

    if (!existsSync(join(this.dir, DOC_FILES.longTermPlan))) {
      this.write(
        "longTermPlan",
        `# Long-Term Plan

## Strategy
Focus on getting an end-to-end working system first, then iteratively improve each part.

## Phases

### Phase 1: Understanding & Assessment
- Understand the codebase structure, conventions, and current state
- Identify what works and what doesn't
- Document the baseline

### Phase 2: End-to-End Foundation
- Get all core workflows running end-to-end
- Fix broken pipelines and missing dependencies
- Establish a working baseline

### Phase 3: Iterative Improvement
- Improve code quality, test coverage, documentation
- Clean up legacy code
- Optimize performance

### Phase 4: Advanced Features
- Explore new capabilities
- Implement investigation findings
- Scale and harden

## Last Updated: ${new Date().toISOString().split("T")[0]}
`,
      );
    }

    if (!existsSync(join(this.dir, DOC_FILES.shortTermPlan))) {
      this.write(
        "shortTermPlan",
        `# Short-Term Plan

## Current Focus
Initial assessment — understand the project structure and current state.

## Ready Tasks
(Will be populated by the planner)

## Blocked
(None)

## Recently Completed
(None)

## Last Updated: ${new Date().toISOString().split("T")[0]}
`,
      );
    }

    if (!existsSync(join(this.dir, DOC_FILES.exploration))) {
      this.write(
        "exploration",
        `# Future Exploration

## Ideas & Hypotheses
(Will grow as development advances)

## Deferred Work
(Items not yet ready to be tackled)

## Investigation Lines
(Research directions to pursue)
`,
      );
    }

    if (!existsSync(join(this.dir, DOC_FILES.journal))) {
      this.write(
        "journal",
        `# Development Journal

Entries are added as work progresses. Each entry records what was tried,
what worked, what didn't, and key learnings.

---

`,
      );
    }

    log.info(`Planning documents bootstrapped in ${this.dir}`);
  }

  /** Get the last N lines of the journal (for context window management) */
  journalTail(maxLines: number): string {
    const full = this.read("journal");
    if (!full) return "";
    const lines = full.split("\n");
    if (lines.length <= maxLines) return full;
    return lines.slice(-maxLines).join("\n");
  }
}
