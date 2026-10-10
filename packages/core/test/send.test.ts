import { afterEach, expect, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import { IlinkClient } from "../src/client.ts";
import { WxBotError } from "../src/errors.ts";
import { allowlist, sendMessage } from "../src/send.ts";
import { ItemType } from "../src/types.ts";
import { serve } from "./helpers.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((s) => s()));

function fake() {
  const sent: any[] = [];
  const uploads: { url: string; body: Uint8Array }[] = [];
  const upReqs: any[] = [];
  const srv = serve(async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/ilink/bot/sendmessage") {
      sent.push(await req.json());
      return Response.json({ ret: 0 });
    }
    if (u.pathname === "/ilink/bot/getuploadurl") {
      upReqs.push(await req.json());
      return Response.json({ ret: 0, upload_param: "UP" });
    }
    if (u.pathname === "/cdn/upload") {
      uploads.push({ url: req.url, body: new Uint8Array(await req.arrayBuffer()) });
      return new Response(null, { headers: { "x-encrypted-param": "DL" } });
    }
    return new Response(null, { status: 404 });
  });
  stops.push(srv.stop);
  const client = new IlinkClient(
    { bot_token: "t", base_url: srv.url, ilink_bot_id: "bot@im.bot", ilink_user_id: "owner" },
    { cdnBase: `${srv.url}/cdn` },
  );
  return { client, sent, uploads, upReqs };
}

test("text is split and carries the context token", async () => {
  const f = fake();
  f.client.contextTokens.set("owner", "ctx");
  await sendMessage(f.client, allowlist([], "owner"), { binding: "b", to: "owner", text: "x".repeat(4001) });
  expect(f.sent.map((s) => s.msg.item_list[0].text_item.text.length)).toEqual([2000, 2000, 1]);
  const m = f.sent[0].msg;
  expect([m.from_user_id, m.to_user_id, m.context_token, m.message_type, m.message_state]).toEqual(["bot@im.bot", "owner", "ctx", 2, 2]);
  expect(m.client_id).toMatch(/^wxbot-[0-9a-f]{16}$/);
});

test("file upload: encrypted body, md5, caption first, original name kept", async () => {
  const f = fake();
  f.client.contextTokens.set("owner", "ctx");
  const data = new TextEncoder().encode("hello pdf bytes");
  await sendMessage(f.client, allowlist([], "owner"), {
    binding: "b",
    to: "owner",
    caption: "见附件",
    media: { kind: "file", data, fileName: "/tmp/报告.pdf" },
  });
  const up = f.upReqs[0];
  expect(up.media_type).toBe(3);
  expect(up.rawsize).toBe(data.length);
  expect(up.filesize).toBe(16);
  expect(up.rawfilemd5).toBe(createHash("md5").update(data).digest("hex"));
  expect(up.no_need_thumb).toBe(true);
  expect(new URL(f.uploads[0]!.url).searchParams.get("filekey")).toBe(up.filekey);
  const d = createDecipheriv("aes-128-ecb", Buffer.from(up.aeskey, "hex"), null);
  expect(Buffer.concat([d.update(f.uploads[0]!.body), d.final()]).toString()).toBe("hello pdf bytes");

  expect(f.sent[0].msg.item_list[0].text_item.text).toBe("见附件");
  const item = f.sent[1].msg.item_list[0];
  expect(item.type).toBe(ItemType.File);
  expect(item.file_item.file_name).toBe("报告.pdf");
  expect(item.file_item.media.encrypt_query_param).toBe("DL");
  expect(atob(item.file_item.media.aes_key)).toBe(up.aeskey);
});

test("allowlist and context token are enforced", async () => {
  const f = fake();
  const allow = allowlist(["a"], "owner");
  await expect(sendMessage(f.client, allow, { binding: "b", to: "owner", text: "x" })).rejects.toMatchObject({ kind: "forbidden" });
  await expect(sendMessage(f.client, allow, { binding: "b", to: "a", text: "x" })).rejects.toMatchObject({ kind: "no_context" });
  expect(f.sent.length).toBe(0);
});

test("expired session surfaces as kind expired", async () => {
  const srv = serve(() => Response.json({ ret: -14 }));
  stops.push(srv.stop);
  const c = new IlinkClient({ bot_token: "t", base_url: srv.url, ilink_bot_id: "b", ilink_user_id: "o" });
  c.contextTokens.set("o", "ctx");
  const err = await sendMessage(c, allowlist([], "o"), { binding: "b", to: "o", text: "x" }).catch((e) => e);
  expect(err).toBeInstanceOf(WxBotError);
  expect(err.kind).toBe("expired");
});
