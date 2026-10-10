#!/usr/bin/env bun
import { defaultConfigPath } from "./config.ts";
import { cmdInbox } from "./cmd/inbox.ts";
import { cmdLogin } from "./cmd/login.ts";
import { cmdRun } from "./cmd/run.ts";
import { cmdSend } from "./cmd/send.ts";
import { cmdStatus } from "./cmd/status.ts";
import { FlagError, parseFlags, usageLines } from "./flags.ts";
import { setLevel } from "./log.ts";

declare const WXBOT_VERSION: string | undefined;
export const VERSION = typeof WXBOT_VERSION === "string" ? WXBOT_VERSION : "dev";

const SPEC = {
  config: { type: "string", usage: "path to config.json (default ~/.config/wx-bot/config.json)", default: "" },
  "log-level": { type: "string", usage: "log level: debug, info, warn, error", default: "info" },
} as const;

function usage() {
  process.stderr.write(`wx-bot — WeChat iLink bridge for personal agent bots

Usage:
  wx-bot [flags] <command> [args]

Commands:
  login <binding>   Scan QR to log in a binding
  run               Poll iLink, queue messages, deliver to webhooks
  send              Send a message (see wx-bot send -h)
  inbox             Claim / ack queued events for pull bindings (see wx-bot inbox)
  status            Show per-binding login / delivery / inbox state
  version           Print version

Flags:
${usageLines(SPEC)}

Replies are plain text. Do not send Markdown; the agent should strip it.

Platforms: Linux and macOS only.
`);
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(argv, SPEC);
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    usage();
    return 2;
  }
  const [cmd, ...rest] = parsed.rest;
  if (!cmd) return usage(), 2;
  try {
    setLevel(parsed.values["log-level"]);
  } catch (err) {
    return console.error(`wx-bot: ${(err as Error).message}`), 2;
  }
  if (cmd === "version") return console.log(`wx-bot ${VERSION}`), 0;
  const path = parsed.values.config || defaultConfigPath();
  switch (cmd) {
    case "login":
      return cmdLogin(path, rest);
    case "run":
      return cmdRun(path, rest);
    case "send":
      return cmdSend(path, rest);
    case "status":
      return cmdStatus(path, rest);
    case "inbox":
      return cmdInbox(path, rest);
    case "help":
    case "-h":
    case "--help":
      return usage(), 0;
    default:
      console.error(`wx-bot: unknown command "${cmd}"`);
      usage();
      return 2;
  }
}

if (process.platform === "win32") {
  console.error("wx-bot does not support Windows.");
  process.exit(1);
}
process.exit(await main(process.argv.slice(2)));
