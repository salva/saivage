/**
 * Saivage — Reviewer Agent
 *
 * Stage-scoped quality gate. Survives across multiple review calls within one
 * stage so follow-up requests build on earlier findings.
 */

import { WorkerAgent, registerWorkerCtor, buildInitialMessage } from "./worker.js";
import { normalizeTask } from "./task-report.js";
import type { AgentResult, WorkerInput } from "./types.js";

export class ReviewerAgent extends WorkerAgent {
  private reviewCount = 0;

  override async run(): Promise<AgentResult> {
    return this.review(this.input);
  }

  async review(input: WorkerInput): Promise<AgentResult> {
    this.input = { ...input, task: normalizeTask(input.task, "reviewer") };
    if (this.reviewCount > 0) {
      const followUp = await buildInitialMessage(this.ctx, this.input, "reviewer", {
        headingSuffix: ` - Follow-up Review ${this.reviewCount + 1}`,
        prependFollowUp: true,
      });
      this.injectMessage(followUp);
    }
    this.reviewCount++;
    return this.executeTask(this.input);
  }
}
registerWorkerCtor("reviewer", ReviewerAgent);
