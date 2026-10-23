import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Inbox } from "../src/inbox.ts";
import { deliverNext, isPermanent, postWebhook, retryBackoffMs, WebhookStatusError } from "../src/webhook.ts";
import { memorySql, serve } from "./helpers.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((s) => s()));
const enc = (s: string) => new TextEncoder().encode(s);

test("auth header and HMAC over exact body", async () => {
  let seen: { headers: Headers; body: string } | undefined;
  const hook = serve(async (req) => {
    seen = { headers: req.headers, body: await req.text() };
    return new Response(null, { status: 204 });
  });
  stops.push(hook.stop);
  const inbox = new Inbox(memorySql());
  inbox.add("a", "a:1", enc('{"x":1}\n'));
  const out = await deliverNext(inbox, "a", { url: hook.url, key: "hook-key", secret: "hmac-secret" });
  expect(out).toBe("delivered");
  expect(seen!.body).toBe('{"x":1}\n');
  expect(seen!.headers.get("Authorization")).toBe("Bearer hook-key");
  expect(seen!.headers.get("X-WxBot-Signature")).toBe(
    "sha256=" + createHmac("sha256", "hmac-secret").update('{"x":1}\n').digest("hex"),
  );
  expect(seen!.headers.get("X-WxBot-Timestamp")).toMatch(/^\d+$/);
  expect(inbox.stats("a")).toEqual({ pending: 0, dead: 0 });
  expect(await deliverNext(inbox, "a", { url: hook.url })).toBe("idle");
});

test("5xx retries later, 400 gives up without blocking", async () => {
  const bodies: string[] = [];
  let calls = 0;
  const hook = serve(async (req) => {
    const b = await req.text();
    bodies.push(b);
    if (b === "bad\n") return new Response(null, { status: 400 });
    return new Response(null, { status: ++calls === 1 ? 503 : 200 });
  });
  stops.push(hook.stop);
  let now = 1_000_000;
  const inbox = new Inbox(memorySql(), () => now);
  inbox.add("a", "a:1", enc("bad\n"));
  inbox.add("a", "a:2", enc("good\n"));
  const opts = { now: () => now };
  expect(await deliverNext(inbox, "a", { url: hook.url }, opts)).toBe("dead");
  expect(await deliverNext(inbox, "a", { url: hook.url }, opts)).toBe("retry");
  expect(await deliverNext(inbox, "a", { url: hook.url }, opts)).toBe("idle");
  now += 2_000;
  expect(await deliverNext(inbox, "a", { url: hook.url }, opts)).toBe("delivered");
  expect(bodies).toEqual(["bad\n", "good\n", "good\n"]);
  expect(inbox.stats("a")).toEqual({ pending: 0, dead: 1 });
});

test("retry backoff", () => {
  expect([1, 2, 3, 20].map(retryBackoffMs)).toEqual([2000, 4000, 8000, 300000]);
});

const RATE_LIMIT_BODY =
  '{"success":false,"error":"Automation run rate limit exceeded: grok bot limit 20000 per minute, current_count=20002"}';

test("isPermanent: rate-limit body is retryable; plain 400/413/422 are not", () => {
  const limited = new WebhookStatusError(400, RATE_LIMIT_BODY);
  expect(isPermanent(limited)).toBe(false);
  expect(limited.message).toContain("rate limit exceeded");
  expect(limited.body).toContain("rate limit exceeded");
  expect(isPermanent(new WebhookStatusError(400, "bad request"))).toBe(true);
  expect(isPermanent(new WebhookStatusError(400))).toBe(true);
  expect(isPermanent(new WebhookStatusError(413, "too large"))).toBe(true);
  expect(isPermanent(new WebhookStatusError(422, "unprocessable"))).toBe(true);
  expect(isPermanent(new WebhookStatusError(503))).toBe(false);
  expect([1, 2, 3, 4, 5].map((a) => retryBackoffMs(a, limited))).toEqual([60_000, 120_000, 300_000, 600_000, 600_000]);
  expect(retryBackoffMs(1, new WebhookStatusError(503, "rate limit exceeded"))).toBe(2000);
});

test("400 rate-limit retries at 1/2/5/10 min and keeps the body in logs", async () => {
  const hook = serve(() => new Response(RATE_LIMIT_BODY, { status: 400, headers: { "Content-Type": "application/json" } }));
  stops.push(hook.stop);
  let now = 1_000_000;
  const inbox = new Inbox(memorySql(), () => now);
  inbox.add("a", "a:1", enc("msg\n"));
  const logs: string[] = [];
  const opts = { now: () => now, log: (m: string) => logs.push(m) };
  for (const delay of [60_000, 120_000, 300_000, 600_000, 600_000]) {
    expect(await deliverNext(inbox, "a", { url: hook.url }, opts)).toBe("retry");
    expect(inbox.nextReadyAt(["a"])).toBe(now + delay);
    expect(inbox.stats("a")).toEqual({ pending: 1, dead: 0 });
    now += delay;
  }
  expect(logs.join("\n")).toContain("rate limit exceeded");
  expect(logs.join("\n")).toContain("retry in 60s");
});

test("400 without rate limit, 413, 422 still dead", async () => {
  const hook = serve(async (req) => {
    const b = await req.text();
    if (b === "too-big\n") return new Response("payload too large", { status: 413 });
    if (b === "unprocessable\n") return new Response("unprocessable entity", { status: 422 });
    return new Response("bad request", { status: 400 });
  });
  stops.push(hook.stop);
  const logs: string[] = [];
  const inbox = new Inbox(memorySql());
  inbox.add("a", "a:1", enc("bad\n"));
  inbox.add("a", "a:2", enc("too-big\n"));
  inbox.add("a", "a:3", enc("unprocessable\n"));
  const opts = { log: (m: string) => logs.push(m) };
  expect(await deliverNext(inbox, "a", { url: hook.url }, opts)).toBe("dead");
  expect(await deliverNext(inbox, "a", { url: hook.url }, opts)).toBe("dead");
  expect(await deliverNext(inbox, "a", { url: hook.url }, opts)).toBe("dead");
  expect(inbox.stats("a")).toEqual({ pending: 0, dead: 3 });
  const joined = logs.join("\n");
  expect(joined).toContain("bad request");
  expect(joined).toContain("payload too large");
  expect(joined).toContain("unprocessable entity");
});

test("non-2xx body is capped at ~2KB and quoted in the error", async () => {
  const hook = serve(() => new Response("rate limit " + "x".repeat(5000), { status: 400 }));
  stops.push(hook.stop);
  try {
    await postWebhook({ url: hook.url }, enc("{}\n"));
    throw new Error("expected postWebhook to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(WebhookStatusError);
    const e = err as WebhookStatusError;
    expect(e.status).toBe(400);
    expect(e.body.startsWith("rate limit ")).toBe(true);
    expect(e.body.length).toBeLessThanOrEqual(2048);
    expect(e.message).toContain("rate limit");
    expect(e.message.length).toBeLessThan(e.body.length);
  }
});
