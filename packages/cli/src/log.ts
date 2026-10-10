// slog-style text lines on stderr: time=... level=INFO msg="..." key=value
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let min: Level = "info";

export function setLevel(s: string): void {
  const v = (s.trim().toLowerCase() || "info").replace("warning", "warn");
  if (!(v in ORDER)) throw new Error(`unknown log-level "${s}"`);
  min = v as Level;
}

const fmt = (v: unknown) => {
  const s = String(v);
  return /^[^\s="]+$/.test(s) ? s : JSON.stringify(s);
};

export function log(level: Level, msg: string, attrs: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[min]) return;
  let line = `time=${new Date().toISOString()} level=${level.toUpperCase()} msg=${fmt(msg)}`;
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) line += ` ${k}=${fmt(v)}`;
  process.stderr.write(line + "\n");
}

export const logger =
  (attrs: Record<string, unknown>) =>
  (level: Level, msg: string, extra: Record<string, unknown> = {}) =>
    log(level, msg, { ...attrs, ...extra });
