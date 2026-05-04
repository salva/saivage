/**
 * Shared time helpers.
 *
 * `relative` — "5s", "12m", "3h", "2d ago" — for at-a-glance freshness.
 * `absolute` — full locale string — for tooltips and hover reveals.
 * `elapsed` — duration since `startedAt` ("1h 23m") for runtime/stage timers.
 *
 * All functions accept an ISO string or undefined and degrade gracefully
 * to "unknown" / "" rather than printing "Invalid Date".
 */

export function absolute(ts?: string | null): string {
  if (!ts) return "unknown";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString();
}

export function relative(ts?: string | null, nowMs: number = Date.now()): string {
  if (!ts) return "";
  const date = new Date(ts);
  const time = date.getTime();
  if (Number.isNaN(time)) return "";
  const ms = nowMs - time;
  if (ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return absolute(ts);
}

export function elapsed(startedAt?: string | null, nowMs: number = Date.now()): string {
  if (!startedAt) return "";
  const date = new Date(startedAt);
  const time = date.getTime();
  if (Number.isNaN(time)) return "";
  const secs = Math.max(0, Math.floor((nowMs - time) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function clockTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
