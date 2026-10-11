import { afterEach, expect, test } from "bun:test";
import { LoginApi } from "../src/login.ts";
import { serve } from "./helpers.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((s) => s()));

test("QR POST, redirect, confirm", async () => {
  const redirect = serve(async (req) => {
    const u = new URL(req.url);
    expect(u.pathname).toBe("/ilink/bot/get_qrcode_status");
    return Response.json({
      status: "confirmed",
      bot_token: "tok_abc",
      ilink_bot_id: "bot123@im.bot",
      baseurl: "https://ilink-session.example/",
      ilink_user_id: "wxid_owner",
    });
  });
  stops.push(redirect.stop);
  let statusHits = 0;
  const auth = serve(async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/ilink/bot/get_bot_qrcode") {
      expect(req.method).toBe("POST");
      expect(u.searchParams.get("bot_type")).toBe("3");
      expect(await req.text()).toBe('{"local_token_list":[]}');
      expect(req.headers.get("Content-Type")).toBe("application/json");
      expect(req.headers.get("AuthorizationType")).toBe("ilink_bot_token");
      expect(req.headers.get("X-WECHAT-UIN")).toBeTruthy();
      expect(req.headers.get("Authorization")).toBeNull();
      return Response.json({ ret: 0, qrcode: "qr-1", qrcode_img_content: "https://example.com/qr" });
    }
    for (const h of ["AuthorizationType", "Authorization", "X-WECHAT-UIN"]) expect(req.headers.get(h)).toBeNull();
    expect(req.headers.get("iLink-App-Id")).toBe("bot");
    statusHits++;
    return Response.json(statusHits === 1 ? { status: "scaned_but_redirect", redirect_host: redirect.url } : { status: "wait" });
  });
  stops.push(auth.stop);

  const shown: string[] = [];
  const session = await new LoginApi({ authBase: auth.url }).login((qr, n) => {
    shown.push(`${n}:${qr.imageContent}`);
  });
  expect(shown).toEqual(["1:https://example.com/qr"]);
  expect(session).toEqual({
    bot_token: "tok_abc",
    base_url: "https://ilink-session.example",
    ilink_bot_id: "bot123@im.bot",
    ilink_user_id: "wxid_owner",
  });
});

test("expired QR refreshes, bare redirect host gets https", async () => {
  const api = new LoginApi({
    authBase: "https://auth.example",
    fetch: async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("get_bot_qrcode")) return Response.json({ qrcode: `qr-${Math.random()}`, qrcode_img_content: "img" });
      if (u.host === "auth.example") return Response.json({ status: "scaned_but_redirect", redirect_host: "sz.example" });
      expect(u.protocol).toBe("https:");
      return Response.json({ status: "confirmed", bot_token: "t", baseurl: "https://b" });
    },
  });
  expect((await api.login(() => {})).bot_token).toBe("t");

  let qrs = 0;
  const expiring = new LoginApi({
    authBase: "https://auth.example",
    fetch: async (input) =>
      String(input).includes("get_bot_qrcode") ? (qrs++, Response.json({ qrcode: "q" })) : Response.json({ status: "expired" }),
  });
  await expect(expiring.login(() => {})).rejects.toThrow("expired");
  expect(qrs).toBe(3);
});

test("maxQr Infinity keeps refreshing until aborted", async () => {
  let qrs = 0;
  const api = new LoginApi({
    authBase: "https://auth.example",
    fetch: async (input) =>
      String(input).includes("get_bot_qrcode") ? (qrs++, Response.json({ qrcode: `q${qrs}` })) : Response.json({ status: "expired" }),
  });
  const ctl = new AbortController();
  const shown: number[] = [];
  const p = api.login((_, n) => {
    shown.push(n);
    if (n === 5) ctl.abort(new Error("timeout"));
  }, ctl.signal, Infinity);
  await expect(p).rejects.toThrow();
  expect(shown).toEqual([1, 2, 3, 4, 5]);
});
