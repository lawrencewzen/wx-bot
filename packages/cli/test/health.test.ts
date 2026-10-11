import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judge } from "../src/cmd/health.ts";
import type { BindingStatus } from "../src/cmd/status.ts";
import { HealthWriter, pollStatus, proxyFromEnv, readHealth, type PollStatus } from "../src/health.ts";

test("HealthWriter tracks failures, recovery and heartbeat throttling", () => {
  const path = join(mkdtempSync(join(tmpdir(), "wxh-")), "health.json");
  let now = Date.parse("2026-10-10T12:00:00Z");
  const w = new HealthWriter(path, () => now);
  const alive = () => true;
  expect(pollStatus(readHealth(path), now, alive).state).toBe("starting");
  now += 1000;
  w.update({ ok: true });
  expect(pollStatus(readHealth(path), now, alive).state).toBe("ok");

  now += 1000;
  w.update({ ok: false, error: "Unable to connect" });
  now += 5000;
  w.update({ ok: false, error: "Unable to connect" });
  let p = pollStatus(readHealth(path), now, alive);
  expect([p.state, p.failures, p.error, p.for_ms]).toEqual(["failing", 2, "Unable to connect", 5000]);

  now += 1000;
  w.update({ ok: true });
  expect(pollStatus(readHealth(path), now, alive).state).toBe("ok");

  // Healthy rounds within 30s are not written; the file still reads ok.
  const before = readHealth(path)!.updated_at;
  now += 10_000;
  w.update({ ok: true });
  expect(readHealth(path)!.updated_at).toBe(before);
  now += 25_000;
  w.update({ ok: true });
  expect(readHealth(path)!.updated_at).not.toBe(before);

  expect(pollStatus(readHealth(path), now + 6 * 60_000, alive).state).toBe("stalled");
  expect(pollStatus(readHealth(path), now, () => false).state).toBe("not_running");
  w.close();
  expect(existsSync(path)).toBe(false);
  expect(pollStatus(readHealth(path), now, alive).state).toBe("not_running");
});

test("proxyFromEnv strips credentials", () => {
  expect(proxyFromEnv({ https_proxy: "http://user:pass@hatch-egress-proxy:3128" })).toBe("http://hatch-egress-proxy:3128");
  expect(proxyFromEnv({ HTTPS_PROXY: "http://p:8080/" })).toBe("http://p:8080");
  expect(proxyFromEnv({})).toBe("");
});

const st = (poll: PollStatus, extra: Partial<BindingStatus> = {}): BindingStatus => ({
  name: "muse", logged_in: true, expired: false, bot_id: "", cursor_set: true, allowlist: [], delivery: "pull", webhook_host: "", poll, ...extra,
});
const failing = (proxy: string, for_ms = 180_000): PollStatus => ({ state: "failing", for_ms, failures: 9, error: "Unable to connect", proxy });

test("judge", () => {
  expect(judge(st({ state: "ok", for_ms: 3000 }), 120_000, "").ok).toBe(true);
  expect(judge(st({ state: "starting" }), 120_000, "").ok).toBe(true);
  expect(judge(st({ state: "not_running" }), 120_000, "").line).toContain("not running");
  expect(judge(st({ state: "ok" }, { expired: true }), 120_000, "").line).toContain("wx-bot login muse");
  expect(judge(st({ state: "ok" }, { logged_in: false }), 120_000, "").ok).toBe(false);

  expect(judge(st(failing("", 30_000)), 120_000, "http://proxy:3128").ok).toBe(true);
  const noProxy = judge(st(failing("")), 120_000, "http://proxy:3128");
  expect(noProxy.ok).toBe(false);
  expect(noProxy.line).toContain("the service has no proxy but this shell uses http://proxy:3128");
  expect(judge(st(failing("http://old:1")), 120_000, "http://new:2").line).toContain("update the proxy lines");
  expect(judge(st(failing("http://p:1")), 120_000, "http://p:1").line).toContain("if its credentials changed");
  expect(judge(st(failing("")), 120_000, "").line).toContain("check the network");
});

test("judge --liveness only flags a stopped or stuck run", () => {
  expect(judge(st(failing("")), 120_000, "http://p:1", true).ok).toBe(true);
  expect(judge(st({ state: "ok" }, { expired: true }), 120_000, "", true).ok).toBe(true);
  expect(judge(st({ state: "not_running" }), 120_000, "", true).ok).toBe(false);
  expect(judge(st({ state: "stalled", for_ms: 400_000 }), 120_000, "", true).ok).toBe(false);
});
