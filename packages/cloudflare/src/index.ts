// wx-bot on Cloudflare Workers.
//
// One Durable Object per WeChat binding. Its alarm long-polls iLink for up to
// ~14 minutes, then re-arms itself; messages are queued in the object's own
// SQLite (same inbox as the CLI) and delivered by webhook or pulled by the
// agent. Media goes to an optional R2 bucket.
//
// HTTP (all routes need Authorization: Bearer <API_TOKEN>):
//   POST /b/<binding>/login            start QR login -> {qrcode_url}
//   GET  /b/<binding>/login            login progress
//   PUT  /b/<binding>/session          import an existing session (migration)
//   DELETE /b/<binding>/session        log out: stop polling, forget credentials
//   GET|PUT /b/<binding>/config        delivery, webhook
//   GET  /b/<binding>/media/<key>      download stored media
//   /b/<binding>/v1/...                the standard API (send, status, events, ack)
//
// Agents in the same Worker can skip HTTP and call the object over RPC:
//   env.WXBOT.get(env.WXBOT.idFromName("muse")).send({...}) / .pull() / .ack([...])

import { DurableObject } from "cloudflare:workers";
import {
  allowlist,
  createApiHandler,
  deliverNext,
  IlinkClient,
  Inbox,
  json,
  LoginApi,
  Poller,
  PULL_LIMITS,
  QR_MAX_EXPIRY,
  safeEqual,
  sendMessage,
  WxBotError,
  type InboxCounts,
  type MediaSink,
  type QueuedEvent,
  type SendRequest,
  type Session,
  type Sql,
  type SqlValue,
  type WebhookConfig,
} from "@wx-bot/core";

export interface Env {
  WXBOT: DurableObjectNamespace<WxBinding>;
  /** Shared secret for every HTTP route. */
  API_TOKEN: string;
  /** Optional bucket for downloaded media. */
  MEDIA?: R2Bucket;
}

export interface BindingConfig {
  delivery: "webhook" | "pull";
  webhook?: WebhookConfig;
}

interface LoginState {
  status: "waiting" | "confirmed" | "expired" | "failed";
  qrcode?: string;
  qrcode_url?: string;
  host?: string;
  attempt?: number;
  error?: string;
  updated_at: number;
}

/** How long one alarm runs before re-arming (alarm wall-clock limit is 15 min). */
const ALARM_SLICE_MS = 14 * 60_000;
/** Waiting QR whose poll timestamp has not moved: the alarm slice is not actually checking it. */
const LOGIN_STALE_MS = 5_000;
const RETENTION_MS = 7 * 86_400_000;
const BINDING_RE = /^[a-z0-9_-]{1,32}$/;

const K = {
  binding: "binding",
  session: "session",
  tokens: "context_tokens",
  cursor: "cursor",
  expired: "expired",
  config: "config",
  login: "login",
} as const;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function doSql(storage: DurableObjectStorage): Sql {
  const bind = (p: SqlValue[]) => p.map((v) => (v instanceof Uint8Array ? v.slice().buffer : v));
  return {
    all: (q, ...p) => storage.sql.exec(q, ...bind(p)).toArray() as never,
    run: (q, ...p) => {
      storage.sql.exec(q, ...bind(p)).toArray();
      // rowsWritten also counts index writes; changes() is the affected-row count.
      const [row] = storage.sql.exec<{ n: number }>("SELECT changes() AS n").toArray();
      return { changes: row?.n ?? 0 };
    },
    transaction: (fn) => storage.transactionSync(fn),
  };
}

export class WxBinding extends DurableObject<Env> {
  private readonly inbox: Inbox;
  private client?: IlinkClient;
  private pollAbort?: AbortController;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.inbox = new Inbox(doSql(ctx.storage));
  }

  // ---------- state ----------

  private async binding(): Promise<string> {
    const b = await this.ctx.storage.get<string>(K.binding);
    if (!b) throw new WxBotError("not_found", "binding not initialised");
    return b;
  }

  private async config(): Promise<BindingConfig> {
    const raw = (await this.ctx.storage.get<BindingConfig & { allow_wxids?: unknown; forward_unallowed?: unknown }>(K.config)) ?? {
      delivery: "pull" as const,
    };
    const { allow_wxids: _a, forward_unallowed: _f, ...cfg } = raw;
    return cfg;
  }

  private async session(): Promise<Session | undefined> {
    return this.ctx.storage.get<Session>(K.session);
  }

  private async liveClient(): Promise<IlinkClient> {
    if (this.client) return this.client;
    const s = await this.session();
    if (!s) throw new WxBotError("expired", "not logged in: POST /login first");
    if (await this.ctx.storage.get(K.expired)) throw new WxBotError("expired", "session expired: POST /login to scan again");
    const c = new IlinkClient(s);
    c.loadTokens((await this.ctx.storage.get<Record<string, string>>(K.tokens)) ?? {});
    this.client = c;
    return c;
  }

  private async allow(): Promise<Set<string>> {
    return allowlist((await this.session())?.ilink_user_id ?? "");
  }

  private async useSession(s: Session, tokens: Record<string, string> = {}, cursor?: string) {
    await this.ctx.storage.put({ [K.session]: s, [K.tokens]: tokens });
    await this.ctx.storage.delete(K.expired);
    if (cursor !== undefined) await this.ctx.storage.put(K.cursor, cursor);
    this.client = undefined;
    await this.wake();
  }

  /**
   * End the in-flight alarm slice and schedule the next one immediately.
   * setAlarm does not preempt a running alarm(); without the abort, login and
   * config changes wait out the current slice (up to ALARM_SLICE_MS).
   */
  private async wake(): Promise<void> {
    this.pollAbort?.abort();
    await this.ctx.storage.setAlarm(Date.now());
  }

  // ---------- RPC ----------

  async send(req: Omit<SendRequest, "binding">): Promise<void> {
    const binding = await this.binding();
    await sendMessage(await this.liveClient(), await this.allow(), { ...req, binding });
  }

  async pull(opts: { limit?: number; leaseMs?: number } = {}): Promise<unknown[]> {
    const b = await this.binding();
    if ((await this.config()).delivery !== "pull") throw new WxBotError("not_found", `binding "${b}" does not use pull delivery`);
    const events = this.inbox.claim(
      [b],
      Math.min(opts.limit ?? PULL_LIMITS.defaultLimit, PULL_LIMITS.maxLimit),
      Math.min(opts.leaseMs ?? PULL_LIMITS.defaultLeaseMs, PULL_LIMITS.maxLeaseMs),
    );
    return events.map((e: QueuedEvent) => JSON.parse(new TextDecoder().decode(e.payload)));
  }

  async ack(eventIds: string[]): Promise<number> {
    return this.inbox.ack([await this.binding()], eventIds);
  }

  async status() {
    const b = await this.ctx.storage.get<string>(K.binding);
    const s = await this.session();
    const cfg = await this.config();
    const counts: InboxCounts | undefined = b ? this.inbox.stats(b) : undefined;
    return {
      name: b ?? "",
      logged_in: !!s,
      expired: !!(await this.ctx.storage.get(K.expired)),
      bot_id: s ? `${s.ilink_bot_id.slice(0, 4)}…` : "",
      cursor_set: !!(await this.ctx.storage.get(K.cursor)),
      allowlist: [...(await this.allow())].sort(),
      delivery: cfg.delivery,
      webhook_host: cfg.webhook?.url ? new URL(cfg.webhook.url).host : "",
      inbox: counts,
      login: (await this.ctx.storage.get<LoginState>(K.login))?.status,
    };
  }

  // ---------- HTTP ----------

  override async fetch(req: Request): Promise<Response> {
    const name = req.headers.get("X-WxBot-Binding") ?? "";
    if (!BINDING_RE.test(name)) return json(400, { error: "invalid binding name" });
    if ((await this.ctx.storage.get<string>(K.binding)) !== name) await this.ctx.storage.put(K.binding, name);

    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/login" && req.method === "POST") return json(200, await this.startLogin());
      if (path === "/login" && req.method === "GET") return json(200, await this.loginView());
      if (path === "/session" && req.method === "PUT") {
        const b = (await req.json()) as { session?: Session; context_tokens?: Record<string, string>; cursor?: string };
        if (!b.session?.bot_token || !b.session.base_url) throw new WxBotError("bad_request", "session.bot_token and session.base_url are required");
        await this.useSession(b.session, b.context_tokens, b.cursor);
        return json(200, { ok: true });
      }
      if (path === "/session" && req.method === "DELETE") {
        // Log out: stop polling and forget credentials; the inbox is kept.
        await this.ctx.storage.delete([K.session, K.tokens, K.cursor, K.expired, K.login]);
        this.client = undefined;
        this.pollAbort?.abort();
        return json(200, { ok: true });
      }
      if (path === "/config" && req.method === "GET") {
        const c = await this.config();
        return json(200, { ...c, webhook: c.webhook && { ...c.webhook, key: c.webhook.key ? "***" : "", secret: c.webhook.secret ? "***" : "" } });
      }
      if (path === "/config" && req.method === "PUT") {
        const incoming = (await req.json()) as BindingConfig & { allow_wxids?: unknown; forward_unallowed?: unknown };
        const { allow_wxids: _a, forward_unallowed: _f, ...c } = incoming;
        if (c.delivery !== "webhook" && c.delivery !== "pull") throw new WxBotError("bad_request", 'delivery must be "webhook" or "pull"');
        if (c.delivery === "webhook" && !c.webhook?.url) throw new WxBotError("bad_request", "webhook.url is required for webhook delivery");
        await this.ctx.storage.put(K.config, c);
        await this.wake();
        return json(200, { ok: true });
      }
      if (path.startsWith("/media/") && req.method === "GET") {
        if (!this.env.MEDIA) throw new WxBotError("not_found", "no MEDIA bucket bound");
        const key = decodeURIComponent(path.slice("/media/".length));
        if (!key.startsWith(`${name}/`)) throw new WxBotError("not_found", "unknown media");
        const obj = await this.env.MEDIA.get(key);
        if (!obj) throw new WxBotError("not_found", "unknown media");
        return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream" } });
      }
      if (path.startsWith("/v1/") || path === "/healthz") {
        const cfg = await this.config();
        return createApiHandler({
          send: (r) => this.send({ to: r.to, text: r.text, media: r.media, caption: r.caption }),
          status: async () => [await this.status()],
          inbox: this.inbox,
          pullBindings: cfg.delivery === "pull" ? [name] : [],
        })(req);
      }
      return json(404, { error: "not found" });
    } catch (err) {
      const status = err instanceof WxBotError ? ({ bad_request: 400, not_found: 404, expired: 401 } as Record<string, number>)[err.kind] ?? 500 : 500;
      return json(status, { error: (err as Error).message });
    }
  }

  // ---------- login ----------

  private async startLogin() {
    const qr = await new LoginApi().getQrCode();
    const st: LoginState = { status: "waiting", qrcode: qr.qrcode, qrcode_url: qr.imageContent, attempt: 1, updated_at: Date.now() };
    await this.ctx.storage.put(K.login, st);
    await this.wake();
    return { status: st.status, qrcode_url: st.qrcode_url, attempt: st.attempt };
  }

  private async loginView(): Promise<LoginState | { status: "idle" }> {
    const st = await this.ctx.storage.get<LoginState>(K.login);
    // Recovery when the slice missed startLogin's wake (or never armed): a poll
    // that is actually running refreshes updated_at about once a second.
    if (st?.status === "waiting" && Date.now() - st.updated_at >= LOGIN_STALE_MS) await this.wake();
    return st ?? { status: "idle" };
  }

  /** Poll the QR status until confirmed, expired (after refreshes), aborted, or deadline. */
  private async loginStep(deadline: number, signal: AbortSignal): Promise<void> {
    const api = new LoginApi();
    while (!signal.aborted && Date.now() <= deadline) {
      const st = await this.ctx.storage.get<LoginState>(K.login);
      if (signal.aborted) return;
      if (!st || st.status !== "waiting" || !st.qrcode) return;
      let next: LoginState;
      try {
        const r = await api.checkQrStatus(st.qrcode, st.host, signal);
        if (r.state === "confirmed") {
          await this.useSession(r.session);
          next = { status: "confirmed", updated_at: Date.now() };
        } else if (signal.aborted) {
          return;
        } else if (r.state === "expired") {
          if ((st.attempt ?? 1) >= QR_MAX_EXPIRY) next = { status: "expired", updated_at: Date.now() };
          else {
            const qr = await api.getQrCode(signal);
            if (signal.aborted) return;
            next = { status: "waiting", qrcode: qr.qrcode, qrcode_url: qr.imageContent, attempt: (st.attempt ?? 1) + 1, updated_at: Date.now() };
          }
        } else {
          next = { ...st, host: r.host, updated_at: Date.now() };
        }
      } catch (err) {
        // Waking the slice aborts the in-flight status check. That is not a failed login.
        if (signal.aborted) return;
        next = { status: "failed", error: (err as Error).message, updated_at: Date.now() };
      }
      await this.ctx.storage.put(K.login, next);
      if (next.status !== "waiting") return;
      await sleep(1000, signal);
    }
  }

  // ---------- alarm: login, polling, delivery ----------

  override async alarm(): Promise<void> {
    const deadline = Date.now() + ALARM_SLICE_MS;
    const name = await this.ctx.storage.get<string>(K.binding);
    if (!name) return;

    this.inbox.prune(RETENTION_MS);

    // Login, polling and delivery run side by side: a pending QR login must
    // not pause message flow for the current session. The same signal ends
    // the slice early when login or config is updated.
    const ctl = new AbortController();
    this.pollAbort = ctl;
    const stopAt = setTimeout(() => ctl.abort(), Math.max(0, deadline - Date.now()));
    try {
      const tasks: Promise<unknown>[] = [this.loginStep(deadline, ctl.signal)];

      let client: IlinkClient | undefined;
      try {
        client = await this.liveClient();
      } catch {
        client = undefined;
      }
      if (client) {
        const storage = this.ctx.storage;
        const poller = new Poller({
          binding: name,
          client,
          inbox: this.inbox,
          allow: await this.allow(),
          media: this.mediaSink(),
          log: (level, msg) => console[level === "info" ? "log" : level](`[${name}] ${msg}`),
          store: {
            loadCursor: async () => (await storage.get<string>(K.cursor)) ?? "",
            saveCursor: (c) => storage.put(K.cursor, c),
            saveTokens: (t) => storage.put(K.tokens, t),
            markExpired: async () => {
              await storage.put(K.expired, new Date().toISOString());
              this.client = undefined;
            },
          },
        });
        tasks.push(poller.run(ctl.signal, deadline).finally(() => ctl.abort()));
      }
      const cfg = await this.config();
      if (cfg.delivery === "webhook" && cfg.webhook?.url) tasks.push(this.deliverLoop(name, cfg.webhook, ctl.signal));

      await Promise.allSettled(tasks);
      await this.armNext(name);
    } finally {
      clearTimeout(stopAt);
    }
  }

  /**
   * Keep going while there is work: a live session, pending login, or
   * undelivered webhooks. A wake() during this handler already called
   * setAlarm(now); getAlarm() is null until that happens, and a later
   * +1s backoff must not postpone the earlier alarm.
   */
  private async armNext(name: string): Promise<void> {
    const cfg = await this.config();
    const login = await this.ctx.storage.get<LoginState>(K.login);
    const pending = cfg.delivery === "webhook" && this.inbox.stats(name).pending > 0;
    let next: number | null = null;
    if ((await this.session()) && !(await this.ctx.storage.get(K.expired))) next = Date.now();
    else if (login?.status === "waiting" || pending) next = Date.now() + 1_000;
    if (next === null) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || next < existing) await this.ctx.storage.setAlarm(next);
  }

  private async deliverLoop(name: string, webhook: WebhookConfig, signal: AbortSignal) {
    while (!signal.aborted) {
      const out = await deliverNext(this.inbox, name, webhook, { log: (m) => console.warn(`[${name}] ${m}`) });
      if (out !== "idle") continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, 1000);
        const off = this.inbox.onAdd(done);
        signal.addEventListener("abort", done, { once: true });
        function done() {
          clearTimeout(t);
          off();
          resolve();
        }
      });
    }
  }

  private mediaSink(): MediaSink {
    return async (m) => {
      if (!this.env.MEDIA) throw new Error("no MEDIA bucket bound");
      const day = m.createdAt.toISOString().slice(0, 10).replaceAll("-", "");
      const key = `${m.binding}/${day}/${m.messageId}_${m.fileName}`;
      await this.env.MEDIA.put(key, m.data);
      return { path: key };
    };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    if (!env.API_TOKEN) return json(500, { error: "API_TOKEN is not configured" });
    if (!safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${env.API_TOKEN}`)) return json(401, { error: "unauthorized" });
    const m = /^\/b\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m || !BINDING_RE.test(m[1]!)) return json(404, { error: "use /b/<binding>/..." });
    const inner = new URL(m[2] || "/", url);
    inner.search = url.search;
    const fwd = new Request(inner, req);
    fwd.headers.set("X-WxBot-Binding", m[1]!);
    return env.WXBOT.get(env.WXBOT.idFromName(m[1]!)).fetch(fwd);
  },
} satisfies ExportedHandler<Env>;
