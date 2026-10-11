// wx-bot uninstall: stop services and remove what wx-bot installed or wrote.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defaultStateDir } from "../config.ts";
import { FlagError, parseFlags, usageLines } from "../flags.ts";

const SPEC = {
  yes: { type: "bool", usage: "actually remove; without it only the plan is printed" },
  "keep-data": { type: "bool", usage: "keep config and login state (state_dir) so a reinstall needs no QR scan" },
} as const;

const USAGE = `usage: wx-bot uninstall [--yes] [--keep-data]

Stops the wx-bot service and removes the service files, config, login state,
inbox, media, logs, QR images and the wx-bot binaries. Prints the plan only
unless --yes is given. Agent-side hooks and routines are not touched.
${usageLines(SPEC)}`;

const LAUNCHD = "com.lawrencewzen.wx-bot";
const QR_RE = /^(wx-bot-qr|wxqr).*\.png$/;

export interface Step {
  what: string;
  run: () => void;
}

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const isRoot = () => process.getuid?.() === 0;
/** Run as root when we are root, else through non-interactive sudo. */
const privileged = (cmd: string, args: string[]) => (isRoot() ? sh(cmd, args) : sh("sudo", ["-n", cmd, ...args]));

/**
 * A directory is removed whole only when it is clearly wx-bot's own (its name
 * is wx-bot, or it sits inside one); a custom path such as ~ is never removed.
 */
export function ownedDir(path: string, home = homedir()): boolean {
  const p = resolve(path);
  if (p === "/" || p === resolve(home)) return false;
  return p.split("/").includes("wx-bot");
}

/** state_dir / media_dir from the config file without resolving env: values. */
export function dataDirs(configPath: string): { state: string; media: string } {
  const expand = (s: unknown) => (typeof s === "string" && s && !s.startsWith("env:") ? s.replace(/^~(?=\/|$)/, homedir()) : "");
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {}
  const state = expand(raw.state_dir) || defaultStateDir();
  return { state, media: expand(raw.media_dir) || join(state, "media") };
}

function rm(path: string, steps: Step[], what = path) {
  if (!existsSync(path)) return;
  steps.push({ what: `remove ${what}`, run: () => rmSync(path, { recursive: true, force: true }) });
}

function rmRootFile(path: string, steps: Step[]) {
  if (!existsSync(path)) return;
  steps.push({
    what: `remove ${path}${isRoot() ? "" : " (sudo)"}`,
    run: () => {
      if (privileged("rm", ["-f", path]).status !== 0) throw new Error(`could not remove ${path}: run sudo rm -f ${path}`);
    },
  });
}

export function plan(configPath: string, keepData: boolean, binary: string | undefined): { steps: Step[]; skipped: string[] } {
  const home = homedir();
  const steps: Step[] = [];
  const skipped: string[] = [];

  // 1. Services.
  if (process.platform === "linux") {
    if (sh("systemctl", ["--user", "cat", "wx-bot"]).status === 0) {
      steps.push({ what: "systemctl --user disable --now wx-bot", run: () => void sh("systemctl", ["--user", "disable", "--now", "wx-bot"]) });
    }
    if (sh("systemctl", ["cat", "wx-bot"]).status === 0) {
      steps.push({
        what: `systemctl disable --now wx-bot${isRoot() ? "" : " (sudo)"}`,
        run: () => {
          if (privileged("systemctl", ["disable", "--now", "wx-bot"]).status !== 0) {
            throw new Error("could not stop the system service: run sudo systemctl disable --now wx-bot");
          }
        },
      });
    }
  }
  const plists = [join(home, "Library/LaunchAgents", `${LAUNCHD}.plist`), `/Library/LaunchAgents/${LAUNCHD}.plist`];
  if (process.platform === "darwin") {
    for (const p of plists.filter(existsSync)) steps.push({ what: `launchctl unload ${p}`, run: () => void sh("launchctl", ["unload", "-w", p]) });
  }

  // 2. Processes started outside a service manager (run, login, keepalive's nohup).
  steps.push({
    what: "stop other wx-bot run / login processes",
    run: () => {
      const pids = sh("pgrep", ["-f", "wx-bot.* (run|login)( |$)"]).stdout.split("\n").map(Number).filter((p) => p && p !== process.pid);
      for (const p of pids) {
        try {
          process.kill(p, "SIGTERM");
        } catch {}
      }
    },
  });

  // 3. Service files.
  rm(join(home, ".config/systemd/user/wx-bot.service"), steps);
  rmRootFile("/etc/systemd/system/wx-bot.service", steps);
  rm(plists[0]!, steps);
  rmRootFile(plists[1]!, steps);
  if (process.platform === "linux" && steps.some((s) => s.what.includes("wx-bot.service"))) {
    steps.push({
      what: "systemctl daemon-reload",
      run: () => {
        sh("systemctl", ["--user", "daemon-reload"]);
        privileged("systemctl", ["daemon-reload"]);
      },
    });
  }

  // 4. Config, login state, inbox, media.
  if (!keepData) {
    const cfgDir = dirname(resolve(configPath));
    if (ownedDir(cfgDir, home)) rm(cfgDir, steps);
    else {
      rm(configPath, steps);
      rm(join(cfgDir, "env"), steps);
    }
    const { state, media } = dataDirs(configPath);
    for (const d of [state, media]) {
      if (!existsSync(d)) continue;
      if (ownedDir(d, home)) rm(d, steps);
      else skipped.push(`${d} (custom path; remove wx-bot files there yourself)`);
    }
  }

  // 5. Logs, hook state, QR images.
  rm(join(home, ".cache/wx-bot"), steps);
  rm(join(home, "wx-bot-login.log"), steps);
  for (const dir of [home, join(home, "workspace")]) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => QR_RE.test(f));
    } catch {}
    for (const f of files) rm(join(dir, f), steps);
  }

  // 6. Undo a 0700 ~/workspace left by wx-bot v0.4.1–v0.4.2 (--qr-png forced it).
  const ws = join(home, "workspace");
  try {
    if ((statSync(ws).mode & 0o777) === 0o700) {
      steps.push({ what: `chmod 755 ${ws} (an old wx-bot set it to 700)`, run: () => chmodSync(ws, 0o755) });
    }
  } catch {}

  // 7. Binaries last, so a failure above leaves wx-bot usable.
  if (binary) {
    rm(join(dirname(binary), "wx-bot-keepalive"), steps);
    rm(binary, steps);
  } else {
    skipped.push("the wx-bot binary (running from source)");
  }
  return { steps, skipped };
}

export function cmdUninstall(configPath: string, args: string[]): number {
  let v: { yes: boolean; "keep-data": boolean };
  try {
    const p = parseFlags(args, SPEC);
    if (p.rest.length) throw new FlagError(`unexpected argument: ${p.rest[0]}`);
    v = p.values as typeof v;
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  const compiled = Bun.main.startsWith("/$bunfs/");
  const { steps, skipped } = plan(configPath, v["keep-data"], compiled ? process.execPath : undefined);
  const reminder =
    "Agent side (not done by this command): delete the wx-bot hook (Muse) or the 「微信消息」/「wx-bot 保活」 routines (Grok).";

  if (!v.yes) {
    console.log("wx-bot uninstall would:");
    for (const s of steps) console.log(`  - ${s.what}`);
    for (const s of skipped) console.log(`  - skip ${s}`);
    if (v["keep-data"]) console.log("  (config and login state are kept: a reinstall needs no QR scan)");
    console.log(`\n${reminder}\nRun again with --yes to do it.`);
    return 0;
  }
  let failed = 0;
  for (const s of steps) {
    try {
      s.run();
      console.log(`done: ${s.what}`);
    } catch (err) {
      failed++;
      console.error(`failed: ${s.what}: ${(err as Error).message}`);
    }
  }
  for (const s of skipped) console.log(`skipped: ${s}`);
  console.log(`\n${failed ? `wx-bot uninstalled with ${failed} problem(s) above.` : "wx-bot uninstalled."}\n${reminder}`);
  return failed ? 1 : 0;
}
