import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendRequest, WxEvent } from "@wx-bot/core";
import {
  appendChatlog,
  chatlogPath,
  encodeChatlog,
  fromInbound,
  fromOutbound,
  localDay,
  pruneChatlog,
  recordChatlog,
  recordInbound,
  recordOutbound,
  type ChatlogRecord,
} from "../src/chatlog.ts";
import type { Config } from "../src/config.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

const cfg = (dir: string, days: number): Config => ({
  state_dir: dir,
  media_dir: join(dir, "media"),
  local_api: { listen: "127.0.0.1:18790", token: "" },
  bindings: [],
  chatlog_days: days,
});

const inbound: ChatlogRecord = {
  ts: 1760000000000,
  dir: "in",
  binding: "xiaox",
  wxid: "wxid_a",
  event_id: "xiaox:1",
  text: "hello",
  voice_text: "hi",
  media: [{ type: "image", path: "/media/a.jpg", file_name: "a.jpg" }],
};

function messageEvent(over: Partial<WxEvent> = {}): WxEvent {
  return {
    schema: "wxbot.event.v1",
    event_id: "xiaox:1",
    binding: "xiaox",
    kind: "message",
    message_id: "1",
    from_wxid: "wxid_a",
    to_bot_id: "bot",
    create_time: 1760000000,
    text: "hello",
    media: [],
    has_context_token: true,
    reply_hint: "",
    ...over,
  };
}

test("chatlog_days 0 does not create files or directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "wxcl-"));
  appendChatlog(cfg(dir, 0), "xiaox", inbound);
  recordInbound(cfg(dir, 0), messageEvent());
  recordOutbound(cfg(dir, 0), { binding: "xiaox", to: "wxid_a", text: "ok" }, "agent");
  expect(existsSync(join(dir, "chatlog"))).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});

test("append writes JSONL with fixed field order, 0600/0700, and appends", () => {
  const dir = mkdtempSync(join(tmpdir(), "wxcl-"));
  const c = cfg(dir, 7);
  appendChatlog(c, "xiaox", inbound);
  const path = chatlogPath(c, "xiaox", inbound.ts);
  expect(path).toBe(join(dir, "chatlog", "xiaox", `${localDay(inbound.ts)}.jsonl`));
  expect(readFileSync(path, "utf8")).toBe(
    '{"ts":1760000000000,"dir":"in","binding":"xiaox","wxid":"wxid_a","event_id":"xiaox:1","text":"hello","voice_text":"hi","media":[{"type":"image","path":"/media/a.jpg","file_name":"a.jpg"}]}\n',
  );
  expect(mode(path)).toBe(0o600);
  expect(mode(join(dir, "chatlog"))).toBe(0o700);
  expect(mode(join(dir, "chatlog", "xiaox"))).toBe(0o700);

  appendChatlog(c, "xiaox", { ts: inbound.ts, dir: "out", binding: "xiaox", wxid: "wxid_a", by: "agent", text: "ok" });
  expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toEqual([
    '{"ts":1760000000000,"dir":"in","binding":"xiaox","wxid":"wxid_a","event_id":"xiaox:1","text":"hello","voice_text":"hi","media":[{"type":"image","path":"/media/a.jpg","file_name":"a.jpg"}]}',
    '{"ts":1760000000000,"dir":"out","binding":"xiaox","wxid":"wxid_a","by":"agent","text":"ok"}',
  ]);
});

test("encode omits absent fields; outbound media keeps path and caption", () => {
  expect(encodeChatlog({ ts: 1, dir: "in", binding: "b", wxid: "w", event_id: "b:1" })).toBe(
    '{"ts":1,"dir":"in","binding":"b","wxid":"w","event_id":"b:1"}\n',
  );
  const req: SendRequest = {
    binding: "xiaox",
    to: "wxid_a",
    caption: "见图",
    media: { kind: "image", data: new Uint8Array(), fileName: "a.png", path: "/tmp/a.png" },
  };
  expect(encodeChatlog(fromOutbound(req, "agent", 42))).toBe(
    '{"ts":42,"dir":"out","binding":"xiaox","wxid":"wxid_a","by":"agent","media":[{"type":"image","path":"/tmp/a.png","file_name":"a.png"}],"caption":"见图"}\n',
  );
  expect(encodeChatlog(fromOutbound({ binding: "xiaox", to: "wxid_owner", text: "stall" }, "wx-bot", 42))).toBe(
    '{"ts":42,"dir":"out","binding":"xiaox","wxid":"wxid_owner","by":"wx-bot","text":"stall"}\n',
  );
});

test("inbound uses create_time and skips alerts", () => {
  const dir = mkdtempSync(join(tmpdir(), "wxcl-"));
  const c = cfg(dir, 3);
  const rec = fromInbound(
    messageEvent({
      voice_text: "hi",
      media: [{ type: "image", path: "/m/a.jpg", file_name: "a.jpg", size: 9 }],
    }),
  );
  expect(rec).toEqual({
    ts: 1760000000000,
    dir: "in",
    binding: "xiaox",
    wxid: "wxid_a",
    event_id: "xiaox:1",
    text: "hello",
    voice_text: "hi",
    media: [{ type: "image", path: "/m/a.jpg", file_name: "a.jpg" }],
  });
  expect(fromInbound(messageEvent({ create_time: 0, text: "" }), 99).ts).toBe(99);

  recordInbound(c, messageEvent({ kind: "alert", text: "", from_wxid: "" }));
  expect(existsSync(join(dir, "chatlog"))).toBe(false);
  recordInbound(c, messageEvent());
  expect(existsSync(chatlogPath(c, "xiaox", 1760000000000))).toBe(true);
});

test("writes on different local days go to different files", () => {
  const dir = mkdtempSync(join(tmpdir(), "wxcl-"));
  const c = cfg(dir, 7);
  const a = new Date(2026, 9, 22, 23, 0, 0).getTime();
  const b = new Date(2026, 9, 23, 1, 0, 0).getTime();
  appendChatlog(c, "xiaox", { ts: a, dir: "in", binding: "xiaox", wxid: "w", event_id: "e1", text: "tue" });
  appendChatlog(c, "xiaox", { ts: b, dir: "in", binding: "xiaox", wxid: "w", event_id: "e2", text: "wed" });
  expect(localDay(a)).not.toBe(localDay(b));
  expect(existsSync(chatlogPath(c, "xiaox", a))).toBe(true);
  expect(existsSync(chatlogPath(c, "xiaox", b))).toBe(true);
  expect(chatlogPath(c, "xiaox", a)).not.toBe(chatlogPath(c, "xiaox", b));
});

test("pruneChatlog deletes only files older than chatlog_days", () => {
  const dir = mkdtempSync(join(tmpdir(), "wxcl-"));
  const c = cfg(dir, 2);
  const now = new Date(2026, 9, 23, 15, 0, 0).getTime();
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0).getTime();
  for (const [binding, ts] of [
    ["xiaox", day(2026, 10, 20)],
    ["xiaox", day(2026, 10, 21)],
    ["xiaox", day(2026, 10, 23)],
    ["muse", day(2026, 10, 20)],
    ["muse", day(2026, 10, 22)],
  ] as const) {
    appendChatlog(c, binding, { ts, dir: "in", binding, wxid: "w", event_id: `${binding}:${ts}`, text: "x" });
  }
  pruneChatlog({ ...c, chatlog_days: 0 }, now);
  expect(existsSync(chatlogPath(c, "xiaox", day(2026, 10, 20)))).toBe(true);

  pruneChatlog(c, now);
  expect(existsSync(chatlogPath(c, "xiaox", day(2026, 10, 20)))).toBe(false);
  expect(existsSync(chatlogPath(c, "muse", day(2026, 10, 20)))).toBe(false);
  expect(existsSync(chatlogPath(c, "xiaox", day(2026, 10, 21)))).toBe(true);
  expect(existsSync(chatlogPath(c, "xiaox", day(2026, 10, 23)))).toBe(true);
  expect(existsSync(chatlogPath(c, "muse", day(2026, 10, 22)))).toBe(true);
});

test("write failure throws from appendChatlog but recordChatlog warns and does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "wxcl-"));
  writeFileSync(join(dir, "chatlog"), "not-a-dir");
  const c = cfg(dir, 7);
  const rec: ChatlogRecord = { ts: Date.now(), dir: "in", binding: "xiaox", wxid: "w", event_id: "e", text: "hi" };
  expect(() => appendChatlog(c, "xiaox", rec)).toThrow();

  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    lines.push(String(chunk));
    return orig(chunk, ...(args as []));
  }) as typeof process.stderr.write;
  try {
    expect(() => recordChatlog(c, "xiaox", rec)).not.toThrow();
    expect(() => recordOutbound(c, { binding: "xiaox", to: "w", text: "hi" }, "agent")).not.toThrow();
  } finally {
    process.stderr.write = orig;
  }
  expect(lines.some((l) => l.includes("level=WARN") && l.includes("chatlog"))).toBe(true);
});

test("prune is a no-op when the chatlog directory is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "wxcl-"));
  mkdirSync(join(dir, "other"));
  pruneChatlog(cfg(dir, 7));
  expect(existsSync(join(dir, "chatlog"))).toBe(false);
});
