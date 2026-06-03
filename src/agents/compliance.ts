export interface ComplianceViolation {
  conventionId: string;
  message: string;
  repairPrompt: string;
  fatal: boolean;
}

export function checkWorkerCompletion(opts: {
  text: string;
  hasMeaningfulToolEvidence: boolean;
  requiredToolMessage: string;
  artifactValidated?: boolean;
}): ComplianceViolation | null {
  if (!opts.hasMeaningfulToolEvidence) {
    return {
      conventionId: "worker-execution-evidence",
      message: opts.requiredToolMessage,
      repairPrompt: `${opts.requiredToolMessage} Use a non-trivial execution or inspection tool, write the required TaskReport artifact JSON to disk, then return a concise final response.`,
      fatal: false,
    };
  }

  if (opts.artifactValidated) return null;

  const message = "Invalid final task response: no valid TaskReport artifact was written.";
  return {
    conventionId: "worker-report-evidence",
    message,
    repairPrompt: `${message} Write the required TaskReport artifact JSON to the expected .saivage/stages/<stage>/reports/<task>.json path with concrete evidence, then return a concise final response.`,
    fatal: false,
  };
}

export function checkManagerCompletion(opts: {
  text: string;
  hasWorkerEvidence: boolean;
  hasReviewerEvidence: boolean;
  artifactResult?: "completed" | "failed" | "escalated" | "aborted";
}): ComplianceViolation | null {
  if (!opts.hasWorkerEvidence) {
    return {
      conventionId: "manager-worker-evidence",
      message: "Invalid final stage response: you have not dispatched any worker yet.",
      repairPrompt: "Invalid final stage response: dispatch worker tasks, inspect their TaskReports, write the StageSummary artifact JSON to disk, then return a concise final response.",
      fatal: false,
    };
  }

  const result = opts.artifactResult;
  if (!result) {
    const message = "Invalid final stage response: no valid StageSummary artifact was written.";
    return {
      conventionId: "manager-summary-evidence",
      message,
      repairPrompt: `${message} Write .saivage/stages/<stage>/summary.json after worker and reviewer evidence exists, then return a concise final response.`,
      fatal: false,
    };
  }

  if (result !== "escalated" && !opts.hasReviewerEvidence) {
    return {
      conventionId: "manager-review-evidence",
      message: "Invalid final stage response: completed stages require reviewer evidence before StageSummary.",
      repairPrompt: "Invalid final stage response: dispatch run_reviewer for this stage, inspect its TaskReport, update the StageSummary artifact if needed, then return a concise final response.",
      fatal: false,
    };
  }

  return null;
}

export function checkPlannerPlanDone(opts: {
  hasCompletedPlanEvidence: boolean;
}): ComplianceViolation | null {
  if (opts.hasCompletedPlanEvidence) return null;
  return {
    conventionId: "planner-plan-done-evidence",
    message: "Invalid plan_done: no completed-plan evidence exists in this conversation.",
    repairPrompt: "Invalid plan_done: first inspect plan state and stage evidence with plan_get/plan_get_history or dispatch/verify remaining work, then call plan_done only when objectives are verified complete.",
    fatal: false,
  };
}
