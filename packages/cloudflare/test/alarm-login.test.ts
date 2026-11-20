import { Database } from "bun:sqlite";
import { afterEach, expect, mock, test } from "bun:test";

// The Worker entry imports cloudflare:workers, which bun cannot load. The test
// only needs the Durable Object base class to store ctx/env.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { WxBinding } = await import("../src/index.ts");

const originalFetch = globalThis.fetch;
const pending: Promise<unknown>[] = [];
const cleanups: Array<() => Promise<void>> = [];
const databases: Database[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.allSettled(pending.splice(0));
  globalThis.fetch = originalFetch;
  for (const db of databases.splice(0)) db.close();
});

/** In-memory stand-in for Durable Object storage, including alarm-handler getAlarm rules. */
class MemoryStorage {
  readonly kv = new Map<string, unknown>();
  readonly db = new Database(":memory:");
  /** Alarm time visible outside a running handler. */
  alarm: number | null = null;
  private running = false;
  private setDuring = false;

  beginAlarm() {
    // A firing alarm is consumed; getAlarm() stays null until setAlarm() in this handler.
    this.running = true;
    this.setDuring = false;
    this.alarm = null;
  }

  endAlarm() {
    this.running = false;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.kv.get(key) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === "string") this.kv.set(keyOrEntries, value);
    else for (const [key, entry] of Object.entries(keyOrEntries)) this.kv.set(key, entry);
  }

  async delete(keyOrKeys: string | string[]): Promise<number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let n = 0;
    for (const key of keys) if (this.kv.delete(key)) n++;
    return n;
  }

  async setAlarm(ts: number): Promise<void> {
    this.alarm = ts;
    if (this.running) this.setDuring = true;
  }

  async getAlarm(): Promise<number | null> {
    if (this.running && !this.setDuring) return null;
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  readonly sql = {
    exec: (query: string, ...params: unknown[]) => {
      const stmt = this.db.query(query);
      if (/^\s*(select|with)\b/i.test(query)) {
        const rows = stmt.all(...(params as never[]));
        return { toArray: () => rows };
      }
      stmt.run(...(params as never[]));
      return { toArray: () => [] };
    },
  };

  transactionSync<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://do.internal${path}`, {
    method,
    headers: {
      "X-WxBot-Binding": "muse",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function hang(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

interface Harness {
  binding: InstanceType<typeof WxBinding>;
  storage: MemoryStorage;
  statusUrls: string[];
  webhookUrls: string[];
  /** When true, get_qrcode_status stays open until its abort signal fires. */
  hangStatus: boolean;
  runAlarm: () => { promise: Promise<void>; settled: () => boolean };
}

function harness(): Harness {
  const storage = new MemoryStorage();
  databases.push(storage.db);
  const binding = new WxBinding({ storage } as never, { API_TOKEN: "t", WXBOT: undefined } as never);
  const h: Harness = {
    binding,
    storage,
    statusUrls: [],
    webhookUrls: [],
    hangStatus: false,
    runAlarm: () => {
      let done = false;
      const promise = (async () => {
        storage.beginAlarm();
        try {
          await binding.alarm();
        } finally {
          storage.endAlarm();
          done = true;
        }
      })();
      pending.push(promise);
      return { promise, settled: () => done };
    },
  };
  let qrN = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.includes("get_bot_qrcode")) {
      qrN++;
      return Response.json({ qrcode: `qr-${qrN}`, qrcode_img_content: `https://qr.example/${qrN}` });
    }
    if (url.includes("get_qrcode_status")) {
      h.statusUrls.push(url);
      if (h.hangStatus) return hang(init?.signal);
      if (url.includes("qr-confirm")) {
        return Response.json({
          status: "confirmed",
          bot_token: "bot-secret",
          baseurl: "https://ilink.test",
          ilink_bot_id: "bot@im.bot",
          ilink_user_id: "wxid_owner",
        });
      }
      return Response.json({ status: "wait" });
    }
    if (url.includes("/ilink/bot/getupdates")) return hang(init?.signal);
    if (url.startsWith("https://hook.example/") || url.startsWith("https://agent.example/")) {
      h.webhookUrls.push(url);
      return new Response("ok", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  cleanups.push(async () => {
    await binding.fetch(req("DELETE", "/session")).catch(() => undefined);
  });
  return h;
}

async function settleSoon(promise: Promise<unknown>, ms = 1_500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`alarm did not finish within ${ms}ms`)), ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(cond: () => boolean, ms = 2_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const webhook = (url: string) => ({ delivery: "webhook" as const, webhook: { url, key: "k" } });

test("an idle pull binding does not hold the alarm open", async () => {
  const { binding, storage, runAlarm } = harness();
  expect((await binding.fetch(req("PUT", "/config", { delivery: "pull" }))).status).toBe(200);
  const slice = runAlarm();
  await settleSoon(slice.promise, 500);
  expect(slice.settled()).toBe(true);
  expect(storage.alarm).toBeNull();
});

test("a webhook slice keeps running until login or config wakes it", async () => {
  const { binding, runAlarm } = harness();
  expect((await binding.fetch(req("PUT", "/config", webhook("https://hook.example/a")))).status).toBe(200);
  const slice = runAlarm();
  await Bun.sleep(150);
  expect(slice.settled()).toBe(false);
});

test("POST /login after PUT /config polls the QR without waiting out the alarm slice", async () => {
  const { binding, storage, statusUrls, runAlarm } = harness();
  expect((await binding.fetch(req("PUT", "/config", webhook("https://hook.example/a")))).status).toBe(200);

  const slice = runAlarm();
  await Bun.sleep(50);
  expect(slice.settled()).toBe(false);
  expect(statusUrls).toHaveLength(0);

  const started = Date.now();
  const login = await binding.fetch(req("POST", "/login"));
  expect(login.status).toBe(200);
  const body = (await login.json()) as { status: string; qrcode_url: string };
  expect(body.status).toBe("waiting");
  expect(body.qrcode_url).toBe("https://qr.example/1");

  await settleSoon(slice.promise);
  expect(Date.now() - started).toBeLessThan(1_500);
  // The handler's +1s login backoff must not overwrite the immediate wake.
  expect(storage.alarm).not.toBeNull();
  expect(storage.alarm! - Date.now()).toBeLessThan(500);

  const next = runAlarm();
  await until(() => statusUrls.some((url) => url.includes("qr-1")), 2_000, "qr status poll");
  const view = (await (await binding.fetch(req("GET", "/login"))).json()) as { status: string; updated_at: number };
  expect(view.status).toBe("waiting");
  expect(view.updated_at).toBeGreaterThanOrEqual(started);
  await Bun.sleep(40);
  expect(next.settled()).toBe(false);
});

test("GET /login wakes a waiting QR that the current slice is not polling", async () => {
  const { binding, storage, statusUrls, runAlarm } = harness();
  await binding.fetch(req("PUT", "/config", webhook("https://hook.example/a")));
  const slice = runAlarm();
  await Bun.sleep(30);
  expect(slice.settled()).toBe(false);

  const updatedAt = Date.now() - 10_000;
  await storage.put("login", { status: "waiting", qrcode: "qr-stale", qrcode_url: "https://qr.example/stale", updated_at: updatedAt });
  const view = (await (await binding.fetch(req("GET", "/login"))).json()) as { status: string; updated_at: number };
  expect(view.status).toBe("waiting");
  expect(view.updated_at).toBe(updatedAt);

  await settleSoon(slice.promise);
  const next = runAlarm();
  await until(() => statusUrls.some((url) => url.includes("qr-stale")), 2_000, "stale qr poll");
  const moved = (await (await binding.fetch(req("GET", "/login"))).json()) as { updated_at: number; status: string };
  expect(moved.status).toBe("waiting");
  expect(moved.updated_at).toBeGreaterThan(updatedAt);
  expect(next.settled()).toBe(false);
});

test("a fresh waiting QR is not restarted by GET /login", async () => {
  const { binding, statusUrls, runAlarm } = harness();
  await binding.fetch(req("PUT", "/config", webhook("https://hook.example/a")));
  expect((await binding.fetch(req("POST", "/login"))).status).toBe(200);
  const slice = runAlarm();
  await until(() => statusUrls.length > 0, 2_000, "first status poll");
  const before = statusUrls.length;
  const view = (await (await binding.fetch(req("GET", "/login"))).json()) as { status: string };
  expect(view.status).toBe("waiting");
  await Bun.sleep(100);
  expect(slice.settled()).toBe(false);
  expect(statusUrls.length).toBe(before);
});

test("PUT /config aborts the in-flight slice and the next slice delivers to the new webhook", async () => {
  const { binding, storage, webhookUrls, runAlarm } = harness();
  await binding.fetch(req("PUT", "/config", webhook("https://hook.example/old")));
  const slice = runAlarm();
  await Bun.sleep(30);
  expect(slice.settled()).toBe(false);

  const put = await binding.fetch(req("PUT", "/config", webhook("https://hook.example/new")));
  expect(put.status).toBe(200);
  await settleSoon(slice.promise);
  expect(webhookUrls).toHaveLength(0);

  storage.db
    .query(`INSERT INTO events (event_id, binding, payload, created_at) VALUES (?, ?, ?, ?)`)
    .run("e1", "muse", new TextEncoder().encode('{"event_id":"e1"}'), Date.now());
  const next = runAlarm();
  await until(() => webhookUrls.length > 0, 2_000, "webhook delivery");
  expect(webhookUrls[0]).toBe("https://hook.example/new");
  expect(next.settled()).toBe(false);
});

test("POST /login during a hung QR check restarts the slice without failing the attempt", async () => {
  const box = harness();
  box.hangStatus = true;
  await box.binding.fetch(req("PUT", "/config", webhook("https://hook.example/a")));
  expect((await box.binding.fetch(req("POST", "/login"))).status).toBe(200);
  const slice = box.runAlarm();
  await until(() => box.statusUrls.length > 0, 2_000, "hung status check");
  expect(slice.settled()).toBe(false);

  box.hangStatus = false;
  const again = await box.binding.fetch(req("POST", "/login"));
  expect(again.status).toBe(200);
  const body = (await again.json()) as { status: string; qrcode_url: string };
  expect(body.qrcode_url).toBe("https://qr.example/2");
  await settleSoon(slice.promise);

  const view = (await (await box.binding.fetch(req("GET", "/login"))).json()) as { status: string; qrcode?: string; error?: string };
  expect(view.status).toBe("waiting");
  expect(view.qrcode).toBe("qr-2");
  expect(view.error).toBeUndefined();

  const next = box.runAlarm();
  await until(() => box.statusUrls.some((url) => url.includes("qr-2")), 2_000, "new qr poll");
  expect(next.settled()).toBe(false);
});

test("POST /login wakes a logged-in poller slice and the next slice checks the QR", async () => {
  const { binding, statusUrls, runAlarm } = harness();
  const session = await binding.fetch(
    req("PUT", "/session", {
      session: { bot_token: "bot-secret", base_url: "https://ilink.test", ilink_bot_id: "bot@im.bot", ilink_user_id: "wxid_owner" },
    }),
  );
  expect(session.status).toBe(200);
  await binding.fetch(req("PUT", "/config", { delivery: "pull" }));

  const slice = runAlarm();
  await Bun.sleep(50);
  expect(slice.settled()).toBe(false);

  const login = await binding.fetch(req("POST", "/login"));
  expect(login.status).toBe(200);
  await settleSoon(slice.promise);

  const next = runAlarm();
  await until(() => statusUrls.some((url) => url.includes("qr-1")), 2_000, "qr poll beside session");
  const state = (await (await binding.fetch(req("GET", "/v1/status"))).json()) as { bindings: Array<{ logged_in: boolean }> };
  expect(state.bindings[0]?.logged_in).toBe(true);
  expect(next.settled()).toBe(false);
});

test("a confirmed scan still saves the session and releases the slice", async () => {
  const { binding, storage, runAlarm } = harness();
  await binding.fetch(req("PUT", "/config", { delivery: "pull" }));
  await storage.put("login", {
    status: "waiting",
    qrcode: "qr-confirm",
    qrcode_url: "https://qr.example/confirm",
    attempt: 1,
    updated_at: Date.now(),
  });
  const slice = runAlarm();
  await settleSoon(slice.promise);
  const view = (await (await binding.fetch(req("GET", "/login"))).json()) as { status: string };
  expect(view.status).toBe("confirmed");
  const session = await storage.get<{ bot_token: string }>("session");
  expect(session?.bot_token).toBe("bot-secret");
  expect(storage.alarm).not.toBeNull();
  expect(storage.alarm! - Date.now()).toBeLessThan(500);
});
