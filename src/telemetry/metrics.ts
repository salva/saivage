/**
 * Telemetry — collects system & LLM metrics into SQLite.
 *
 * Gauge samples (CPU%, RAM, GPU%, VRAM) are snapshot values.
 * Counter deltas (LLM requests, tokens, errors) are interval increments.
 */

import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { saivageDir, ensureDir } from "../config.js";
import { log } from "../log.js";

// ── Types ────────────────────────────────────────────────────────

export interface SystemSnapshot {
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  gpuPercent: number | null;
  vramUsedMb: number | null;
  vramTotalMb: number | null;
}

export interface LlmCounters {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  timeouts: number;
  latencyMs: number; // cumulative for the interval
}

// ── In-memory LLM counters (accumulate between flushes) ─────────

const llmAccum = new Map<
  string,
  { requests: number; inputTokens: number; outputTokens: number; errors: number; timeouts: number; latencyMs: number }
>();

/** Called by the router after each LLM call (success or failure). */
export function recordLlmCall(
  model: string,
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    error?: boolean;
    timeout?: boolean;
    latencyMs?: number;
  },
): void {
  let c = llmAccum.get(model);
  if (!c) {
    c = { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0, timeouts: 0, latencyMs: 0 };
    llmAccum.set(model, c);
  }
  c.requests++;
  c.inputTokens += opts.inputTokens ?? 0;
  c.outputTokens += opts.outputTokens ?? 0;
  if (opts.error) c.errors++;
  if (opts.timeout) c.timeouts++;
  c.latencyMs += opts.latencyMs ?? 0;
}

/** Drain accumulated counters (returns deltas and resets). */
function drainLlmCounters(): LlmCounters[] {
  const result: LlmCounters[] = [];
  for (const [model, c] of llmAccum) {
    if (c.requests > 0) {
      result.push({ model, ...c });
    }
  }
  // Reset
  for (const c of llmAccum.values()) {
    c.requests = 0;
    c.inputTokens = 0;
    c.outputTokens = 0;
    c.errors = 0;
    c.timeouts = 0;
    c.latencyMs = 0;
  }
  return result;
}

// ── System metrics collection ───────────────────────────────────

let prevCpuIdle = 0;
let prevCpuTotal = 0;

function readCpu(): number {
  try {
    const stat = readFileSync("/proc/stat", "utf-8");
    const line = stat.split("\n")[0]!; // "cpu  user nice system idle ..."
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3]! + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    const dIdle = idle - prevCpuIdle;
    const dTotal = total - prevCpuTotal;
    prevCpuIdle = idle;
    prevCpuTotal = total;
    if (dTotal === 0) return 0;
    return Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10;
  } catch {
    return 0;
  }
}

function readMemory(): { usedMb: number; totalMb: number } {
  try {
    const info = readFileSync("/proc/meminfo", "utf-8");
    const get = (key: string) => {
      const m = info.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const totalKb = get("MemTotal");
    const availKb = get("MemAvailable");
    return {
      totalMb: Math.round(totalKb / 1024),
      usedMb: Math.round((totalKb - availKb) / 1024),
    };
  } catch {
    return { usedMb: 0, totalMb: 0 };
  }
}

function readGpu(): { percent: number | null; usedMb: number | null; totalMb: number | null } {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
      { timeout: 3000, encoding: "utf-8" },
    ).trim();
    const [gpu, used, total] = out.split(",").map((s) => parseFloat(s.trim()));
    return { percent: gpu ?? null, usedMb: used ?? null, totalMb: total ?? null };
  } catch {
    return { percent: null, usedMb: null, totalMb: null };
  }
}

function collectSystemSnapshot(): SystemSnapshot {
  const mem = readMemory();
  const gpu = readGpu();
  return {
    cpuPercent: readCpu(),
    memUsedMb: mem.usedMb,
    memTotalMb: mem.totalMb,
    gpuPercent: gpu.percent,
    vramUsedMb: gpu.usedMb,
    vramTotalMb: gpu.totalMb,
  };
}

// ── SQLite storage ──────────────────────────────────────────────

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const dir = join(saivageDir(), "telemetry");
  ensureDir(dir);
  const dbPath = join(dir, "metrics.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_metrics (
      ts INTEGER NOT NULL,
      cpu_percent REAL,
      mem_used_mb INTEGER,
      mem_total_mb INTEGER,
      gpu_percent REAL,
      vram_used_mb INTEGER,
      vram_total_mb INTEGER
    );

    CREATE TABLE IF NOT EXISTS llm_metrics (
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      requests INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      errors INTEGER,
      timeouts INTEGER,
      latency_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sys_ts ON system_metrics(ts);
    CREATE INDEX IF NOT EXISTS idx_llm_ts ON llm_metrics(ts);
    CREATE INDEX IF NOT EXISTS idx_llm_model ON llm_metrics(model, ts);
  `);
  return db;
}

// ── Prepared statements (lazy) ──────────────────────────────────

let insertSys: Database.Statement | null = null;
let insertLlm: Database.Statement | null = null;

function getInsertSys() {
  if (!insertSys) {
    insertSys = getDb().prepare(
      `INSERT INTO system_metrics (ts, cpu_percent, mem_used_mb, mem_total_mb, gpu_percent, vram_used_mb, vram_total_mb)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }
  return insertSys;
}

function getInsertLlm() {
  if (!insertLlm) {
    insertLlm = getDb().prepare(
      `INSERT INTO llm_metrics (ts, model, requests, input_tokens, output_tokens, errors, timeouts, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }
  return insertLlm;
}

// ── Periodic collection ─────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const now = Math.floor(Date.now() / 1000);
  try {
    const sys = collectSystemSnapshot();
    getInsertSys().run(
      now,
      sys.cpuPercent,
      sys.memUsedMb,
      sys.memTotalMb,
      sys.gpuPercent,
      sys.vramUsedMb,
      sys.vramTotalMb,
    );

    const llmDeltas = drainLlmCounters();
    const stmt = getInsertLlm();
    for (const d of llmDeltas) {
      stmt.run(now, d.model, d.requests, d.inputTokens, d.outputTokens, d.errors, d.timeouts, d.latencyMs);
    }
  } catch (err) {
    log.warn(`Telemetry tick error: ${err}`);
  }
}

export function startMetricsCollector(intervalMs = 30_000): void {
  // Seed CPU baseline
  readCpu();
  timer = setInterval(tick, intervalMs);
  // First real sample after one interval
  log.info(`Telemetry: collecting every ${intervalMs / 1000}s`);
}

export function stopMetricsCollector(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (db) {
    db.close();
    db = null;
    insertSys = null;
    insertLlm = null;
  }
}

// ── Query helpers (used by MCP tools) ───────────────────────────

export interface TimeRange {
  fromTs?: number; // unix seconds
  toTs?: number;
}

export function querySystemMetrics(range: TimeRange & { limit?: number }) {
  const d = getDb();
  const from = range.fromTs ?? 0;
  const to = range.toTs ?? Math.floor(Date.now() / 1000);
  const limit = range.limit ?? 1000;
  return d
    .prepare(
      `SELECT ts, cpu_percent, mem_used_mb, mem_total_mb, gpu_percent, vram_used_mb, vram_total_mb
       FROM system_metrics WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(from, to, limit);
}

export function queryLlmMetrics(range: TimeRange & { model?: string; limit?: number }) {
  const d = getDb();
  const from = range.fromTs ?? 0;
  const to = range.toTs ?? Math.floor(Date.now() / 1000);
  const limit = range.limit ?? 1000;

  if (range.model) {
    return d
      .prepare(
        `SELECT ts, model, requests, input_tokens, output_tokens, errors, timeouts, latency_ms
         FROM llm_metrics WHERE ts >= ? AND ts <= ? AND model = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(from, to, range.model, limit);
  }
  return d
    .prepare(
      `SELECT ts, model, requests, input_tokens, output_tokens, errors, timeouts, latency_ms
       FROM llm_metrics WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(from, to, limit);
}

export function queryLlmSummary(range: TimeRange) {
  const d = getDb();
  const from = range.fromTs ?? 0;
  const to = range.toTs ?? Math.floor(Date.now() / 1000);
  return d
    .prepare(
      `SELECT model,
              SUM(requests) as total_requests,
              SUM(input_tokens) as total_input_tokens,
              SUM(output_tokens) as total_output_tokens,
              SUM(errors) as total_errors,
              SUM(timeouts) as total_timeouts,
              ROUND(SUM(latency_ms) * 1.0 / NULLIF(SUM(requests), 0)) as avg_latency_ms
       FROM llm_metrics WHERE ts >= ? AND ts <= ?
       GROUP BY model ORDER BY total_requests DESC`,
    )
    .all(from, to);
}

export function querySystemSummary(range: TimeRange) {
  const d = getDb();
  const from = range.fromTs ?? 0;
  const to = range.toTs ?? Math.floor(Date.now() / 1000);
  return d
    .prepare(
      `SELECT COUNT(*) as samples,
              ROUND(AVG(cpu_percent), 1) as avg_cpu,
              MAX(cpu_percent) as max_cpu,
              ROUND(AVG(mem_used_mb)) as avg_mem_mb,
              MAX(mem_used_mb) as max_mem_mb,
              MAX(mem_total_mb) as total_mem_mb,
              ROUND(AVG(gpu_percent), 1) as avg_gpu,
              MAX(gpu_percent) as max_gpu,
              ROUND(AVG(vram_used_mb)) as avg_vram_mb,
              MAX(vram_used_mb) as max_vram_mb,
              MAX(vram_total_mb) as total_vram_mb
       FROM system_metrics WHERE ts >= ? AND ts <= ?`,
    )
    .get(from, to);
}

/** Get the latest system snapshot (most recent row). */
export function queryLatestSystem() {
  const d = getDb();
  return d
    .prepare(
      `SELECT ts, cpu_percent, mem_used_mb, mem_total_mb, gpu_percent, vram_used_mb, vram_total_mb
       FROM system_metrics ORDER BY ts DESC LIMIT 1`,
    )
    .get();
}

/** List distinct models that have metrics. */
export function queryModels() {
  const d = getDb();
  return d.prepare(`SELECT DISTINCT model FROM llm_metrics ORDER BY model`).all();
}
