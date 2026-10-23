import { chmodSync, closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SendRequest, WxEvent } from "@wx-bot/core";
import type { Config } from "./config.ts";
import { mkdir0700 } from "./fsutil.ts";
import { log } from "./log.ts";

export interface ChatlogMedia {
  type: "image" | "voice" | "file" | "video";
  path?: string;
  file_name: string;
}

export interface ChatlogRecord {
  ts: number;
  dir: "in" | "out";
  binding: string;
  wxid: string;
  event_id?: string;
  by?: "agent" | "wx-bot";
  text?: string;
  voice_text?: string;
  media?: ChatlogMedia[];
  caption?: string;
}

/** Local calendar date YYYY-MM-DD for a unix-ms timestamp. */
export function localDay(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function chatlogPath(cfg: Config, binding: string, tsMs: number): string {
  return join(cfg.state_dir, "chatlog", binding, `${localDay(tsMs)}.jsonl`);
}

export function addLocalDays(ymd: string, n: number): string {
  const [ys, ms, ds] = ymd.split("-");
  return localDay(new Date(Number(ys), Number(ms) - 1, Number(ds) + n).getTime());
}

export function chatlogRoot(cfg: Config): string {
  return join(cfg.state_dir, "chatlog");
}

/** Local calendar dates whose files can overlap [fromMs, toMs]. */
export function localDaysOverlapping(fromMs: number, toMs: number): string[] {
  if (toMs < fromMs) return [];
  const days: string[] = [];
  let d = localDay(fromMs);
  const end = localDay(toMs);
  while (d <= end) {
    days.push(d);
    d = addLocalDays(d, 1);
  }
  return days;
}

function listBindingDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => {
      try {
        return statSync(join(root, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** True if any JSONL file exists under the chatlog directory. */
export function hasChatlogFiles(cfg: Config): boolean {
  const root = chatlogRoot(cfg);
  if (!existsSync(root)) return false;
  for (const name of listBindingDirs(root)) {
    try {
      for (const f of readdirSync(join(root, name))) {
        if (f.endsWith(".jsonl")) return true;
      }
    } catch {}
  }
  return false;
}

function readChatlogFile(path: string): ChatlogRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: ChatlogRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as ChatlogRecord;
      if (rec && typeof rec === "object" && !Array.isArray(rec)) out.push(rec);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export interface ChatlogQuery {
  sinceMs: number;
  untilMs: number;
  binding?: string;
  with?: string;
  limit: number;
}

/** Merge records from date files that overlap the window, oldest first. */
export function queryChatlog(cfg: Config, q: ChatlogQuery): ChatlogRecord[] {
  const root = chatlogRoot(cfg);
  const bindings = q.binding ? [q.binding] : listBindingDirs(root);
  const recs: ChatlogRecord[] = [];
  for (const binding of bindings) {
    for (const day of localDaysOverlapping(q.sinceMs, q.untilMs)) {
      for (const rec of readChatlogFile(join(root, binding, `${day}.jsonl`))) {
        if (typeof rec.ts !== "number") continue;
        if (rec.ts < q.sinceMs || rec.ts > q.untilMs) continue;
        if (q.with && rec.wxid !== q.with) continue;
        recs.push(rec);
      }
    }
  }
  recs.sort((a, b) => a.ts - b.ts);
  return q.limit < recs.length ? recs.slice(recs.length - q.limit) : recs;
}

function encodeMedia(m: ChatlogMedia): Record<string, unknown> {
  const item: Record<string, unknown> = { type: m.type };
  if (m.path) item.path = m.path;
  item.file_name = m.file_name;
  return item;
}

/** Fixed key order; omit absent fields. */
export function encodeChatlog(rec: ChatlogRecord): string {
  const line: Record<string, unknown> = { ts: rec.ts, dir: rec.dir, binding: rec.binding, wxid: rec.wxid };
  if (rec.event_id) line.event_id = rec.event_id;
  if (rec.by) line.by = rec.by;
  if (rec.text) line.text = rec.text;
  if (rec.voice_text) line.voice_text = rec.voice_text;
  if (rec.media?.length) line.media = rec.media.map(encodeMedia);
  if (rec.caption) line.caption = rec.caption;
  return JSON.stringify(line) + "\n";
}

export function fromInbound(ev: WxEvent, nowMs = Date.now()): ChatlogRecord {
  const rec: ChatlogRecord = {
    ts: ev.create_time > 0 ? ev.create_time * 1000 : nowMs,
    dir: "in",
    binding: ev.binding,
    wxid: ev.from_wxid,
    event_id: ev.event_id,
  };
  if (ev.text) rec.text = ev.text;
  if (ev.voice_text) rec.voice_text = ev.voice_text;
  if (ev.media.length) {
    rec.media = ev.media.map((m) => {
      const item: ChatlogMedia = { type: m.type, file_name: m.file_name };
      if (m.path) item.path = m.path;
      return item;
    });
  }
  return rec;
}

export function fromOutbound(req: SendRequest, by: "agent" | "wx-bot", nowMs = Date.now()): ChatlogRecord {
  const rec: ChatlogRecord = { ts: nowMs, dir: "out", binding: req.binding, wxid: req.to, by };
  if (req.text) rec.text = req.text;
  if (req.media) {
    const item: ChatlogMedia = { type: req.media.kind, file_name: req.media.fileName };
    if (req.media.path) item.path = resolve(req.media.path);
    rec.media = [item];
  }
  if (req.caption) rec.caption = req.caption;
  return rec;
}

/**
 * Append one JSONL line. No-op when chatlog_days is 0. Throws on write
 * failure; callers must not let that fail send/receive.
 */
export function appendChatlog(cfg: Config, binding: string, rec: ChatlogRecord): void {
  if (cfg.chatlog_days <= 0) return;
  const path = chatlogPath(cfg, binding, rec.ts);
  mkdir0700(join(cfg.state_dir, "chatlog"));
  mkdir0700(join(cfg.state_dir, "chatlog", binding));
  const line = encodeChatlog(rec);
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

/** Log a warning instead of throwing, so send/receive still succeed. */
export function recordChatlog(cfg: Config, binding: string, rec: ChatlogRecord): void {
  try {
    appendChatlog(cfg, binding, rec);
  } catch (err) {
    log("warn", "chatlog", { err: (err as Error).message });
  }
}

export function recordInbound(cfg: Config, ev: WxEvent): void {
  if (ev.kind !== "message") return;
  recordChatlog(cfg, ev.binding, fromInbound(ev));
}

export function recordOutbound(cfg: Config, req: SendRequest, by: "agent" | "wx-bot" = "agent"): void {
  recordChatlog(cfg, req.binding, fromOutbound(req, by));
}

/**
 * Delete per-binding JSONL files older than chatlog_days (local dates).
 * chatlog_days 0 leaves history in place.
 */
export function pruneChatlog(cfg: Config, nowMs = Date.now()): void {
  if (cfg.chatlog_days <= 0) return;
  const root = join(cfg.state_dir, "chatlog");
  if (!existsSync(root)) return;
  const cutoff = addLocalDays(localDay(nowMs), -cfg.chatlog_days);
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m || m[1]! >= cutoff) continue;
      rmSync(join(dir, f));
    }
  }
}
