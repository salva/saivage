/**
 * Saivage — Designer Agent (nominal subclass; metadata lives on ROSTER).
 */

import { WorkerAgent, registerWorkerCtor } from "./worker.js";

export class DesignerAgent extends WorkerAgent {}
registerWorkerCtor("designer", DesignerAgent);
