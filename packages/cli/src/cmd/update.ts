// wx-bot update: replace this binary with a GitHub release and restart the service.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { FlagError, parseFlags, usageLines } from "../flags.ts";

const RELEASES = process.env.WXBOT_RELEASE_BASE ?? "https://github.com/lawrencewzen/wx-bot/releases";

const SPEC = {
  check: { type: "bool", usage: "only report whether a newer release exists" },
  version: { type: "string", usage: "install this release tag (e.g. v0.4.0) instead of the latest; also for rollback", default: "" },
  "no-restart": { type: "bool", usage: "do not restart a running wx-bot service" },
} as const;

const USAGE = `usage: wx-bot update [--check] [--version vX.Y.Z] [--no-restart]

Downloads the release for this platform, verifies its sha256, replaces this
binary and restarts a running wx-bot service. Config, login state and inbox
are kept.
${usageLines(SPEC)}`;

type Semver = [number, number, number];
export function parseSemver(v: string): Semver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}
export function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** Release asset name for this machine. */
export function assetName(platform = process.platform, arch = process.arch, musl = isMusl()): string {
  const os = platform === "darwin" ? "darwin" : "linux";
  const a = arch === "arm64" ? "arm64" : "amd64";
  return `wx-bot_${os}_${a}${os === "linux" && musl ? "_musl" : ""}`;
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return readdirSync("/lib").some((f) => f.startsWith("ld-musl-"));
  } catch {
    return false;
  }
}

/** True when running as a `bun build --compile` executable (not `bun main.ts`). */
function isCompiled(): boolean {
  return Bun.main.startsWith("/$bunfs/");
}

/** Resolve "latest" via the releases/latest redirect (no API token or rate limit). */
async function latestTag(): Promise<string> {
  const resp = await fetch(`${RELEASES}/latest`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  await resp.body?.cancel();
  const loc = resp.headers.get("location") ?? "";
  const tag = /\/tag\/([^/?#]+)/.exec(loc)?.[1];
  if (!tag) throw new Error(`cannot determine the latest release (HTTP ${resp.status})`);
  return decodeURIComponent(tag);
}

async function download(url: string): Promise<Uint8Array> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!resp.ok) throw new Error(`download ${url}: HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

export const KEEPALIVE_ASSET = "wx-bot-keepalive";

/** Point the keepalive script's default binary path at where wx-bot is installed. */
export function keepaliveFor(script: string, binary: string): string {
  return script.replace("$HOME/.local/bin/wx-bot", binary);
}

/**
 * Install or refresh wx-bot-keepalive next to the binary from the same
 * release. Releases before v0.4.6 do not ship it; that is not an error.
 */
async function refreshKeepalive(base: string, sums: string, binary: string): Promise<string> {
  const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f[1] === KEEPALIVE_ASSET)?.[0];
  if (!want) return "";
  const data = await download(`${base}/${KEEPALIVE_ASSET}`);
  const got = createHash("sha256").update(data).digest("hex");
  if (got !== want) throw new Error(`sha256 mismatch for ${KEEPALIVE_ASSET}`);
  const dest = join(dirname(binary), KEEPALIVE_ASSET);
  const tmp = `${dest}.new.${process.pid}`;
  writeFileSync(tmp, keepaliveFor(new TextDecoder().decode(data), binary), { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  return dest;
}

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

/** Restart a running wx-bot service; returns a message for the user. */
export function restartService(): string {
  if (process.platform === "linux") {
    if (run("systemctl", ["--user", "is-active", "--quiet", "wx-bot"]).status === 0) {
      return run("systemctl", ["--user", "restart", "wx-bot"]).status === 0
        ? "restarted systemd user service wx-bot"
        : "could not restart: run `systemctl --user restart wx-bot`";
    }
    if (run("systemctl", ["is-active", "--quiet", "wx-bot"]).status === 0) {
      const asRoot = process.getuid?.() === 0;
      const r = asRoot ? run("systemctl", ["restart", "wx-bot"]) : run("sudo", ["-n", "systemctl", "restart", "wx-bot"]);
      return r.status === 0 ? "restarted systemd service wx-bot" : "the systemd service wx-bot is running; restart it: sudo systemctl restart wx-bot";
    }
  }
  if (process.platform === "darwin" && run("launchctl", ["list", "com.lawrencewzen.wx-bot"]).status === 0) {
    const uid = process.getuid?.() ?? 0;
    return run("launchctl", ["kickstart", "-k", `gui/${uid}/com.lawrencewzen.wx-bot`]).status === 0
      ? "restarted launchd service com.lawrencewzen.wx-bot"
      : "could not restart: run `launchctl kickstart -k gui/$(id -u)/com.lawrencewzen.wx-bot`";
  }
  const others = run("pgrep", ["-f", "wx-bot.* run( |$)"]).stdout.split("\n").filter((p) => p && Number(p) !== process.pid);
  if (others.length > 0) return "a `wx-bot run` process is running outside a service manager; restart it to use the new version";
  return "no running wx-bot service found; start it as usual";
}

export async function cmdUpdate(current: string, args: string[]): Promise<number> {
  let v: { check: boolean; version: string; "no-restart": boolean };
  try {
    const p = parseFlags(args, SPEC);
    if (p.rest.length) throw new FlagError(`unexpected argument: ${p.rest[0]}`);
    v = p.values as typeof v;
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    console.error(USAGE);
    return 2;
  }

  let tag: string;
  try {
    tag = v.version || (await latestTag());
  } catch (err) {
    return console.error(`wx-bot update: ${(err as Error).message}`), 1;
  }
  const cur = parseSemver(current);
  const next = parseSemver(tag);
  const cmp = cur && next ? compareSemver(next, cur) : tag === current ? 0 : 1;

  if (v.check) {
    if (cmp > 0) console.log(`update available: ${current} -> ${tag}\nrun: wx-bot update`);
    else console.log(`wx-bot ${current} is up to date (latest release: ${tag})`);
    return 0;
  }
  if (!v.version && cmp <= 0) {
    console.log(`wx-bot ${current} is up to date (latest release: ${tag})`);
    return 0;
  }
  if (!isCompiled()) {
    console.error("wx-bot update: this is not an installed wx-bot binary (running from source?); use install.sh instead");
    return 1;
  }

  const target = process.execPath;
  const asset = assetName();
  const base = `${RELEASES}/download/${encodeURIComponent(tag)}`;
  console.log(`downloading ${asset} ${tag}`);
  let bin: Uint8Array;
  let sums: string;
  try {
    sums = new TextDecoder().decode(await download(`${base}/checksums.txt`));
    const want = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f[1] === asset)?.[0];
    if (!want) throw new Error(`checksums.txt has no entry for ${asset}`);
    bin = await download(`${base}/${asset}`);
    const got = createHash("sha256").update(bin).digest("hex");
    if (got !== want) throw new Error(`sha256 mismatch for ${asset}: got ${got}, want ${want}`);
  } catch (err) {
    return console.error(`wx-bot update: ${(err as Error).message}`), 1;
  }

  const tmp = join(dirname(target), `.wx-bot.new.${process.pid}`);
  try {
    writeFileSync(tmp, bin, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    const check = run(tmp, ["version"]);
    if (check.status !== 0) throw new Error(`the downloaded binary does not run here: ${(check.stderr || check.stdout).trim()}`);
    // Atomic swap; a running binary cannot be overwritten in place on Linux.
    renameSync(tmp, target);
  } catch (err) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    const e = err as NodeJS.ErrnoException;
    const hint = e.code === "EACCES" || e.code === "EPERM" ? ` (no permission to write ${dirname(target)}; rerun with sudo)` : "";
    return console.error(`wx-bot update: ${e.message}${hint}`), 1;
  }
  console.log(`wx-bot updated: ${current} -> ${tag} (${target})`);
  try {
    const ka = await refreshKeepalive(base, sums, target);
    if (ka) console.log(`updated ${ka}`);
  } catch (err) {
    console.error(`wx-bot update: keepalive script not updated: ${(err as Error).message}`);
  }
  console.log("Config, login state and inbox are unchanged; no need to scan the QR code again.");
  if (!v["no-restart"]) console.log(restartService());
  return 0;
}
