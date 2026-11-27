import { expect, test } from "bun:test";
import { IlinkClient, type FetchLike } from "../src/client.ts";
import type { Session } from "../src/types.ts";

const session: Session = {
  bot_token: "bot-secret",
  base_url: "https://ilink.test",
  ilink_bot_id: "bot@im.bot",
  ilink_user_id: "wxid_owner",
};

function client(fetch: FetchLike, pollSlackMs = 20) {
  return new IlinkClient(session, { fetch, pollSlackMs });
}

/** Fail the test if `p` is still pending, instead of waiting out a stuck long-poll. */
function mustSettle<T>(p: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Resolves with `body` unless the request is aborted first. */
function abortableFetch(body: string, delayMs = 60_000): FetchLike {
  return (_input, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(body)), delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      if (init?.signal?.aborted) onAbort();
      else init?.signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Never settles, and does not reject when the signal aborts. */
function ignoreAbortFetch(onCall?: (init: RequestInit | undefined) => void): FetchLike {
  return (_input, init) =>
    new Promise(() => {
      onCall?.(init);
      init?.signal?.addEventListener("abort", () => {});
    });
}

test("returns a parsed long-poll body", async () => {
  let url = "";
  let method = "";
  let sent = "";
  const fetch: FetchLike = async (input, init) => {
    url = String(input);
    method = init?.method ?? "";
    sent = String(init?.body ?? "");
    return new Response(JSON.stringify({ get_updates_buf: "c2", longpolling_timeout_ms: 35_000, msgs: [] }));
  };
  const resp = await client(fetch).getUpdates("c1", 1_000);
  expect(resp).toEqual({ get_updates_buf: "c2", longpolling_timeout_ms: 35_000, msgs: [] });
  expect(url).toBe("https://ilink.test/ilink/bot/getupdates");
  expect(method).toBe("POST");
  expect(JSON.parse(sent).get_updates_buf).toBe("c1");
});

test("a non-200 and a transport error are thrown", async () => {
  await expect(client(async () => new Response("nope", { status: 503 })).getUpdates("", 1_000)).rejects.toThrow(
    "getupdates: status 503",
  );
  await expect(client(async () => { throw new Error("Unable to connect"); }).getUpdates("", 1_000)).rejects.toThrow(
    "Unable to connect",
  );
});

test("client timeout returns an empty update when abort settles the fetch", async () => {
  const started = Date.now();
  const resp = await mustSettle(client(abortableFetch("{}")).getUpdates("c", 30));
  expect(resp).toEqual({});
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("a fetch that ignores abort rejects instead of stalling the caller", async () => {
  let aborted = false;
  const started = Date.now();
  const pending = client(ignoreAbortFetch((init) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
    });
  })).getUpdates("c", 20);
  await expect(mustSettle(pending)).rejects.toThrow(/abort did not settle the request/);
  expect(aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a body read that ignores abort rejects instead of stalling the caller", async () => {
  let textStarted = false;
  const fetch: FetchLike = (_input, init) => {
    init?.signal?.addEventListener("abort", () => {});
    return Promise.resolve({
      status: 200,
      text() {
        textStarted = true;
        return new Promise(() => {});
      },
      body: { cancel: () => Promise.resolve() },
    } as unknown as Response);
  };
  const started = Date.now();
  await expect(mustSettle(client(fetch).getUpdates("c", 20))).rejects.toThrow(/abort did not settle the request/);
  expect(textStarted).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("caller abort settles a hung fetch immediately and does not return an empty update", async () => {
  const ctl = new AbortController();
  const pending = client(ignoreAbortFetch(), 5_000).getUpdates("c", 30_000, ctl.signal);
  setTimeout(() => ctl.abort(new Error("shutting down")), 20);
  const started = Date.now();
  await expect(mustSettle(pending, 1_000)).rejects.toThrow("shutting down");
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("an already-aborted signal does not start a request", async () => {
  let calls = 0;
  const ctl = new AbortController();
  ctl.abort();
  await expect(client(() => { calls++; return new Promise(() => {}); }).getUpdates("c", 1_000, ctl.signal)).rejects.toThrow(/aborted/);
  expect(calls).toBe(0);
});

test("a late rejection from an abandoned fetch is not unhandled", async () => {
  let rejectFetch: (err: Error) => void = () => {};
  const fetch: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) => {
      rejectFetch = reject;
      init?.signal?.addEventListener("abort", () => {});
    });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await expect(mustSettle(client(fetch).getUpdates("c", 20))).rejects.toThrow(/abort did not settle/);
    rejectFetch(new Error("socket reset"));
    await Bun.sleep(50);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("timeouts and listeners are cleared after a hung read and a normal timeout", async () => {
  const pending = new Set<unknown>();
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  let created = 0;
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    created++;
    const id = origSet(fn, ms, ...(args as []));
    pending.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    pending.delete(id);
    return origClear(id);
  }) as typeof clearTimeout;
  try {
    await expect(mustSettle(client(ignoreAbortFetch()).getUpdates("c", 20))).rejects.toThrow(/abort did not settle/);
    const empty = await mustSettle(client(abortableFetch("{}")).getUpdates("c", 30));
    expect(empty).toEqual({});
    expect(created).toBeGreaterThan(0);
    expect(pending.size).toBe(0);
  } finally {
    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
  }
});
