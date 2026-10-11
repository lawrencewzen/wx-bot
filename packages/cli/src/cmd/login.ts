import { LoginApi, QR_LIFETIME_MS } from "@wx-bot/core";
import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import QRCode from "qrcode";
import { findBinding, loadConfig } from "../config.ts";
import { formatDuration, parseDuration } from "../duration.ts";
import { FlagError, parseFlags, usageLines } from "../flags.ts";
import { writeAtomic } from "../fsutil.ts";
import { Store } from "../state.ts";

const SPEC = {
  "qr-png": {
    type: "string",
    usage: "also write each QR code as a PNG: qr.png -> qr-1-<id>.png, qr-2-<id>.png, ... (for agents that send it as an image); removed when login ends",
    default: "",
  },
  timeout: { type: "string", usage: "give up if not scanned within this time; a new QR is shown every ~2m", default: "10m0s" },
} as const;

/**
 * One file per QR, unique across logins: chat apps may cache an attachment by
 * its path, so a reused path (even from an earlier login) shows an old code.
 */
export function qrPngPath(base: string, n: number, id: string): string {
  const ext = extname(base) || ".png";
  const tag = id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8);
  return join(dirname(base), `${basename(base, extname(base))}-${n}${tag ? `-${tag}` : ""}${ext}`);
}

/** Remove base and every base-<n> PNG next to it. */
function removeQrPngs(base: string) {
  rmSync(base, { force: true });
  const ext = extname(base) || ".png";
  const re = new RegExp(`^${basename(base, extname(base)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+(-[0-9a-zA-Z]+)?${ext.replace(".", "\\.")}$`);
  try {
    for (const f of readdirSync(dirname(base))) if (re.test(f)) rmSync(join(dirname(base), f), { force: true });
  } catch {}
}

/** UTC timestamp without milliseconds, e.g. 2026-10-10T14:41:05Z. */
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export async function cmdLogin(configPath: string, args: string[]): Promise<number> {
  const usage = () => console.error(`usage: wx-bot login [--qr-png PATH] [--timeout 10m] <binding>\n${usageLines(SPEC)}`);
  let qrPng: string;
  let timeoutMs: number;
  let name: string;
  try {
    // Accept flags before or after the binding name.
    const first = parseFlags(args, SPEC);
    if (first.rest.length < 1) return usage(), 2;
    name = first.rest[0]!;
    const second = parseFlags(first.rest.slice(1), {
      "qr-png": { ...SPEC["qr-png"], default: first.values["qr-png"] },
      timeout: { ...SPEC.timeout, default: first.values.timeout },
    });
    if (second.rest.length !== 0) return usage(), 2;
    qrPng = second.values["qr-png"];
    timeoutMs = parseDuration(second.values.timeout);
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    else if (!(err instanceof FlagError)) console.error((err as Error).message);
    return usage(), 2;
  }

  const cfg = await loadConfig(configPath).catch((e: Error) => e);
  if (cfg instanceof Error) return console.error(`wx-bot: ${cfg.message}`), 1;
  const b = findBinding(cfg, name);
  if (!b) return console.error(`wx-bot: unknown binding "${name}"`), 1;

  // A PNG left over from an earlier run is already expired; never let it be sent.
  const removePng = () => qrPng && removeQrPngs(qrPng);
  removePng();

  const ctl = new AbortController();
  const stop = () => ctl.abort(new Error("interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = timeoutMs > 0 ? setTimeout(() => ctl.abort(new Error(`not scanned within ${formatDuration(timeoutMs)}`)), timeoutMs) : undefined;

  let session;
  try {
    session = await new LoginApi().login(async (qr, attempt) => {
      const now = Date.now();
      console.log(attempt === 1 ? "请用微信扫描以下二维码登录：" : "二维码已过期，请扫描新二维码：");
      console.log(`QR #${attempt} id=${qr.qrcode.slice(0, 8)} generated_at=${utc(now)} expires_at=${utc(now + QR_LIFETIME_MS)} (UTC, 约 2 分钟有效)`);
      if (!qr.imageContent) return;
      process.stdout.write(await QRCode.toString(qr.imageContent, { type: "terminal", small: true, errorCorrectionLevel: "L" }));
      console.log(qr.imageContent);
      if (qrPng) {
        try {
          const path = qrPngPath(qrPng, attempt, qr.qrcode);
          // 0644 and the directory untouched: a chat app serving the file may run as another user.
          writeAtomic(path, await QRCode.toBuffer(qr.imageContent, { type: "png", errorCorrectionLevel: "M", scale: 8, margin: 4 }), 0o644);
          console.log(`QR PNG: ${path}`);
        } catch (err) {
          console.error(`wx-bot login: write qr png: ${(err as Error).message}`);
        }
      }
    }, ctl.signal, timeoutMs > 0 ? Infinity : undefined);
  } catch (err) {
    const reason = ctl.signal.aborted ? (ctl.signal.reason as Error) : (err as Error);
    console.error(`wx-bot login: ${reason.message}`);
    return 1;
  } finally {
    clearTimeout(timer);
    removePng();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  try {
    const store = new Store(cfg.state_dir, name);
    store.saveSession(session);
    store.clearExpired();
  } catch (err) {
    console.error(`wx-bot login: save session: ${(err as Error).message}`);
    return 1;
  }
  const allow = b.allow_wxids.length > 0 ? b.allow_wxids.join(", ") : session.ilink_user_id;
  console.log(`login ok\nbinding: ${name}\nilink_user_id: ${session.ilink_user_id}\nallowlist: ${allow}`);
  return 0;
}
