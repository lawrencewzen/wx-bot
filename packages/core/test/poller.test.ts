import { afterEach, expect, test } from "bun:test";
import { IlinkClient } from "../src/client.ts";
import { encryptAes128Ecb, toHex } from "../src/crypto.ts";
import type { MediaSink, WxEvent } from "../src/events.ts";
import { Inbox } from "../src/inbox.ts";
import { Poller, type PollerStore, type PollHealth } from "../src/poller.ts";
import { ItemType, type GetUpdatesResponse } from "../src/types.ts";
import { memorySql, serve, until } from "./helpers.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((s) => s()));

/** Fake iLink that replays scripted getupdates bodies (raw JSON strings). */
function fakeIlink(bodies: string[]) {
  const requests: { headers: Headers; body: string }[] = [];
  let i = 0;
  const srv = serve(async (req) => {
    requests.push({ headers: req.headers, body: await req.text() });
    if (i < bodies.length) return new Response(bodies[i++]);
    await Bun.sleep(30);
    return Response.json({});
  });
  stops.push(srv.stop);
  return { url: srv.url, requests };
}

function memStore() {
  const s = { cursor: "", tokens: {} as Record<string, string>, expired: false };
  const store: PollerStore = {
    loadCursor: async () => s.cursor,
    saveCursor: async (c) => void (s.cursor = c),
    saveTokens: async (t) => void (s.tokens = { ...t }),
    markExpired: async () => void (s.expired = true),
  };
  return { s, store };
}

const memSink = (): MediaSink & { files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>();
  const sink = (async (m) => {
    const path = `/media/${m.binding}/${m.messageId}_${m.fileName}`;
    files.set(path, m.data);
    return { path };
  }) as MediaSink & { files: Map<string, Uint8Array> };
  sink.files = files;
  return sink;
};

function setup(bodies: string[], opts: Partial<{ allow: string[] }> = {}) {
  const il = fakeIlink(bodies);
  const client = new IlinkClient({ bot_token: "bot-secret", base_url: il.url, ilink_bot_id: "bot@im.bot", ilink_user_id: "wxid_owner" });
  const inbox = new Inbox(memorySql());
  const { s, store } = memStore();
  const sink = memSink();
  const health: PollHealth[] = [];
  const poller = new Poller({
    binding: "xiaox",
    client,
    store,
    inbox,
    media: sink,
    allow: new Set(opts.allow ?? ["wxid_owner"]),
    pollTimeoutMs: 200,
    retryDelayMs: 10,
    backoffDelayMs: 20,
    onHealth: (h) => health.push(h),
  });
  const ctl = new AbortController();
  const done = poller.run(ctl.signal);
  const events = () =>
    inbox.claim(["xiaox"], 100, 3_600_000).map((e) => JSON.parse(new TextDecoder().decode(e.payload)) as WxEvent);
  return { il, client, inbox, s, sink, ctl, done, events, health };
}

test("queues allowed messages with media, skips strangers, saves cursor and tokens", async () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const plain = new TextEncoder().encode("fake-jpeg-bytes");
  const cdn = serve(() => new Response(encryptAes128Ecb(plain, key)));
  stops.push(cdn.stop);
  const body = JSON.stringify({
    get_updates_buf: "cursor-42",
    msgs: [
      {
        message_id: 1001,
        from_user_id: "wxid_owner",
        to_user_id: "bot@im.bot",
        create_time_ms: 1760000000000,
        context_token: "ctx-owner",
        item_list: [
          { type: ItemType.Text, text_item: { text: "hello" } },
          { type: ItemType.Voice, voice_item: { media: {}, text: "transcribed speech" } },
          { type: ItemType.Image, image_item: { aeskey: toHex(key), media: { full_url: cdn.url, encrypt_type: 1 } } },
        ],
      },
      { message_id: 1002, from_user_id: "wxid_stranger", context_token: "ctx-x", item_list: [{ type: 1, text_item: { text: "nope" } }] },
    ],
  }).replace('"message_id":1001', '"message_id":7514704890273826440');
  const t = setup([body]);
  await until(() => t.s.cursor === "cursor-42", 3000, "cursor");
  t.ctl.abort();
  expect(await t.done).toBe("stopped");

  const evs = t.events();
  expect(evs.length).toBe(1);
  const e = evs[0]!;
  expect(e.event_id).toBe("xiaox:7514704890273826440");
  expect(e.message_id).toBe("7514704890273826440");
  expect(e.schema).toBe("wxbot.event.v1");
  expect([e.text, e.voice_text, e.create_time, e.has_context_token]).toEqual(["hello", "transcribed speech", 1760000000, true]);
  expect(e.media.length).toBe(1);
  expect(e.media[0]!.type).toBe("image");
  expect(new TextDecoder().decode(t.sink.files.get(e.media[0]!.path))).toBe("fake-jpeg-bytes");
  expect(Object.keys(e)).toEqual([
    "schema", "event_id", "binding", "kind", "message_id", "from_wxid", "to_bot_id", "create_time",
    "text", "voice_text", "media", "has_context_token", "reply_hint",
  ]);
  expect(t.s.tokens).toEqual({ "wxid_owner": "ctx-owner" });
  const h = t.il.requests[0]!.headers;
  expect([h.get("Authorization"), h.get("AuthorizationType")]).toEqual(["Bearer bot-secret", "ilink_bot_token"]);
});

test("business error keeps cursor; replay delivers once", async () => {
  const msg = { message_id: 11, from_user_id: "wxid_owner", item_list: [{ type: 1, text_item: { text: "x" } }] };
  const t = setup([
    JSON.stringify({ ret: -1, get_updates_buf: "bad", msgs: [msg] }),
    JSON.stringify({ get_updates_buf: "c1", msgs: [msg] }),
    JSON.stringify({ get_updates_buf: "c2", msgs: [msg] }),
  ]);
  await until(() => t.s.cursor === "c2", 3000, "cursor c2");
  t.ctl.abort();
  await t.done;
  expect(t.events().length).toBe(1);
  expect(JSON.parse(t.il.requests[1]!.body).get_updates_buf).toBe("");
  expect(JSON.parse(t.il.requests[2]!.body).get_updates_buf).toBe("c1");
  expect(t.health.slice(0, 3)).toEqual([{ ok: false, error: "getupdates ret=-1 errcode=0" }, { ok: true }, { ok: true }]);
});

test("transport errors are reported as unhealthy until a poll succeeds", async () => {
  const t = setup([]);
  await until(() => t.health.some((h) => h.ok), 3000, "first ok");
  t.ctl.abort();
  await t.done;
  const c = new IlinkClient({ bot_token: "x", base_url: "http://127.0.0.1:1", ilink_bot_id: "b", ilink_user_id: "u" });
  const health: PollHealth[] = [];
  const ctl = new AbortController();
  const p = new Poller({
    binding: "x", client: c, store: memStore().store, inbox: t.inbox, media: memSink(), allow: new Set(),
    pollTimeoutMs: 200, retryDelayMs: 10, backoffDelayMs: 10, onHealth: (h) => health.push(h),
  });
  const done = p.run(ctl.signal);
  await until(() => health.length >= 2, 3000, "two failures");
  ctl.abort();
  await done;
  expect(health.every((h) => !h.ok && h.error.length > 0)).toBe(true);
});

test("-14 marks expired and stops", async () => {
  const t = setup([JSON.stringify({ errcode: -14, get_updates_buf: "x" })]);
  expect(await t.done).toBe("expired");
  expect(t.s.expired).toBe(true);
  expect(t.s.cursor).toBe("");
});

test("queue failure keeps cursor", async () => {
  const t = setup([JSON.stringify({ get_updates_buf: "must-not-save", msgs: [{ message_id: 31, from_user_id: "wxid_owner" }] })]);
  (t.inbox as unknown as { add: () => never }).add = () => {
    throw new Error("disk full");
  };
  await Bun.sleep(300);
  t.ctl.abort();
  await t.done;
  expect(t.s.cursor).toBe("");
  expect(t.health[0]).toEqual({ ok: false, error: "queue message: disk full" });
});

test("deadline stops before a poll that would overrun", async () => {
  const t = setup([]);
  t.ctl.abort();
  await t.done;
  const p = new Poller({
    binding: "x",
    client: t.client,
    store: memStore().store,
    inbox: t.inbox,
    media: memSink(),
    allow: new Set(),
    pollTimeoutMs: 200,
  });
  expect(await p.run(undefined, Date.now() + 5_000)).toBe("deadline");
});
