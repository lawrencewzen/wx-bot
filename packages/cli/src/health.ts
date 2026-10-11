// Poller health, written by `run` to state_dir/<binding>/health.json and read
// by `status` / `health` from other processes.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PollHealth } from "@wx-bot/core";
import { writeAtomic } from "./fsutil.ts";

export interface HealthFile {
  pid: number;
  started_at: string;
  updated_at: string;
  last_ok_at?: string;
  failing_since?: string;
  failures: number;
  last_error?: string;
  /** Proxy the run process uses for https, without credentials ("" = direct). */
  proxy: string;
}

/** Heartbeat interval while healthy; a file older than STALE_MS means the poller is stuck. */
const OK_WRITE_MS = 30_000;
export const STALE_MS = 5 * 60_000;

export const healthPath = (stateDir: string, binding: string) => join(stateDir, binding, "health.json");

const iso = (ms: number) => new Date(ms).toISOString();

/** The proxy Bun's fetch uses for https URLs, with user:password removed. */
export function proxyFromEnv(env: Record<string, string | undefined> = process.env): string {
  const raw = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY || "";
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(invalid)";
  }
}

export class HealthWriter {
  private h: HealthFile;
  private lastWrite = 0;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    const t = iso(this.now());
    this.h = { pid: process.pid, started_at: t, updated_at: t, failures: 0, proxy: proxyFromEnv() };
    this.write();
  }

  get proxy(): string {
    return this.h.proxy;
  }

  update(r: PollHealth): void {
    const now = this.now();
    if (r.ok) {
      const changed = this.h.failures > 0 || !this.h.last_ok_at;
      this.h.last_ok_at = iso(now);
      this.h.failures = 0;
      delete this.h.failing_since;
      delete this.h.last_error;
      if (!changed && now - this.lastWrite < OK_WRITE_MS) return;
    } else {
      this.h.failing_since ??= iso(now);
      this.h.failures++;
      this.h.last_error = r.error;
    }
    this.write();
  }

  /** Clean shutdown: the binding is no longer being polled. */
  close(): void {
    rmSync(this.path, { force: true });
  }

  private write() {
    const now = this.now();
    this.h.updated_at = iso(now);
    this.lastWrite = now;
    try {
      writeAtomic(this.path, JSON.stringify(this.h, null, 2) + "\n");
    } catch {}
  }
}

export function readHealth(path: string): HealthFile | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type PollState = "ok" | "starting" | "failing" | "stalled" | "not_running";

export interface PollStatus {
  state: PollState;
  /** ms since the last successful poll (ok) or since failures began (failing). */
  for_ms?: number;
  failures?: number;
  error?: string;
  proxy?: string;
}

export function pollStatus(h: HealthFile | undefined, now = Date.now(), alive = pidAlive): PollStatus {
  if (!h || !alive(h.pid)) return { state: "not_running" };
  const proxy = h.proxy;
  if (now - Date.parse(h.updated_at) > STALE_MS) return { state: "stalled", for_ms: now - Date.parse(h.updated_at), proxy };
  if (h.failures > 0) {
    return { state: "failing", for_ms: now - Date.parse(h.failing_since ?? h.updated_at), failures: h.failures, error: h.last_error, proxy };
  }
  if (!h.last_ok_at) return { state: "starting", proxy };
  return { state: "ok", for_ms: now - Date.parse(h.last_ok_at), proxy };
}

/** "3m12s", "45s". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function describePoll(p: PollStatus): string {
  switch (p.state) {
    case "ok":
      return `ok (last poll ${ago(p.for_ms!)} ago)`;
    case "starting":
      return "starting";
    case "failing":
      return `failing for ${ago(p.for_ms!)} (${p.failures} errors): ${p.error ?? ""}`;
    case "stalled":
      return `stalled (no update for ${ago(p.for_ms!)})`;
    case "not_running":
      return "not running";
  }
}
