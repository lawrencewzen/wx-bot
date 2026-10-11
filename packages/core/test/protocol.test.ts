import { expect, test } from "bun:test";
import { appHeaders, appIdentityHeaders } from "../src/headers.ts";
import { parseIlinkJson } from "../src/json.ts";
import { baseName, itemTypeFromName, sanitizeFilename, splitText } from "../src/text.ts";
import { ItemType } from "../src/types.ts";

test("int64 message ids survive JSON parsing", () => {
  const raw = '{"ret":0,"msgs":[{"seq":12,"message_id":7514704890273826440,"from_user_id":"x","item_list":[{"type":1,"text_item":{"text":"\\"message_id\\":1"}}]}]}';
  const r = parseIlinkJson<{ msgs: { message_id: string; seq: string; item_list: { text_item: { text: string } }[] }[] }>(raw);
  expect(r.msgs[0]!.message_id).toBe("7514704890273826440");
  expect(r.msgs[0]!.item_list[0]!.text_item.text).toBe('"message_id":1');
});

test("splitText counts code points", () => {
  expect(splitText("abc", 2)).toEqual(["ab", "c"]);
  expect(splitText("😀😀😀", 2)).toEqual(["😀😀", "😀"]);
  expect(splitText("hi", 0)).toEqual(["hi"]);
});

test("filenames", () => {
  expect(sanitizeFilename("../../evil photo.png")).toBe("evil_photo.png");
  expect(sanitizeFilename("..")).toBe("attachment");
  expect(sanitizeFilename("报告.pdf")).toBe("__.pdf");
  expect(baseName("/a/b/报告.pdf")).toBe("报告.pdf");
  expect(itemTypeFromName("a.JPG")).toBe(ItemType.Image);
  expect(itemTypeFromName("a.mov")).toBe(ItemType.Video);
  expect(itemTypeFromName("a.pdf")).toBe(ItemType.File);
});

test("headers", () => {
  expect(appIdentityHeaders()).toEqual({ "iLink-App-Id": "bot", "iLink-App-ClientVersion": "132106" });
  const h = appHeaders("tok");
  expect(h.Authorization).toBe("Bearer tok");
  expect(h.AuthorizationType).toBe("ilink_bot_token");
  expect(/^\d+$/.test(atob(h["X-WECHAT-UIN"]!))).toBe(true);
  expect(appHeaders().Authorization).toBeUndefined();
});
