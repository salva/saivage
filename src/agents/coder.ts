/**
 * Saivage — Coder Agent (nominal subclass; metadata lives on ROSTER).
 */

import { WorkerAgent, registerWorkerCtor } from "./worker.js";

export class CoderAgent extends WorkerAgent {}
registerWorkerCtor("coder", CoderAgent);
