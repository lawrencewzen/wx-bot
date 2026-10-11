import {
  AGENT_RECOVERED_TEXT,
  AGENT_STALL_MS,
  agentStalledText,
  buildAlertEvent,
  createApiHandler,
  deliverNext,
  encodeEvent,
  PollAlerts,
  Poller,
  sendMessage,
  type AlertInfo,
  type Inbox,
  type SendRequest,
} from "@wx-bot/core";
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
const STALL_CHECK_MS = 30_000;

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
    const alerts = new PollAlerts();
    const queueAlert = (info: AlertInfo) => {
      try {
        const ev = buildAlertEvent(b.name, lb.client.botId, info, Date.now());
        if (box.add(b.name, ev.event_id, encodeEvent(ev))) plog("warn", "alert queued for the agent", { code: info.code });
      } catch (err) {
        plog("error", "queue alert", { err: (err as Error).message });
      }
    };
    const poller = new Poller({
      binding: b.name,
      client: lb.client,
      store: lb.store,
      inbox: box,
      media: fileMediaSink(cfg.media_dir),
      allow: lb.allow,
      forwardUnallowed: b.forward_unallowed,
      log: (level, msg) => plog(level, msg),
      onHealth: (h) => {
        health.update(h);
        const a = alerts.update(h);
        if (a?.kind === "failing") {
          queueAlert({
            code: "ilink_unreachable",
            message: `wx-bot 连不上微信已超过 2 分钟，暂时收不到微信消息：${a.error}`,
            hint: health.proxy
              ? `wx-bot 使用代理 ${health.proxy}：检查 ~/.config/wx-bot/env 里的代理地址和密码是否仍有效，改完重启 wx-bot 服务。`
              : "如果这台机器要通过代理上网，把 https_proxy 等代理变量写进 ~/.config/wx-bot/env 后重启 wx-bot 服务；否则检查网络。",
            since: a.since,
          });
        } else if (a?.kind === "recovered") {
          queueAlert({ code: "recovered", message: "wx-bot 已恢复连接微信，断线期间的消息会陆续补收。", hint: "", since: a.since });
        }
      },
    });
    plog("info", "poller start");
    tasks.push(
      poller.run(ctl.signal).then((exit) => {
        health.close();
        plog("info", "poller stop", { reason: exit });
        if (exit === "expired") {
          queueAlert({
            code: "session_expired",
            message: "微信登录已过期，wx-bot 收不到也发不出微信消息。",
            hint: `在 wx-bot 所在机器运行 wx-bot login ${b.name} 重新扫码，然后重启 wx-bot 服务。`,
            since: Math.floor(Date.now() / 1000),
          });
        }
      }),
    );
    tasks.push(stallWatch(box, lb, ctl.signal));
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

/**
 * Tell the WeChat owner when queued messages sit untaken for AGENT_STALL_MS
 * (agent down, webhook failing), and again when they move.
 */
async function stallWatch(box: Inbox, lb: LiveBinding, signal: AbortSignal) {
  const slog = logger({ component: "stallwatch", binding: lb.name });
  const owner = lb.session.ilink_user_id;
  let notified = false;
  while (!signal.aborted) {
    try {
      const n = box.waiting(lb.name, AGENT_STALL_MS);
      if (n > 0 && !notified && owner) {
        await lb.client.sendText(owner, agentStalledText(lb.name, n, AGENT_STALL_MS / 60_000));
        notified = true;
        slog("warn", "told the owner the agent is not taking messages", { waiting: n });
      } else if (n === 0 && notified) {
        notified = false;
        await lb.client.sendText(owner, AGENT_RECOVERED_TEXT);
        slog("info", "told the owner the agent recovered");
      }
    } catch (err) {
      slog("warn", "owner notice", { err: (err as Error).message });
    }
    await sleep(STALL_CHECK_MS, signal);
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
