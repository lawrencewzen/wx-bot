import { LoginApi, QR_MAX_EXPIRY } from "@wx-bot/core";
import QRCode from "qrcode";
import { findBinding, loadConfig } from "../config.ts";
import { FlagError, parseFlags, usageLines } from "../flags.ts";
import { writeAtomic } from "../fsutil.ts";
import { Store } from "../state.ts";

const SPEC = {
  "qr-png": { type: "string", usage: "also write the QR code as a PNG to this path (for agents that send it as an image)", default: "" },
} as const;

export async function cmdLogin(configPath: string, args: string[]): Promise<number> {
  const usage = () => console.error(`usage: wx-bot login [--qr-png PATH] <binding>\n${usageLines(SPEC)}`);
  let qrPng: string;
  let name: string;
  try {
    // Accept flags before or after the binding name.
    const first = parseFlags(args, SPEC);
    if (first.rest.length < 1) return usage(), 2;
    name = first.rest[0]!;
    const second = parseFlags(first.rest.slice(1), { "qr-png": { ...SPEC["qr-png"], default: first.values["qr-png"] } });
    if (second.rest.length !== 0) return usage(), 2;
    qrPng = second.values["qr-png"];
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    return usage(), 2;
  }

  const cfg = await loadConfig(configPath).catch((e: Error) => e);
  if (cfg instanceof Error) return console.error(`wx-bot: ${cfg.message}`), 1;
  const b = findBinding(cfg, name);
  if (!b) return console.error(`wx-bot: unknown binding "${name}"`), 1;

  const ctl = new AbortController();
  const stop = () => ctl.abort(new Error("interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let session;
  try {
    session = await new LoginApi().login(async (qr, attempt) => {
      console.log(attempt === 1 ? "请用微信扫描以下二维码登录：" : `二维码已过期，请扫描新二维码（第 ${attempt}/${QR_MAX_EXPIRY} 次）：`);
      if (!qr.imageContent) return;
      process.stdout.write(await QRCode.toString(qr.imageContent, { type: "terminal", small: true, errorCorrectionLevel: "L" }));
      console.log(qr.imageContent);
      if (qrPng) {
        try {
          writeAtomic(qrPng, await QRCode.toBuffer(qr.imageContent, { type: "png", errorCorrectionLevel: "M", scale: 8, margin: 4 }));
          console.log(`QR PNG: ${qrPng}`);
        } catch (err) {
          console.error(`wx-bot login: write qr png: ${(err as Error).message}`);
        }
      }
    }, ctl.signal);
  } catch (err) {
    console.error(`wx-bot login: ${(err as Error).message}`);
    return 1;
  } finally {
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
