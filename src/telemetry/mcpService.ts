/**
 * Telemetry MCP Service — in-process tools that let chat agents
 * query system and LLM metrics and generate SVG charts.
 */

import type { ToolEntry } from "../mcp/registry.js";
import type { InProcessToolHandler } from "../mcp/runtime.js";
import {
  querySystemMetrics,
  queryLlmMetrics,
  queryLlmSummary,
  querySystemSummary,
  queryLatestSystem,
  queryModels,
} from "./metrics.js";

// ── Tool schemas ────────────────────────────────────────────────

export const telemetryTools: ToolEntry[] = [
  {
    name: "metrics_system_current",
    description:
      "Get the latest system resource snapshot: CPU%, RAM used/total, GPU%, VRAM used/total.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "metrics_system_summary",
    description:
      "Get aggregated system metrics (avg/max CPU, RAM, GPU, VRAM) over a time range. Defaults to last hour.",
    inputSchema: {
      type: "object",
      properties: {
        minutes: {
          type: "number",
          description: "Look back this many minutes (default: 60)",
        },
      },
    },
  },
  {
    name: "metrics_system_history",
    description:
      "Get time-series system metrics for a given period. Returns data points in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        minutes: {
          type: "number",
          description: "Look back this many minutes (default: 60)",
        },
        limit: {
          type: "number",
          description: "Max data points (default: 200)",
        },
      },
    },
  },
  {
    name: "metrics_llm_summary",
    description:
      "Get per-model LLM usage summary: total requests, tokens in/out, errors, timeouts, avg latency. Defaults to last hour.",
    inputSchema: {
      type: "object",
      properties: {
        minutes: {
          type: "number",
          description: "Look back this many minutes (default: 60)",
        },
      },
    },
  },
  {
    name: "metrics_llm_history",
    description:
      "Get time-series LLM metrics for a specific model or all models. Each row is a collection interval delta.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Filter by model (e.g. 'github-copilot/gpt-5.3-codex'). Omit for all models.",
        },
        minutes: {
          type: "number",
          description: "Look back this many minutes (default: 60)",
        },
        limit: {
          type: "number",
          description: "Max data points (default: 200)",
        },
      },
    },
  },
  {
    name: "metrics_llm_models",
    description: "List all models that have recorded metrics.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "metrics_chart",
    description:
      "Generate an SVG chart from metrics data. Returns SVG markup that can be displayed or saved. " +
      "Chart types: 'system_cpu', 'system_memory', 'system_gpu', 'llm_requests', 'llm_tokens', 'llm_errors', 'llm_latency'.",
    inputSchema: {
      type: "object",
      properties: {
        chart: {
          type: "string",
          description:
            "Chart type: system_cpu, system_memory, system_gpu, llm_requests, llm_tokens, llm_errors, llm_latency",
        },
        minutes: {
          type: "number",
          description: "Look back this many minutes (default: 60)",
        },
        model: {
          type: "string",
          description: "For LLM charts, filter by model (optional).",
        },
      },
      required: ["chart"],
    },
  },
];

// ── Tool handler ────────────────────────────────────────────────

function timeRange(minutes?: number) {
  const mins = minutes ?? 60;
  const toTs = Math.floor(Date.now() / 1000);
  const fromTs = toTs - mins * 60;
  return { fromTs, toTs };
}

export function createTelemetryToolHandler(): InProcessToolHandler {
  return async (toolName, args) => {
    try {
      switch (toolName) {
        case "metrics_system_current": {
          const row = queryLatestSystem();
          return {
            content: [{ type: "text", text: row ? JSON.stringify(row, null, 2) : "No data yet" }],
            isError: false,
          };
        }
        case "metrics_system_summary": {
          const range = timeRange(args.minutes as number | undefined);
          const row = querySystemSummary(range);
          return {
            content: [{ type: "text", text: JSON.stringify(row, null, 2) }],
            isError: false,
          };
        }
        case "metrics_system_history": {
          const range = timeRange(args.minutes as number | undefined);
          const rows = querySystemMetrics({ ...range, limit: (args.limit as number) ?? 200 });
          rows.reverse(); // chronological
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
            isError: false,
          };
        }
        case "metrics_llm_summary": {
          const range = timeRange(args.minutes as number | undefined);
          const rows = queryLlmSummary(range);
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
            isError: false,
          };
        }
        case "metrics_llm_history": {
          const range = timeRange(args.minutes as number | undefined);
          const rows = queryLlmMetrics({
            ...range,
            model: args.model as string | undefined,
            limit: (args.limit as number) ?? 200,
          });
          rows.reverse();
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
            isError: false,
          };
        }
        case "metrics_llm_models": {
          const rows = queryModels();
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
            isError: false,
          };
        }
        case "metrics_chart": {
          const chart = args.chart as string;
          const range = timeRange(args.minutes as number | undefined);
          const model = args.model as string | undefined;
          const svg = generateChart(chart, range, model);
          return {
            content: [{ type: "text", text: svg }],
            isError: false,
          };
        }
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}

// ── SVG chart generation ────────────────────────────────────────

function generateChart(
  chartType: string,
  range: { fromTs: number; toTs: number },
  model?: string,
): string {
  const W = 800;
  const H = 300;
  const PAD = { top: 30, right: 20, bottom: 40, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const colors = ["#58a6ff", "#3fb950", "#f85149", "#d29922", "#d2a8ff", "#79c0ff"];

  // Gather data based on chart type
  const isLlm = chartType.startsWith("llm_");
  let series: { label: string; points: { t: number; v: number }[] }[] = [];

  if (isLlm) {
    const allRows = queryLlmMetrics({ ...range, model, limit: 5000 }) as {
      ts: number;
      model: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      errors: number;
      timeouts: number;
      latency_ms: number;
    }[];

    const fieldMap: Record<string, (r: (typeof allRows)[0]) => number> = {
      llm_requests: (r) => r.requests,
      llm_tokens: (r) => r.input_tokens + r.output_tokens,
      llm_errors: (r) => r.errors + r.timeouts,
      llm_latency: (r) => (r.requests > 0 ? Math.round(r.latency_ms / r.requests) : 0),
    };
    const fn = fieldMap[chartType] ?? fieldMap["llm_requests"]!;

    // Group by model
    const byModel = new Map<string, { t: number; v: number }[]>();
    for (const r of allRows) {
      let pts = byModel.get(r.model);
      if (!pts) {
        pts = [];
        byModel.set(r.model, pts);
      }
      pts.push({ t: r.ts, v: fn(r) });
    }
    for (const [m, pts] of byModel) {
      pts.sort((a, b) => a.t - b.t);
      series.push({ label: m, points: pts });
    }
  } else {
    const rows = querySystemMetrics({ ...range, limit: 5000 }) as {
      ts: number;
      cpu_percent: number;
      mem_used_mb: number;
      mem_total_mb: number;
      gpu_percent: number | null;
      vram_used_mb: number | null;
      vram_total_mb: number | null;
    }[];
    rows.sort((a, b) => a.ts - b.ts);

    const fieldMap: Record<string, { label: string; fn: (r: (typeof rows)[0]) => number }[]> = {
      system_cpu: [{ label: "CPU %", fn: (r) => r.cpu_percent }],
      system_memory: [
        { label: "Used MB", fn: (r) => r.mem_used_mb },
        { label: "Total MB", fn: (r) => r.mem_total_mb },
      ],
      system_gpu: [
        { label: "GPU %", fn: (r) => r.gpu_percent ?? 0 },
        { label: "VRAM MB", fn: (r) => r.vram_used_mb ?? 0 },
      ],
    };

    const fields = fieldMap[chartType] ?? fieldMap["system_cpu"]!;
    for (const { label, fn } of fields) {
      series.push({ label, points: rows.map((r) => ({ t: r.ts, v: fn(r) })) });
    }
  }

  if (series.length === 0 || series.every((s) => s.points.length === 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#0d1117"/>
      <text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#8b949e" font-size="14">No data for ${chartType}</text>
    </svg>`;
  }

  // Compute scales
  const allPts = series.flatMap((s) => s.points);
  const tMin = Math.min(...allPts.map((p) => p.t));
  const tMax = Math.max(...allPts.map((p) => p.t));
  const vMin = 0;
  const vMax = Math.max(...allPts.map((p) => p.v), 1) * 1.1;

  const tRange = tMax - tMin || 1;
  const vRange = vMax - vMin || 1;

  const x = (t: number) => PAD.left + ((t - tMin) / tRange) * plotW;
  const y = (v: number) => PAD.top + plotH - ((v - vMin) / vRange) * plotH;

  // Build SVG
  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace">`);
  lines.push(`<rect width="${W}" height="${H}" fill="#0d1117"/>`);

  // Title
  const titles: Record<string, string> = {
    system_cpu: "CPU Usage (%)",
    system_memory: "Memory (MB)",
    system_gpu: "GPU / VRAM",
    llm_requests: "LLM Requests (per interval)",
    llm_tokens: "LLM Tokens (per interval)",
    llm_errors: "LLM Errors + Timeouts",
    llm_latency: "LLM Avg Latency (ms)",
  };
  lines.push(`<text x="${PAD.left}" y="18" fill="#c9d1d9" font-size="13" font-weight="bold">${titles[chartType] ?? chartType}</text>`);

  // Y-axis grid lines
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = vMin + (vRange * i) / yTicks;
    const yy = y(val);
    lines.push(`<line x1="${PAD.left}" y1="${yy}" x2="${W - PAD.right}" y2="${yy}" stroke="#21262d" stroke-width="1"/>`);
    lines.push(`<text x="${PAD.left - 5}" y="${yy + 4}" text-anchor="end" fill="#8b949e" font-size="10">${Math.round(val)}</text>`);
  }

  // X-axis time labels
  const xTicks = Math.min(6, Math.max(2, Math.floor(plotW / 120)));
  for (let i = 0; i <= xTicks; i++) {
    const t = tMin + (tRange * i) / xTicks;
    const xx = x(t);
    const d = new Date(t * 1000);
    const label = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    lines.push(`<text x="${xx}" y="${H - 8}" text-anchor="middle" fill="#8b949e" font-size="10">${label}</text>`);
  }

  // Plot series
  for (let si = 0; si < series.length; si++) {
    const s = series[si]!;
    const color = colors[si % colors.length]!;
    if (s.points.length === 0) continue;

    // Line path
    const pathParts = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
    lines.push(`<path d="${pathParts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.9"/>`);

    // Legend entry
    const lx = PAD.left + si * 160;
    lines.push(`<rect x="${lx}" y="${H - 26}" width="10" height="10" fill="${color}" rx="2"/>`);
    const shortLabel = s.label.length > 20 ? s.label.slice(0, 20) + "…" : s.label;
    lines.push(`<text x="${lx + 14}" y="${H - 17}" fill="#8b949e" font-size="10">${escapeXml(shortLabel)}</text>`);
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
