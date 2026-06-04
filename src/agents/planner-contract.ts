export function buildPlanMutationContract(): string {
  return (
    `PLAN-MUTATION CONTRACT (mandatory before any run_manager call):\n` +
    `  1) plan_add_stage(stage)        // register the stage in plan.json if it is new\n` +
    `  2) plan_set_current(stage.id)   // mark it active; stamps started_at\n` +
    `  3) run_manager(stage)           // dispatch; dispatcher enforces 1 & 2\n` +
    `  4) plan_complete_stage(...)     // move to history with the result\n` +
    `Skipping any required precondition causes run_manager to reject with STAGE_NOT_FOUND, STAGE_MISMATCH, or PLAN_NOT_FOUND.\n` +
    `On rejection, run the missing plan tool and retry the SAME stage; do not invent a different stage and do not escalate.\n\n`
  );
}
