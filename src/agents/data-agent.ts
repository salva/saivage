/**
 * Saivage — Data Agent (nominal subclass; metadata lives on ROSTER).
 */

import { WorkerAgent, registerWorkerCtor } from "./worker.js";

export class DataAgent extends WorkerAgent {}
registerWorkerCtor("data_agent", DataAgent);
