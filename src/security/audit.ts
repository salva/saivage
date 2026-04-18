/**
 * Audit log — append-only JSONL file for security events.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { saivageDir } from "../config.js";

export interface AuditEntry {
  timestamp: string;
  event: string;
  severity: "info" | "warn" | "critical";
  details: Record<string, unknown>;
}

const auditPath = () => join(saivageDir(), "audit.jsonl");

export function audit(
  event: string,
  severity: AuditEntry["severity"],
  details: Record<string, unknown>,
): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    event,
    severity,
    details,
  };

  mkdirSync(saivageDir(), { recursive: true });
  appendFileSync(auditPath(), JSON.stringify(entry) + "\n", "utf-8");
}
