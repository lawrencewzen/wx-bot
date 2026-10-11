import { createApiHandler, deliverNext, Poller, sendMessage, type Inbox, type SendRequest } from "@wx-bot/core";
import { DELIVERY_WEBHOOK, inboxPath, loadConfig, type Config } from "../config.ts";
import { mkdir0700 } from "../fsutil.ts";
import { HealthWriter, healthPath } from "../health.ts";
import { fileMediaSink, openLive, type LiveBinding } from "../live.ts";
import { log, logger } from "../log.ts";
import { openInbox } from "../sqlite.ts";
import { Store } from "../state.ts";
import { readMedia } from "./send.ts";
import { statusAll } from "./status.ts";

/** How long finished events are kept, and how long a pending one may wait. */
const INBOX_RETENTION_MS = 7 * 86_400_000;
const DELIVER_IDLE_MS = 1000;

const sleep = (ms: number, signal: AbortSignal, wake?: (fn: () => void) => () => void) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    const off = wake?.(done);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(t);
      off?.();
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

export async function cmdRun(configPath: string, args: string[]): Promise<number> {
  if (args.length !== 0) return console.error("usage: wx-bot run"), 2;
  const cfg = await loadConfig(configPath).catch((e: Error) => e);
  if (cfg instanceof Error) return console.error(`wx-bot: ${cfg.message}`), 1;
  let box: Inbox & { close(): void };
  try {
    mkdir0700(cfg.media_dir);
    mkdir0700(cfg.state_dir);
    box = openInbox(inboxPath(cfg));
  } catch (err) {
    return console.error(`wx-bot: ${(err as Error).message}`), 1;
  }

  const ctl = new AbortController();
  const stop = () => ctl.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const live = new Map<string, LiveBinding>();
  const tasks: Promise<unknown>[] = [];

  for (const b of cfg.bindings) {
    // Deliver queued events even while the binding is logged out or expired.
    if (b.delivery === DELIVERY_WEBHOOK) {
      if (!b.webhook.url) log("warn", "webhook.url empty; events stay in the inbox until it is set", { binding: b.name });
      else tasks.push(webhookWorker(box, b.name, cfg, ctl.signal));
    }
    let store: Store;
    try {
      store = new Store(cfg.state_dir, b.name);
    } catch (err) {
      log("error", "open binding state", { binding: b.name, err: (err as Error).message });
      continue;
    }
    if (store.isExpired()) {
      log("error", `binding ${b.name} session expired: run \`wx-bot login ${b.name}\``);
      continue;
    }
    if (!store.hasSession()) {
      log("info", "binding not logged in, skip", { binding: b.name });
      continue;
    }
    let lb: LiveBinding;
    try {
      lb = openLive(cfg, b.name);
    } catch (err) {
      log("error", "open live binding", { binding: b.name, err: (err as Error).message });
      continue;
    }
    live.set(b.name, lb);
    const plog = logger({ component: "poller", binding: b.name });
    const health = new HealthWriter(healthPath(cfg.state_dir, b.name));
    if (health.proxy) plog("info", "using proxy", { proxy: health.proxy });
    const poller = new Poller({
      binding: b.name,
      client: lb.client,
      store: lb.store,
      inbox: box,
      media: fileMediaSink(cfg.media_dir),
      allow: lb.allow,
      forwardUnallowed: b.forward_unallowed,
      log: (level, msg) => plog(level, msg),
      onHealth: (h) => health.update(h),
    });
    plog("info", "poller start");
    tasks.push(
      poller.run(ctl.signal).then((exit) => {
        health.close();
        plog("info", "poller stop", { reason: exit });
      }),
    );
  }

  tasks.push(pruneLoop(box, ctl.signal));

  const send = async (req: SendRequest) => {
    const lb = live.get(req.binding) ?? openLive(cfg, req.binding);
    await sendMessage(lb.client, lb.allow, req);
  };
  const [host, port] = splitListen(cfg.local_api.listen);
  const handler = createApiHandler({
    token: cfg.local_api.token,
    send,
    status: () => statusAll(cfg, box),
    inbox: box,
    pullBindings: cfg.bindings.filter((b) => b.delivery === "pull").map((b) => b.name),
    readLocalFile: async (p) => readMedia(p),
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: host, port, fetch: handler, idleTimeout: 0 });
  } catch (err) {
    log("error", "local api", { err: (err as Error).message });
    ctl.abort();
    await Promise.allSettled(tasks);
    box.close();
    return 1;
  }
  log("info", "local api listening", { component: "localapi", addr: `${host}:${server.port}` });
  log("info", "wx-bot running", { bindings: live.size });

  await new Promise<void>((r) => ctl.signal.addEventListener("abort", () => r(), { once: true }));
  log("info", "shutting down");
  await server.stop();
  await Promise.allSettled(tasks);
  box.close();
  return 0;
}

function splitListen(addr: string): [string, number] {
  const m = /^(?:\[([^\]]*)\]|([^:]*)):(\d+)$/.exec(addr)!;
  return [m[1] ?? m[2]!, Number(m[3])];
}

async function webhookWorker(box: Inbox, binding: string, cfg: Config, signal: AbortSignal) {
  const b = cfg.bindings.find((x) => x.name === binding)!;
  const wlog = logger({ component: "webhook", binding });
  const webhook = { url: b.webhook.url, key: b.webhook.key, keyHeader: b.webhook.key_header, keyPrefix: b.webhook.key_prefix, secret: b.webhook.secret };
  while (!signal.aborted) {
    let out;
    try {
      out = await deliverNext(box, binding, webhook, { log: (m) => wlog("warn", m) });
    } catch (err) {
      wlog("error", "claim", { err: (err as Error).message });
      out = "idle";
    }
    if (out === "idle") await sleep(DELIVER_IDLE_MS, signal, (fn) => box.onAdd(fn));
  }
}

async function pruneLoop(box: Inbox, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const { expired, deleted } = box.prune(INBOX_RETENTION_MS);
      if (expired > 0) log("warn", "inbox events expired before delivery", { count: expired });
      if (deleted > 0) log("info", "pruned inbox", { deleted });
    } catch (err) {
      log("error", "prune inbox", { err: (err as Error).message });
    }
    await sleep(3_600_000, signal);
  }
}
