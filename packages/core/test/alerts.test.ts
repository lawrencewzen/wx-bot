import { expect, test } from "bun:test";
import { buildAlertEvent, PollAlerts } from "../src/alerts.ts";
import { Inbox } from "../src/inbox.ts";
import { memorySql } from "./helpers.ts";

test("PollAlerts: one alert per incident after the grace period, then recovered", () => {
  let now = 1_000_000;
  const a = new PollAlerts(120_000, () => now);
  expect(a.update({ ok: true })).toBeNull();
  expect(a.update({ ok: false, error: "Unable to connect" })).toBeNull();
  now += 60_000;
  expect(a.update({ ok: false, error: "Unable to connect" })).toBeNull();
  now += 61_000;
  expect(a.update({ ok: false, error: "Unable to connect" })).toEqual({ kind: "failing", since: 1000, error: "Unable to connect" });
  now += 30_000;
  expect(a.update({ ok: false, error: "x" })).toBeNull();
  expect(a.update({ ok: true })).toEqual({ kind: "recovered", since: 1000 });
  expect(a.update({ ok: true })).toBeNull();
  // A short blip never alerts and leaves no recovered alert.
  expect(a.update({ ok: false, error: "x" })).toBeNull();
  expect(a.update({ ok: true })).toBeNull();
});

test("alert events: stable id, empty text and media, alert details", () => {
  const e = buildAlertEvent("muse", "bot@im.bot", { code: "session_expired", message: "m", hint: "h", since: 42 }, 5_000);
  expect(e.event_id).toBe("muse:alert:session_expired:42");
  expect([e.kind, e.text, e.media.length, e.from_wxid, e.create_time]).toEqual(["alert", "", 0, "", 5]);
  expect(e.alert).toEqual({ code: "session_expired", message: "m", hint: "h", since: 42 });
});

test("Inbox.waiting counts old, unleased messages only", () => {
  let now = 0;
  const box = new Inbox(memorySql(), () => now);
  const p = new Uint8Array([1]);
  box.add("muse", "muse:1", p);
  box.add("muse", "muse:alert:recovered:1", p);
  box.add("other", "other:1", p);
  now = 5 * 60_000;
  box.add("muse", "muse:2", p);
  now = 11 * 60_000;
  expect(box.waiting("muse", 10 * 60_000)).toBe(1);
  box.claim(["muse"], 1, 30 * 60_000); // being handled
  expect(box.waiting("muse", 10 * 60_000)).toBe(0);
  now = 16 * 60_000;
  expect(box.waiting("muse", 10 * 60_000)).toBe(1); // muse:2 is now old too
});
