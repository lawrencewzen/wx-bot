import { MAX_MEDIA_BYTES, sendMessage, validateSend, WxBotError, type MediaKind, type SendRequest } from "@wx-bot/core";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadConfig, type Config } from "../config.ts";
import { FlagError, parseFlags, usageLines } from "../flags.ts";
import { openLive } from "../live.ts";

const SPEC = {
  binding: { type: "string", usage: "binding name", default: "" },
  to: { type: "string", usage: "destination wxid", default: "" },
  text: { type: "string", usage: 'plain text (no Markdown); "-" reads it from stdin', default: "" },
  image: { type: "string", usage: "path to an image", default: "" },
  file: { type: "string", usage: "path to a file", default: "" },
  video: { type: "string", usage: "path to a video", default: "" },
  caption: { type: "string", usage: "optional caption sent as a follow-up text", default: "" },
} as const;

const USAGE = `usage: wx-bot send --binding B --to WXID (--text T | --text - | --image P | --file P | --video P) [--caption C]
${usageLines(SPEC)}

Use --text - with a quoted heredoc so quotes and $ in the reply need no escaping:
  wx-bot send --binding B --to WXID --text - <<'EOF'
  ...
  EOF`;

/** Read a local media file (≤100 MB). */
export function readMedia(path: string): { data: Uint8Array; fileName: string } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    throw new WxBotError("bad_request", `read file: ${(err as Error).message}`);
  }
  if (size > MAX_MEDIA_BYTES) throw new WxBotError("too_large", "file too large (>100 MB)");
  return { data: new Uint8Array(readFileSync(path)), fileName: basename(path) };
}

export async function cmdSend(configPath: string, args: string[]): Promise<number> {
  let v: Record<keyof typeof SPEC, string>;
  try {
    v = parseFlags(args, SPEC).values;
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  if (v.text === "-") {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of process.stdin) {
      chunks.push(c as Buffer);
      if ((n += (c as Buffer).length) > 1 << 20) break;
    }
    v.text = Buffer.concat(chunks).subarray(0, 1 << 20).toString("utf8").replace(/[\r\n]+$/, "");
  }
  const cfg = await loadConfig(configPath).catch((e: Error) => e);
  if (cfg instanceof Error) return console.error(`wx-bot: ${cfg.message}`), 1;
  try {
    validateSend({ binding: v.binding, to: v.to, text: v.text, image: v.image, file: v.file, video: v.video });
  } catch (err) {
    return console.error(`wx-bot send: ${(err as Error).message}`), 2;
  }
  // The local API runs in another process with its own working directory.
  for (const k of ["image", "file", "video"] as const) if (v[k]) v[k] = resolve(v[k]);

  const timeoutMs = v.text ? 60_000 : 10 * 60_000;
  const signal = AbortSignal.timeout(timeoutMs);

  // Send directly only when `wx-bot run` is not serving the local API. Once
  // the API has the request its answer is final: falling back could send the
  // message twice and would hide the real error.
  const local = await tryLocalSend(cfg, v, signal);
  if (local.reached) {
    if (local.error) return console.error(`wx-bot send: ${local.error}`), 1;
    return console.log("sent"), 0;
  }
  try {
    const lb = openLive(cfg, v.binding);
    const req: SendRequest = { binding: v.binding, to: v.to, caption: v.caption || undefined };
    if (v.text) req.text = v.text;
    else {
      const kind: MediaKind = v.image ? "image" : v.video ? "video" : "file";
      const f = readMedia(v[kind]);
      req.media = { kind, data: f.data, fileName: f.fileName };
    }
    await sendMessage(lb.client, lb.allow, req);
  } catch (err) {
    return console.error(`wx-bot send: ${(err as Error).message}`), 1;
  }
  console.log("sent");
  return 0;
}

async function tryLocalSend(
  cfg: Config,
  v: Record<string, string>,
  signal: AbortSignal,
): Promise<{ reached: boolean; error?: string }> {
  const base = `http://${cfg.local_api.listen}`;
  try {
    const h = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
    await h.body?.cancel();
    if (h.status !== 200) return { reached: false };
  } catch {
    return { reached: false };
  }
  const body: Record<string, string> = { binding: v.binding!, to: v.to! };
  for (const k of ["text", "image", "file", "video", "caption"]) if (v[k]) body[k] = v[k]!;
  let resp: Response;
  try {
    resp = await fetch(`${base}/v1/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.local_api.token ? { Authorization: `Bearer ${cfg.local_api.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // The request may have been sent; do not retry directly.
    return { reached: true, error: `local api send (outcome unknown, not retried): ${(err as Error).message}` };
  }
  const raw = await resp.text();
  if (resp.status < 300) return { reached: true };
  try {
    const e = JSON.parse(raw) as { error?: string };
    if (e.error) return { reached: true, error: `${e.error} (HTTP ${resp.status})` };
  } catch {}
  return { reached: true, error: `local api send: ${resp.status}: ${raw.trim()}` };
}
