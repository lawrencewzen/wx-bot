import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, pullResponseBody, pullScope } from "../src/inbox.ts";
import { memorySql } from "./helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function make() {
  let t = 1_760_000_000_000;
  const clock = { now: () => t, add: (ms: number) => (t += ms) };
  return { inbox: new Inbox(memorySql(), clock.now), clock };
}

test("add deduplicates", () => {
  const { inbox } = make();
  expect(inbox.add("a", "a:1", enc('{"n":1}'))).toBe(true);
  expect(inbox.add("a", "a:1", enc('{"n":2}'))).toBe(false);
  const evs = inbox.claim(["a"], 10, 60_000);
  expect(evs.length).toBe(1);
  expect(new TextDecoder().decode(evs[0]!.payload)).toBe('{"n":1}');
});

test("claim, lease, ack, lease expiry", () => {
  const { inbox, clock } = make();
  for (const id of ["a:1", "a:2", "b:1"]) inbox.add(id[0]!, id, enc("{}"));
  const evs = inbox.claim(["a"], 10, 60_000);
  expect(evs.map((e) => e.eventId)).toEqual(["a:1", "a:2"]);
  expect(evs[0]!.attempts).toBe(1);
  expect(inbox.count(["a"])).toBe(0);
  expect(inbox.ack([], ["a:1"])).toBe(1);
  expect(inbox.ack([], ["a:1"])).toBe(0);
  clock.add(120_000);
  const again = inbox.claim(["a"], 10, 60_000);
  expect(again.map((e) => e.eventId)).toEqual(["a:2"]);
  expect(again[0]!.attempts).toBe(2);
  expect(inbox.stats("a")).toEqual({ pending: 1, dead: 0 });
});

test("ack restricted to bindings", () => {
  const { inbox } = make();
  inbox.add("a", "a:1", enc("{}"));
  expect(inbox.ack(["b"], ["a:1"])).toBe(0);
});

test("retry and dead", () => {
  const { inbox, clock } = make();
  inbox.add("a", "a:1", enc("{}"));
  inbox.add("a", "a:2", enc("{}"));
  inbox.claim(["a"], 2, 60_000);
  inbox.retry("a:1", "boom", clock.now() + 10_000);
  inbox.dead("a:2", "bad request");
  expect(inbox.count(["a"])).toBe(0);
  expect(inbox.nextReadyAt(["a"])).toBe(clock.now() + 10_000);
  clock.add(11_000);
  const evs = inbox.claim(["a"], 10, 60_000);
  expect(evs.map((e) => [e.eventId, e.lastError])).toEqual([["a:1", "boom"]]);
  expect(inbox.stats("a")).toEqual({ pending: 1, dead: 1 });
});

test("prune", () => {
  const { inbox, clock } = make();
  inbox.add("a", "a:old-pending", enc("{}"));
  inbox.add("a", "a:old-done", enc("{}"));
  inbox.ack([], ["a:old-done"]);
  clock.add(8 * 86_400_000);
  inbox.add("a", "a:new", enc("{}"));
  expect(inbox.prune(7 * 86_400_000)).toEqual({ expired: 1, deleted: 1 });
  expect(inbox.stats("a")).toEqual({ pending: 1, dead: 1 });
});

test("two handles on one file share the queue", () => {
  const path = join(mkdtempSync(join(tmpdir(), "inbox-")), "inbox.db");
  const a = new Inbox(memorySql(path));
  const b = new Inbox(memorySql(path));
  a.add("x", "x:1", enc("{}"));
  expect(b.claim(["x"], 1, 60_000).length).toBe(1);
  expect(a.claim(["x"], 1, 60_000).length).toBe(0);
});

test("pull helpers", () => {
  expect(() => pullScope([], "")).toThrow("pull");
  expect(pullScope(["a", "b"], "")).toEqual(["a", "b"]);
  expect(() => pullScope(["a"], "w")).toThrow("does not use pull");
  const { inbox } = make();
  inbox.add("a", "a:1", enc('{"event_id":"a:1"}\n'));
  expect(pullResponseBody(inbox.claim(["a"], 5, 1000))).toBe('{"events":[{"event_id":"a:1"}]}');
  expect(pullResponseBody([])).toBe('{"events":[]}');
});
