/**
 * Saivage — Researcher Agent (nominal subclass; metadata lives on ROSTER).
 */

import { WorkerAgent, registerWorkerCtor } from "./worker.js";

export class ResearcherAgent extends WorkerAgent {}
registerWorkerCtor("researcher", ResearcherAgent);
