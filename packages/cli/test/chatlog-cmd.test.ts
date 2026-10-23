import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chatlogPath, encodeChatlog, type ChatlogRecord } from "../src/chatlog.ts";
import { CHATLOG_DISABLED, cmdChatlog, formatChatlog, parseSince } from "../src/cmd/chatlog.ts";
import type { Config } from "../src/config.ts";

function setup(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wxclq-"));
  const state = join(dir, "state");
  mkdirSync(state);
  const cfgPath = join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      state_dir: state,
      local_api: { listen: "127.0.0.1:18790" },
      chatlog_days: 30,
      bindings: [
        { name: "xiaox", delivery: "webhook", webhook: { url: "https://example/hook" } },
        { name: "muse", delivery: "pull" },
      ],
      ...over,
    }),
  );
  const cfg: Config = {
    state_dir: state,
    media_dir: join(state, "media"),
    local_api: { listen: "127.0.0.1:18790", token: "" },
    bindings: [],
    chatlog_days: 30,
  };
  return { cfgPath, cfg, state };
}

function put(cfg: Config, rec: ChatlogRecord) {
  const path = chatlogPath(cfg, rec.binding, rec.ts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeChatlog(rec), { flag: "a" });
}

function rec(over: Partial<ChatlogRecord> & Pick<ChatlogRecord, "ts" | "dir" | "binding" | "wxid">): ChatlogRecord {
  return { ...over };
}

async function run(cfgPath: string, args: string[], nowMs: number) {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m?: unknown) => {
    logs.push(String(m));
  };
  console.error = (m?: unknown) => {
    errs.push(String(m));
  };
  try {
    return { code: await cmdChatlog(cfgPath, args, nowMs), out: logs.join("\n"), err: errs.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

const now = new Date(2026, 9, 23, 15, 0, 0).getTime();
const t = (day: number, hour: number, min = 0) => new Date(2026, 9, day, hour, min, 0).getTime();

test("parseSince accepts Go durations and Nd day counts", () => {
  expect(parseSince("24h")).toBe(24 * 3_600_000);
  expect(parseSince("30m")).toBe(30 * 60_000);
  expect(parseSince("3d")).toBe(3 * 24 * 3_600_000);
  expect(parseSince("0")).toBe(0);
  expect(() => parseSince("5")).toThrow();
  expect(() => parseSince("3d2h")).toThrow();
});

test("merges two days and two bindings by ts; skips outside --since, --with, bad lines; --limit last N ascending; --json keeps extras", async () => {
  const { cfgPath, cfg } = setup();
  const a = rec({ ts: t(22, 16), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:1", text: "a" });
  const outside = rec({ ts: t(22, 14), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:0", text: "too-old" });
  const b = rec({ ts: t(22, 18), dir: "out", binding: "muse", wxid: "wxid_b", by: "agent", text: "b" });
  const other = rec({ ts: t(23, 9), dir: "in", binding: "xiaox", wxid: "wxid_z", event_id: "xiaox:z", text: "other-wxid" });
  const c = rec({ ts: t(23, 10), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:2", text: "c" });
  const d = rec({ ts: t(23, 12), dir: "out", binding: "muse", wxid: "wxid_a", by: "agent", text: "d", extra: 1 } as ChatlogRecord & { extra: number });

  put(cfg, outside);
  put(cfg, a);
  put(cfg, b);
  const cPath = chatlogPath(cfg, c.binding, c.ts);
  mkdirSync(dirname(cPath), { recursive: true });
  writeFileSync(
    cPath,
    ["not-json", "", encodeChatlog(c).trimEnd(), "{", encodeChatlog(other).trimEnd()].join("\n") + "\n",
  );
  const dPath = chatlogPath(cfg, d.binding, d.ts);
  mkdirSync(dirname(dPath), { recursive: true });
  writeFileSync(dPath, JSON.stringify(d) + "\n");

  const merged = await run(cfgPath, ["--since", "24h", "--json"], now);
  expect(merged.code).toBe(0);
  expect(JSON.parse(merged.out)).toEqual({ records: [a, b, other, c, d] });

  const withA = await run(cfgPath, ["--since", "24h", "--with", "wxid_a", "--json"], now);
  expect(JSON.parse(withA.out)).toEqual({ records: [a, c, d] });

  const limited = await run(cfgPath, ["--since", "24h", "--limit", "2", "--json"], now);
  expect(JSON.parse(limited.out)).toEqual({ records: [c, d] });

  const oneBinding = await run(cfgPath, ["--binding", "muse", "--since", "24h", "--json"], now);
  expect(JSON.parse(oneBinding.out)).toEqual({ records: [b, d] });

  const text = await run(cfgPath, ["--since", "24h", "--limit", "2"], now);
  expect(text.out).toBe(`${formatChatlog(c)}\n${formatChatlog(d)}`);
});

test("chatlog_days 0 with no files exits 1; historical files still read", async () => {
  const none = setup({ chatlog_days: 0 });
  const disabled = await run(none.cfgPath, ["--since", "24h"], now);
  expect(disabled.code).toBe(1);
  expect(disabled.err).toContain(CHATLOG_DISABLED);

  const hist = setup({ chatlog_days: 0 });
  const r = rec({ ts: t(23, 14), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:9", text: "kept" });
  put(hist.cfg, r);
  const ok = await run(hist.cfgPath, ["--since", "24h", "--json"], now);
  expect(ok.code).toBe(0);
  expect(JSON.parse(ok.out)).toEqual({ records: [r] });
});

test("unknown binding exits 1; --since 3d includes the third day back", async () => {
  const { cfgPath, cfg } = setup();
  expect((await run(cfgPath, ["--binding", "nope"], now)).code).toBe(1);

  const old = rec({ ts: t(20, 16), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:old", text: "day-3" });
  const older = rec({ ts: t(20, 14), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:older", text: "too-old" });
  put(cfg, old);
  put(cfg, older);
  const got = await run(cfgPath, ["--since", "3d", "--json"], now);
  expect(JSON.parse(got.out)).toEqual({ records: [old] });
});

test("text output covers in/out, voice, image+caption, wx-bot notice, multiline", () => {
  const samples: ChatlogRecord[] = [
    { ts: t(23, 14, 5), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:1", text: "你好" },
    { ts: t(23, 14, 6), dir: "out", binding: "xiaox", wxid: "wxid_a", by: "agent", text: "收到了" },
    { ts: t(23, 14, 7), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:2", voice_text: "明天见" },
    {
      ts: t(23, 14, 8),
      dir: "out",
      binding: "xiaox",
      wxid: "wxid_a",
      by: "agent",
      media: [{ type: "image", path: "/tmp/a.jpg", file_name: "a.jpg" }],
      caption: "见图",
    },
    {
      ts: t(23, 14, 9),
      dir: "out",
      binding: "xiaox",
      wxid: "wxid_owner",
      by: "wx-bot",
      text: "【wx-bot】Agent 已恢复处理微信消息。",
    },
    { ts: t(23, 14, 10), dir: "in", binding: "xiaox", wxid: "wxid_a", event_id: "xiaox:3", text: "第一行\n第二行\n第三行" },
  ];
  expect(samples.map(formatChatlog).join("\n")).toBe(
    [
      "2026-10-23 14:05 ← wxid_a: 你好",
      "2026-10-23 14:06 → wxid_a: 收到了",
      "2026-10-23 14:07 ← wxid_a: [语音] 明天见",
      "2026-10-23 14:08 → wxid_a: [图片 a.jpg /tmp/a.jpg] 见图",
      "2026-10-23 14:09 → wxid_owner (wx-bot): 【wx-bot】Agent 已恢复处理微信消息。",
      "2026-10-23 14:10 ← wxid_a: 第一行",
      "  第二行",
      "  第三行",
    ].join("\n"),
  );
});
