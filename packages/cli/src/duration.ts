/** Parse a Go-style duration ("300ms", "1.5s", "5m", "1h30m", "0") to milliseconds. */
export function parseDuration(s: string): number {
  const t = s.trim();
  if (t === "0") return 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  const unit: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  let consumed = 0;
  for (const m of t.matchAll(re)) {
    if (m.index !== consumed) break;
    total += Number(m[1]) * unit[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed === 0 || consumed !== t.length) throw new Error(`invalid duration "${s}"`);
  return total;
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h0m0s`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m0s`;
  return `${ms / 1000}s`;
}
