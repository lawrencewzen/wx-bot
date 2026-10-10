import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLoopbackListen, DEFAULT_LISTEN, inboxPath, loadConfig, pullBindings } from "../src/config.ts";

const writeCfg = (body: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "cfg-")), "config.json");
  writeFileSync(p, body);
  return p;
};
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

test("valid config gets defaults", async () => {
  const c = await loadConfig(writeCfg(`{"bindings":[{"name":"xiaox","webhook":{"url":"https://agent.example/hook"}}]}`));
  expect(c.state_dir.endsWith(join(".local", "state", "wx-bot"))).toBe(true);
  expect(c.media_dir).toBe(join(c.state_dir, "media"));
  expect(c.local_api.listen).toBe(DEFAULT_LISTEN);
  expect(c.bindings[0]!.webhook.key_header).toBe("Authorization");
  expect(c.bindings[0]!.webhook.key_prefix).toBe("Bearer ");
  expect(c.bindings[0]!.delivery).toBe("webhook");
  expect(inboxPath(c).endsWith("inbox.db")).toBe(true);
});

test("env expansion and ~", async () => {
  process.env.WX_HOOK = "https://hooks.example/x";
  process.env.WX_KEY = "sekrit";
  process.env.WX_TOKEN = "local-token";
  const c = await loadConfig(
    writeCfg(`{"state_dir":"~/s","local_api":{"listen":"127.0.0.1:19999","token":"env:WX_TOKEN"},
      "bindings":[{"name":"xiaox","webhook":{"url":"env:WX_HOOK","key":"env:WX_KEY","secret":"env:WX_KEY"}}]}`),
  );
  expect(c.bindings[0]!.webhook).toMatchObject({ url: "https://hooks.example/x", key: "sekrit", secret: "sekrit" });
  expect(c.local_api.token).toBe("local-token");
  expect(c.state_dir.startsWith("~")).toBe(false);
});

test.each([
  [`{"bindings":[{"name":"a","webhook":{"url":"https://x"}},{"name":"a","webhook":{"url":"https://y"}}]}`, "duplicate"],
  [`{"bindings":[{"name":"NOPE","webhook":{"url":"https://x"}}]}`, "invalid"],
  [`{"local_api":{"listen":"0.0.0.0:18790"},"bindings":[]}`, "loopback"],
  [`{"local_api":{"listen":"8.8.8.8:80"},"bindings":[]}`, "loopback"],
  [`{"nope":true,"bindings":[]}`, "unknown field"],
  [`{"bindings":[{"name":"a","webhook":{"url":"https://x","bogus":1}}]}`, "unknown field"],
  [`{"bindings":[{"name":"a","delivery":"exec"}]}`, "delivery"],
])("rejects %s", async (body, want) => {
  await expect(loadConfig(writeCfg(body))).rejects.toThrow(want);
});

test("unset and empty env vars name the variable and field", async () => {
  delete process.env.WXBOT_TEST_UNSET_ENV;
  const e1 = await loadConfig(writeCfg(`{"bindings":[{"name":"x","webhook":{"url":"https://x","key":"env:WXBOT_TEST_UNSET_ENV"}}]}`)).catch((e) => e);
  expect(e1.message).toContain("WXBOT_TEST_UNSET_ENV");
  expect(e1.message).toContain("webhook.key");
  process.env.WXBOT_TEST_EMPTY_ENV = "";
  const e2 = await loadConfig(writeCfg(`{"bindings":[{"name":"x","webhook":{"url":"https://x","secret":"env:WXBOT_TEST_EMPTY_ENV"}}]}`)).catch((e) => e);
  expect(e2.message).toContain("WXBOT_TEST_EMPTY_ENV");
  expect(e2.message).toContain("webhook.secret");
});

test("pull bindings", async () => {
  const c = await loadConfig(writeCfg(`{"bindings":[{"name":"a","webhook":{"url":"https://x"}},{"name":"b","delivery":"pull"}]}`));
  expect(pullBindings(c)).toEqual(["b"]);
});

test("loopback listen", async () => {
  for (const ok of ["127.0.0.1:18790", "[::1]:18790", "localhost:9", "127.0.0.5:1"]) await checkLoopbackListen(ok);
  for (const bad of [":18790", "127.0.0.1", "10.0.0.1:80", "[::]:80"]) await expect(checkLoopbackListen(bad)).rejects.toThrow();
});
