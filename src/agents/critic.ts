/**
 * Saivage — Critic Agent (nominal subclass; metadata lives on ROSTER).
 *
 * One-shot reviewer specialized in evaluating design documents produced by the
 * Designer. Writes a standalone critique document and returns a TaskReport.
 */

import { WorkerAgent, registerWorkerCtor } from "./worker.js";

export class CriticAgent extends WorkerAgent {}
registerWorkerCtor("critic", CriticAgent);
