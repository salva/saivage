/**
 * Saivage — Reviewer Agent (nominal subclass; metadata lives on ROSTER).
 *
 * Stage-scoped quality gate. The shared follow-up logic lives on
 * `WorkerAgent`; this class only registers the worker constructor.
 */

import { WorkerAgent, registerWorkerCtor } from "./worker.js";

export class ReviewerAgent extends WorkerAgent {}
registerWorkerCtor("reviewer", ReviewerAgent);
