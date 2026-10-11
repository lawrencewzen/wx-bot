import { loadConfig } from "../config.ts";
import { parseDuration } from "../duration.ts";
import { FlagError, parseFlags } from "../flags.ts";
import { ago, describePoll, proxyFromEnv } from "../health.ts";
import { statusOf, type BindingStatus } from "./status.ts";

const USAGE = `usage: wx-bot health [--binding B] [--grace 2m] [--liveness]

Checks that wx-bot run is receiving WeChat messages. Prints one line per
binding; exits 1 if any binding is unhealthy (with a hint), 0 otherwise.
Connection errors shorter than --grace count as healthy (still retrying).
--liveness only checks that wx-bot run is up and polling; connection errors
and expired logins are left to the alert events wx-bot run sends the agent.
`;

const SPEC = {
  binding: { type: "string", usage: "binding to check (default: all)", default: "" },
  grace: { type: "string", usage: "how long poll errors are tolerated before reporting unhealthy", default: "2m0s" },
  liveness: { type: "bool", usage: "only report a stopped or stuck wx-bot run", default: false },
} as const;

export interface Verdict {
  ok: boolean;
  line: string;
}

/**
 * Judge one binding. shellProxy is the proxy of the calling shell, compared
 * with the one the run process uses to spot a service started without it.
 */
export function judge(st: BindingStatus, graceMs: number, shellProxy: string, liveness = false): Verdict {
  const n = st.name;
  if (liveness) {
    if (st.expired || !st.logged_in) return { ok: true, line: `${n}: ${st.expired ? "login expired" : "not logged in"} (not a liveness problem)` };
    if (st.poll.state === "not_running" || st.poll.state === "stalled") return judge(st, graceMs, shellProxy);
    return { ok: true, line: `${n}: running (${describePoll(st.poll)})` };
  }
  if (st.expired) return { ok: false, line: `${n}: login expired; run \`wx-bot login ${n}\`, then restart the service` };
  if (!st.logged_in) return { ok: false, line: `${n}: not logged in; run \`wx-bot login ${n}\`, then restart the service` };
  const p = st.poll;
  switch (p.state) {
    case "ok":
    case "starting":
      return { ok: true, line: `${n}: ${describePoll(p)}` };
    case "not_running":
      return { ok: false, line: `${n}: wx-bot run is not running; start or restart the service` };
    case "stalled":
      return { ok: false, line: `${n}: ${describePoll(p)}; restart the service` };
    case "failing": {
      if (p.for_ms! < graceMs) return { ok: true, line: `${n}: retrying for ${ago(p.for_ms!)}: ${p.error ?? ""}` };
      let hint = "check the network, then restart the service";
      if (shellProxy && shellProxy !== p.proxy) {
        hint = p.proxy
          ? `the service uses proxy ${p.proxy} but this shell uses ${shellProxy}; update the proxy lines in ~/.config/wx-bot/env and restart the service`
          : `the service has no proxy but this shell uses ${shellProxy}; add the proxy variables to ~/.config/wx-bot/env and restart the service`;
      } else if (p.proxy) {
        hint = `the service uses proxy ${p.proxy}; if its credentials changed, update ~/.config/wx-bot/env and restart the service`;
      }
      return { ok: false, line: `${n}: ${describePoll(p)}; ${hint}` };
    }
  }
}

export async function cmdHealth(configPath: string, args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(args, SPEC);
  } catch (err) {
    if (err instanceof FlagError && err.message !== "help") console.error(err.message);
    return process.stderr.write(USAGE), 2;
  }
  if (parsed.rest.length !== 0) return process.stderr.write(USAGE), 2;
  let graceMs: number;
  try {
    graceMs = parseDuration(parsed.values.grace);
  } catch (err) {
    return console.error(`wx-bot health: ${(err as Error).message}`), 2;
  }
  const cfg = await loadConfig(configPath).catch((e: Error) => e);
  if (cfg instanceof Error) return console.error(`wx-bot: ${cfg.message}`), 1;
  const bindings = parsed.values.binding ? cfg.bindings.filter((b) => b.name === parsed.values.binding) : cfg.bindings;
  if (bindings.length === 0) {
    return console.error(parsed.values.binding ? `wx-bot health: unknown binding "${parsed.values.binding}"` : "no bindings configured"), 1;
  }
  const shellProxy = proxyFromEnv();
  let healthy = true;
  for (const b of bindings) {
    const v = judge(statusOf(cfg, b), graceMs, shellProxy, parsed.values.liveness);
    healthy &&= v.ok;
    console.log(v.line);
  }
  return healthy ? 0 : 1;
}
