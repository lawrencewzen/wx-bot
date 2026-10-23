import { expect, test } from "bun:test";
import { IlinkClient, type FetchLike } from "../src/client.ts";
import { encryptAes128Ecb, toHex } from "../src/crypto.ts";
import { buildEvent, type MediaSink } from "../src/events.ts";
import { ItemType, type IncomingMessage, type Session } from "../src/types.ts";
import { scriptedFetch } from "./helpers.ts";

const session: Session = {
  bot_token: "t",
  base_url: "http://ilink.test",
  ilink_bot_id: "bot@im.bot",
  ilink_user_id: "owner",
};

function memSink(): MediaSink & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const sink = (async (m) => {
    const path = `/media/${m.binding}/${m.messageId}_${m.fileName}`;
    files.set(path, m.data);
    return { path };
  }) as MediaSink & { files: Map<string, Uint8Array> };
  sink.files = files;
  return sink;
}

function imageMsg(url: string, key: Uint8Array): IncomingMessage {
  return {
    message_id: "1001",
    from_user_id: "wxid_user",
    to_user_id: "bot@im.bot",
    create_time_ms: 1760000000000,
    item_list: [
      {
        type: ItemType.Image,
        image_item: { aeskey: toHex(key), media: { full_url: url, encrypt_type: 1 } },
      },
    ],
  };
}

function clientWithFetch(fetch: FetchLike) {
  return new IlinkClient(session, { fetch, downloadRetryDelaysMs: [0, 0] });
}

test("download retries after timeout then stores media", async () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const plain = new TextEncoder().encode("fake-jpeg-bytes");
  const { fetch, calls } = scriptedFetch([
    new Error("The operation timed out."),
    () => new Response(encryptAes128Ecb(plain, key)),
  ]);
  const sink = memSink();
  const ev = await buildEvent("xiaox", imageMsg("https://cdn.test/img", key), clientWithFetch(fetch), sink);
  expect(calls.length).toBe(2);
  expect(ev.media_errors).toBeUndefined();
  expect(ev.media.length).toBe(1);
  expect(ev.media[0]!.type).toBe("image");
  expect(new TextDecoder().decode(sink.files.get(ev.media[0]!.path))).toBe("fake-jpeg-bytes");
});

test("download retries after 5xx then stores media", async () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const plain = new TextEncoder().encode("after-500");
  const { fetch, calls } = scriptedFetch([
    () => new Response(null, { status: 503 }),
    () => new Response(encryptAes128Ecb(plain, key)),
  ]);
  const sink = memSink();
  const ev = await buildEvent("xiaox", imageMsg("https://cdn.test/img", key), clientWithFetch(fetch), sink);
  expect(calls.length).toBe(2);
  expect(ev.media_errors).toBeUndefined();
  expect(ev.media.length).toBe(1);
  expect(new TextDecoder().decode(sink.files.get(ev.media[0]!.path))).toBe("after-500");
});

test("three download failures record media_errors and stop at 3 requests", async () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const { fetch, calls } = scriptedFetch([new Error("The operation timed out.")]);
  const ev = await buildEvent("xiaox", imageMsg("https://cdn.test/img", key), clientWithFetch(fetch), memSink());
  expect(calls.length).toBe(3);
  expect(ev.media).toEqual([]);
  expect(ev.media_errors).toEqual(["image: The operation timed out. (3 attempts)"]);
});

test("HTTP 404 is not retried", async () => {
  const key = crypto.getRandomValues(new Uint8Array(16));
  const { fetch, calls } = scriptedFetch([() => new Response(null, { status: 404 })]);
  const ev = await buildEvent("xiaox", imageMsg("https://cdn.test/img", key), clientWithFetch(fetch), memSink());
  expect(calls.length).toBe(1);
  expect(ev.media).toEqual([]);
  expect(ev.media_errors).toEqual(["image: cdn download: status 404 (1 attempt)"]);
});
