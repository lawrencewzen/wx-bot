import { PULL_LIMITS, pullResponseBody, pullScope, claimWait } from "@wx-bot/core";
import { inboxPath, loadConfig, pullBindings } from "../config.ts";
import { formatDuration, parseDuration } from "../duration.ts";
import { FlagError, parseFlags } from "../flags.ts";
import { mkdir0700 } from "../fsutil.ts";
import { openInbox } from "../sqlite.ts";

const USAGE = `usage:
  wx-bot inbox count [--binding B]
  wx-bot inbox pull  [--binding B] [--limit N] [--lease 5m] [--wait 0s]
  wx-bot inbox ack   <event_id>...

Only bindings with "delivery": "pull" are served.
count  prints how many events are ready (does not claim; safe for dry runs).
pull   claims events and prints {"events": [...]}; unacked events return after the lease.
ack    marks events handled and prints {"acked": N}.
`;

const SPEC = {
  binding: { type: "string", usage: "pull binding (default: all pull bindings)", default: "" },
  limit: { type: "int", usage: "max events to claim", default: PULL_LIMITS.defaultLimit },
  lease: { type: "string", usage: "how long claimed events stay hidden before redelivery", default: "5m0s" },
  wait: { type: "string", usage: "long-poll: wait up to this long for an event", default: "0s" },
} as const;

export async function cmdInbox(configPath: string, args: string[]): Promise<number> {
  if (args.length === 0) return process.stderr.write(USAGE), 2;
  const [sub, ...rest] = args as [string, ...string[]];
  let parsed: ReturnType<typeof parseFlags<typeof SPEC>>;
  try {
    parsed = parseFlags(rest, SPEC);
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    return process.stderr.write(USAGE), 2;
  }
  const v = parsed.values;
  let leaseMs: number;
  let waitMs: number;
  try {
    leaseMs = parseDuration(v.lease);
    waitMs = parseDuration(v.wait);
  } catch (err) {
    return console.error(`wx-bot inbox: ${(err as Error).message}`), 2;
  }

  const cfg = await loadConfig(configPath).catch((e: Error) => e);
  if (cfg instanceof Error) return console.error(`wx-bot: ${cfg.message}`), 1;
  let scope: string[];
  try {
    scope = pullScope(pullBindings(cfg), v.binding);
  } catch (err) {
    return console.error(`wx-bot inbox: ${(err as Error).message}`), 1;
  }
  let box;
  try {
    mkdir0700(cfg.state_dir);
    box = openInbox(inboxPath(cfg));
  } catch (err) {
    return console.error(`wx-bot inbox: ${(err as Error).message}`), 1;
  }
  try {
    switch (sub) {
      case "count":
        console.log(box.count(scope));
        return 0;
      case "pull": {
        if (v.limit < 1 || v.limit > PULL_LIMITS.maxLimit) return console.error(`wx-bot inbox: --limit must be 1..${PULL_LIMITS.maxLimit}`), 2;
        if (leaseMs < 1000 || leaseMs > PULL_LIMITS.maxLeaseMs) return console.error(`wx-bot inbox: --lease must be 1s..${formatDuration(PULL_LIMITS.maxLeaseMs)}`), 2;
        if (waitMs < 0 || waitMs > PULL_LIMITS.maxWaitMs) return console.error(`wx-bot inbox: --wait must be 0..${formatDuration(PULL_LIMITS.maxWaitMs)}`), 2;
        const ctl = new AbortController();
        const stop = () => ctl.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        const events = await claimWait(box, scope, v.limit, leaseMs, waitMs, ctl.signal);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        console.log(pullResponseBody(events));
        return 0;
      }
      case "ack": {
        if (parsed.rest.length === 0) return process.stderr.write(USAGE), 2;
        console.log(JSON.stringify({ acked: box.ack(scope, parsed.rest) }));
        return 0;
      }
      default:
        console.error(`wx-bot inbox: unknown subcommand "${sub}"`);
        process.stderr.write(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(`wx-bot inbox: ${(err as Error).message}`);
    return 1;
  } finally {
    box.close();
  }
}
