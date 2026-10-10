import { expect, test } from "bun:test";
import { createApiHandler } from "../src/api.ts";
import { WxBotError } from "../src/errors.ts";
import { Inbox } from "../src/inbox.ts";
import type { SendRequest } from "../src/send.ts";
import { memorySql } from "./helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function api(opts: Partial<Parameters<typeof createApiHandler>[0]> = {}) {
  const sent: SendRequest[] = [];
  const inbox = new Inbox(memorySql());
  const handle = createApiHandler({
    token: "tok",
    send: async (r) => void sent.push(r),
    status: () => [{ name: "p" }],
    inbox,
    pullBindings: ["p"],
    ...opts,
  });
  const call = (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
    handle(new Request(`http://local${path}`, { method, body, headers: { Authorization: "Bearer tok", ...headers } }));
  return { handle, call, sent, inbox };
}

test("auth, healthz, routing", async () => {
  const a = api();
  expect((await a.handle(new Request("http://local/healthz"))).status).toBe(200);
  expect((await a.handle(new Request("http://local/v1/status"))).status).toBe(401);
  expect(await (await a.call("GET", "/v1/status")).json()).toEqual({ bindings: [{ name: "p" }] });
  expect((await a.call("GET", "/v1/send")).status).toBe(405);
  expect((await a.call("GET", "/nope")).status).toBe(404);
});

test("send json, validation and error mapping", async () => {
  const a = api();
  const ok = await a.call("POST", "/v1/send", JSON.stringify({ binding: "b", to: "w", text: "hi" }));
  expect([ok.status, await ok.json()]).toEqual([200, { ok: true }]);
  expect(a.sent[0]).toMatchObject({ binding: "b", to: "w", text: "hi" });
  const bad = await a.call("POST", "/v1/send", JSON.stringify({ binding: "b", to: "w", text: "a", image: "/x" }));
  expect([bad.status, (await bad.json()).error]).toEqual([400, "text, image, file, video are mutually exclusive"]);
  const nopath = await a.call("POST", "/v1/send", JSON.stringify({ binding: "b", to: "w", image: "/x.png" }));
  expect(nopath.status).toBe(400);

  for (const [kind, status] of [["forbidden", 403], ["no_context", 409], ["expired", 401], ["not_found", 404], ["too_large", 413]] as const) {
    const e = api({ send: async () => { throw new WxBotError(kind, "boom"); } });
    expect((await e.call("POST", "/v1/send", JSON.stringify({ binding: "b", to: "w", text: "x" }))).status).toBe(status);
  }
});

test("send json with a local path uses readLocalFile", async () => {
  const a = api({ readLocalFile: async (p) => ({ data: enc("img"), fileName: p.split("/").pop()! }) });
  await a.call("POST", "/v1/send", JSON.stringify({ binding: "b", to: "w", image: "/tmp/a.png", caption: "c" }));
  expect(a.sent[0]!.media).toMatchObject({ kind: "image", fileName: "a.png" });
  expect(a.sent[0]!.caption).toBe("c");
});

test("send multipart upload", async () => {
  const a = api();
  const form = new FormData();
  form.set("binding", "b");
  form.set("to", "w");
  form.set("caption", "见图");
  form.set("image", new File([enc("png-bytes")], "../../evil photo.png"));
  expect((await a.call("POST", "/v1/send", form)).status).toBe(200);
  const m = a.sent[0]!.media!;
  expect([m.kind, new TextDecoder().decode(m.data), a.sent[0]!.caption]).toEqual(["image", "png-bytes", "见图"]);

  const badPart = new FormData();
  badPart.set("binding", "b");
  badPart.set("to", "w");
  badPart.set("attachment", new File([enc("x")], "a.txt"));
  expect((await a.call("POST", "/v1/send", badPart)).status).toBe(400);

  const textOnly = new FormData();
  textOnly.set("binding", "b");
  textOnly.set("to", "w");
  textOnly.set("text", `it's "fine" $HOME`);
  expect((await a.call("POST", "/v1/send", textOnly)).status).toBe(200);
  expect(a.sent[1]!.text).toBe(`it's "fine" $HOME`);
});

test("events pull, lease, scoped ack, long poll", async () => {
  const a = api();
  a.inbox.add("p", "p:1", enc('{"event_id":"p:1"}\n'));
  a.inbox.add("w", "w:1", enc('{"event_id":"w:1"}\n'));
  expect(await (await a.call("GET", "/v1/events")).json()).toEqual({ events: [{ event_id: "p:1" }] });
  expect(await (await a.call("GET", "/v1/events")).json()).toEqual({ events: [] });
  expect(await (await a.call("POST", "/v1/events/ack", JSON.stringify({ event_ids: ["w:1"] }))).json()).toEqual({ acked: 0 });
  expect(await (await a.call("POST", "/v1/events/ack", JSON.stringify({ event_ids: ["p:1"] }))).json()).toEqual({ acked: 1 });
  expect((await a.call("GET", "/v1/events?binding=w")).status).toBe(404);
  expect((await a.call("GET", "/v1/events?wait=10m")).status).toBe(400);
  expect((await a.call("GET", "/v1/events?limit=0")).status).toBe(400);

  setTimeout(() => a.inbox.add("p", "p:9", enc('{"event_id":"p:9"}')), 100);
  const t0 = Date.now();
  expect(await (await a.call("GET", "/v1/events?wait=5s")).json()).toEqual({ events: [{ event_id: "p:9" }] });
  expect(Date.now() - t0).toBeLessThan(1000);
});
