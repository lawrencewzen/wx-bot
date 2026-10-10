import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Inbox } from "../src/inbox.ts";
import { deliverNext, retryBackoffMs } from "../src/webhook.ts";
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
