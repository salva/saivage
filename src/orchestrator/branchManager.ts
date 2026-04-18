import { execSync } from "node:child_process";
import { log } from "../log.js";

/**
 * Manages git branches for work items.
 * Supports dual-project routing: "target" project (user code) and "self" project (saivage itself).
 */
export class BranchManager {
  private targetCwd: string;
  private selfCwd: string;

  constructor(targetCwd: string, selfCwd: string) {
    this.targetCwd = targetCwd;
    this.selfCwd = selfCwd;
  }

  /** Get the working directory for a project */
  getCwd(project: "target" | "self"): string {
    return project === "self" ? this.selfCwd : this.targetCwd;
  }

  /** Generate a branch name for a work item */
  branchName(todoId: string): string {
    return `saivage/work/${todoId}`;
  }

  /** Get merge target for a project */
  mergeTarget(_project: "target" | "self"): string {
    return "main";
  }

  /** Check if a directory is inside a git repo */
  private isGitRepo(cwd: string): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /** Get the current branch name */
  private currentBranch(cwd: string): string {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: "pipe" }).toString().trim();
  }

  /**
   * Create a work branch and check it out.
   * Returns the branch name, or null if git is not available.
   */
  async createAndCheckout(todoId: string, project: "target" | "self"): Promise<string | null> {
    const cwd = this.getCwd(project);
    if (!this.isGitRepo(cwd)) return null;

    const branch = this.branchName(todoId);
    const baseBranch = this.mergeTarget(project);

    try {
      // Create the branch from the base branch
      execSync(`git checkout -b "${branch}" "${baseBranch}"`, { cwd, stdio: "pipe" });
      log.info(`Branch created and checked out: ${branch} (from ${baseBranch})`);
      return branch;
    } catch (err) {
      // Branch might already exist, or base branch missing — try creating from HEAD
      try {
        execSync(`git checkout -b "${branch}"`, { cwd, stdio: "pipe" });
        log.info(`Branch created from HEAD: ${branch}`);
        return branch;
      } catch {
        log.warn(`Failed to create branch "${branch}": ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }
  }

  /**
   * Merge a work branch back into the base branch.
   * Returns true if merge succeeded, false otherwise.
   */
  async mergeBack(todoId: string, project: "target" | "self"): Promise<boolean> {
    const cwd = this.getCwd(project);
    if (!this.isGitRepo(cwd)) return false;

    const branch = this.branchName(todoId);
    const baseBranch = this.mergeTarget(project);

    try {
      // Check if the branch exists
      execSync(`git rev-parse --verify "${branch}"`, { cwd, stdio: "pipe" });
    } catch {
      // Branch doesn't exist — nothing to merge
      return false;
    }

    try {
      // Check if there are any commits on the branch beyond base
      const diffCount = execSync(
        `git rev-list --count "${baseBranch}..${branch}"`,
        { cwd, stdio: "pipe" },
      ).toString().trim();

      if (diffCount === "0") {
        log.info(`Branch ${branch} has no new commits — skipping merge`);
        // Clean up empty branch
        execSync(`git checkout "${baseBranch}"`, { cwd, stdio: "pipe" });
        execSync(`git branch -d "${branch}"`, { cwd, stdio: "pipe" });
        return true;
      }

      // Switch to base branch and merge
      execSync(`git checkout "${baseBranch}"`, { cwd, stdio: "pipe" });
      execSync(`git merge --no-ff -m "Merge saivage work: ${todoId.slice(0, 8)}" "${branch}"`, {
        cwd,
        stdio: "pipe",
      });

      // Delete the work branch
      execSync(`git branch -d "${branch}"`, { cwd, stdio: "pipe" });
      log.info(`Merged ${branch} into ${baseBranch} (${diffCount} commits)`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Merge failed for ${branch}: ${msg}`);

      // Abort the merge if in conflict state
      try {
        execSync("git merge --abort", { cwd, stdio: "pipe" });
      } catch { /* ignore */ }

      // Switch back to base branch
      try {
        execSync(`git checkout "${baseBranch}"`, { cwd, stdio: "pipe" });
      } catch { /* ignore */ }

      return false;
    }
  }

  /**
   * Clean up a work branch without merging (for cancelled/failed tasks).
   */
  async deleteBranch(todoId: string, project: "target" | "self"): Promise<void> {
    const cwd = this.getCwd(project);
    if (!this.isGitRepo(cwd)) return;

    const branch = this.branchName(todoId);
    const baseBranch = this.mergeTarget(project);

    try {
      // Make sure we're not on the branch we're deleting
      const current = this.currentBranch(cwd);
      if (current === branch) {
        execSync(`git checkout "${baseBranch}"`, { cwd, stdio: "pipe" });
      }
      execSync(`git branch -D "${branch}"`, { cwd, stdio: "pipe" });
      log.info(`Deleted branch: ${branch}`);
    } catch {
      // Branch might not exist — that's fine
    }
  }
}
