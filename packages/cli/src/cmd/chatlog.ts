import { findBinding, loadConfig } from "../config.ts";
import { hasChatlogFiles, queryChatlog, type ChatlogMedia, type ChatlogRecord } from "../chatlog.ts";
import { parseDuration } from "../duration.ts";
import { FlagError, parseFlags, usageLines } from "../flags.ts";

const SPEC = {
  binding: { type: "string", usage: "binding to read (default: all binding directories)", default: "" },
  since: { type: "string", usage: "how far back to read; Go duration or Nd", default: "24h" },
  with: { type: "string", usage: "only records with this wxid", default: "" },
  limit: { type: "int", usage: "max records to print (most recent in the window)", default: 200 },
  json: { type: "bool", usage: 'print {"records":[...]} instead of text', default: false },
} as const;

const USAGE = `usage: wx-bot chatlog [--binding B] [--since 24h] [--with <wxid>] [--limit 200] [--json]
${usageLines(SPEC)}

Prints recorded WeChat messages for the agent to read.
--since is a Go-style duration (30m, 24h) plus day counts like 3d (N×24h).
Default output is text, one record per line (or a few); --json prints {"records":[...]} as stored.
`;

export const CHATLOG_DISABLED =
  '聊天记录未开启：在 config.json 根级设置 "chatlog_days": 30 后重启 wx-bot run';

const MEDIA_LABEL: Record<string, string> = { image: "图片", voice: "语音", file: "文件", video: "视频" };

/** "3d" is N×24h; everything else is parseDuration. */
export function parseSince(s: string): number {
  const t = s.trim();
  const m = /^(\d+)d$/.exec(t);
  if (m) return Number(m[1]) * 24 * 3_600_000;
  return parseDuration(s);
}

function formatMedia(m: ChatlogMedia): string {
  const label = MEDIA_LABEL[m.type] ?? m.type;
  const bits = [label];
  if (m.file_name) bits.push(m.file_name);
  if (m.path) bits.push(m.path);
  return `[${bits.join(" ")}]`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatChatlog(rec: ChatlogRecord): string {
  const d = new Date(rec.ts);
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const arrow = rec.dir === "out" ? "→" : "←";
  const by = rec.by === "wx-bot" ? " (wx-bot)" : "";
  const head = `${stamp} ${arrow} ${rec.wxid ?? ""}${by}`;
  const parts: string[] = [];
  for (const m of rec.media ?? []) parts.push(formatMedia(m));
  if (rec.caption) parts.push(rec.caption);
  if (rec.voice_text) parts.push(`[语音] ${rec.voice_text}`);
  if (rec.text) parts.push(rec.text);
  const body = parts.join(" ");
  if (!body) return head;
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const [first, ...rest] = lines;
  return [`${head}: ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
}

export async function cmdChatlog(configPath: string, args: string[], nowMs = Date.now()): Promise<number> {
  let parsed: ReturnType<typeof parseFlags<typeof SPEC>>;
  try {
    parsed = parseFlags(args, SPEC);
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    return process.stderr.write(USAGE), 2;
  }
  if (parsed.rest.length !== 0) return process.stderr.write(USAGE), 2;
  const v = parsed.values;
  if (v.limit < 0) return console.error("wx-bot chatlog: --limit must be >= 0"), 2;
  let sinceMs: number;
  try {
    sinceMs = parseSince(v.since);
  } catch (err) {
    return console.error(`wx-bot chatlog: ${(err as Error).message}`), 2;
  }

  const cfg = await loadConfig(configPath).catch((e: Error) => e);
  if (cfg instanceof Error) return console.error(`wx-bot: ${cfg.message}`), 1;
  if (v.binding && !findBinding(cfg, v.binding)) return console.error(`wx-bot chatlog: unknown binding "${v.binding}"`), 1;
  if (cfg.chatlog_days <= 0 && !hasChatlogFiles(cfg)) return console.error(CHATLOG_DISABLED), 1;

  const records = queryChatlog(cfg, {
    sinceMs: nowMs - sinceMs,
    untilMs: nowMs,
    binding: v.binding || undefined,
    with: v.with || undefined,
    limit: v.limit,
  });
  if (v.json) {
    console.log(JSON.stringify({ records }));
    return 0;
  }
  for (const rec of records) console.log(formatChatlog(rec));
  return 0;
}
