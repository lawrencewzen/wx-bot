import { POLL_TIMEOUT_SLACK_MS, type IlinkClient } from "./client.ts";
import { buildEvent, encodeEvent, type MediaSink, type WxEvent } from "./events.ts";
import type { Inbox } from "./inbox.ts";
import { ERR_CODE_EXPIRED, type IncomingMessage } from "./types.ts";

/** Per-binding persisted state the poller needs. */
export interface PollerStore {
  loadCursor(): Promise<string>;
  saveCursor(cursor: string): Promise<void>;
  saveTokens(tokens: Record<string, string>): Promise<void>;
  markExpired(): Promise<void>;
}

export interface PollerOptions {
  binding: string;
  client: IlinkClient;
  store: PollerStore;
  inbox: Inbox;
  media: MediaSink;
  /** wxids allowed to talk to the bot (the scanned login user). */
  allow: Set<string>;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** Called after every getupdates round: ok, or the error that made it fail. */
  onHealth?: (h: PollHealth) => void;
  /** Called after a new event is queued (duplicates skipped). Errors are logged, not thrown. */
  onQueued?: (ev: WxEvent) => void | Promise<void>;
  pollTimeoutMs?: number;
  retryDelayMs?: number;
  backoffDelayMs?: number;
  maxFailures?: number;
}

export type PollHealth = { ok: true } | { ok: false; error: string };

export type PollerExit = "stopped" | "expired" | "deadline";

/**
 * Upper bound for one getupdates hold, whether it came from options or the server.
 * `status` treats health.json older than 5 minutes as a stalled poller, and a
 * healthy write can be skipped for 30s, so the hold plus the client slack (10s)
 * has to finish inside that window. The server's usual value is 35s.
 */
export const MAX_POLL_TIMEOUT_MS = 3 * 60_000;

function boundedPollTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return Math.min(35_000, MAX_POLL_TIMEOUT_MS);
  return Math.min(ms, MAX_POLL_TIMEOUT_MS);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Long-polls getupdates and queues each message in the inbox. The cursor
 * advances only after the whole batch is queued, so a failure replays the
 * batch (the inbox ignores duplicate event ids).
 */
export class Poller {
  private readonly o: Required<Omit<PollerOptions, "log" | "onHealth" | "onQueued">> &
    Pick<PollerOptions, "log" | "onHealth" | "onQueued">;

  constructor(opts: PollerOptions) {
    this.o = {
      pollTimeoutMs: 35_000,
      retryDelayMs: 2_000,
      backoffDelayMs: 30_000,
      maxFailures: 3,
      ...opts,
    };
  }

  private log(level: "info" | "warn" | "error", msg: string) {
    this.o.log?.(level, msg);
  }

  private health(h: PollHealth) {
    try {
      this.o.onHealth?.(h);
    } catch (err) {
      this.log("warn", `health callback: ${(err as Error).message}`);
    }
  }

  /**
   * Poll until signal aborts, the session expires, or (if given) the next
   * long-poll could run past deadlineMs.
   */
  async run(signal?: AbortSignal, deadlineMs?: number): Promise<PollerExit> {
    const o = this.o;
    let cursor = "";
    try {
      cursor = await o.store.loadCursor();
    } catch (err) {
      this.log("warn", `load cursor: ${(err as Error).message}`);
    }
    let pollTimeout = boundedPollTimeout(o.pollTimeoutMs);
    let failures = 0;

    const pause = async () => {
      failures++;
      await sleep(failures >= o.maxFailures ? o.backoffDelayMs : o.retryDelayMs, signal);
    };

    for (;;) {
      if (signal?.aborted) return "stopped";
      if (deadlineMs !== undefined && Date.now() + pollTimeout + POLL_TIMEOUT_SLACK_MS > deadlineMs) return "deadline";

      let resp;
      try {
        resp = await o.client.getUpdates(cursor, pollTimeout, signal);
      } catch (err) {
        if (signal?.aborted) return "stopped";
        this.log("warn", `getupdates error (failures ${failures + 1}): ${(err as Error).message}`);
        this.health({ ok: false, error: (err as Error).message });
        await pause();
        continue;
      }

      if (resp.errcode === ERR_CODE_EXPIRED || resp.ret === ERR_CODE_EXPIRED) {
        this.log("error", `binding ${o.binding} session expired: run \`wx-bot login ${o.binding}\``);
        await o.store.markExpired();
        return "expired";
      }
      // Business error: keep cursor and messages untouched, retry like a transport error.
      if (resp.ret || resp.errcode) {
        this.log("warn", `getupdates business error ret=${resp.ret ?? 0} errcode=${resp.errcode ?? 0}; cursor unchanged`);
        this.health({ ok: false, error: `getupdates ret=${resp.ret ?? 0} errcode=${resp.errcode ?? 0}` });
        await pause();
        continue;
      }
      failures = 0;
      const suggested = resp.longpolling_timeout_ms;
      if (typeof suggested === "number" && Number.isFinite(suggested) && suggested > 0) {
        const next = Math.min(suggested, MAX_POLL_TIMEOUT_MS);
        if (suggested > next && next !== pollTimeout) {
          this.log("warn", `longpolling_timeout_ms ${suggested} capped at ${MAX_POLL_TIMEOUT_MS}`);
        }
        pollTimeout = next;
      }

      let queued = true;
      for (const msg of resp.msgs ?? []) {
        try {
          await this.handle(msg);
        } catch (err) {
          this.log("error", `queue message ${msg.message_id} failed; cursor unchanged: ${(err as Error).message}`);
          this.health({ ok: false, error: `queue message: ${(err as Error).message}` });
          queued = false;
          break;
        }
      }
      if (!queued) {
        await sleep(o.retryDelayMs, signal);
        continue;
      }
      this.health({ ok: true });
      if (resp.get_updates_buf) {
        try {
          await o.store.saveCursor(resp.get_updates_buf);
        } catch (err) {
          this.log("error", `save cursor: ${(err as Error).message}`);
        }
        cursor = resp.get_updates_buf;
      }
    }
  }

  /** Queue one message; throws only when it could not be queued. */
  private async handle(msg: IncomingMessage): Promise<void> {
    const o = this.o;
    const wxid = msg.from_user_id;
    if (!o.allow.has(wxid)) {
      this.log("info", `unallowed sender ${wxid}`);
      return;
    }
    if (msg.context_token) {
      o.client.contextTokens.set(wxid, msg.context_token);
      try {
        await o.store.saveTokens(o.client.tokens());
      } catch (err) {
        this.log("error", `save context tokens: ${(err as Error).message}`);
      }
    }
    const ev = await buildEvent(o.binding, msg, o.client, o.media, (m) => this.log("warn", m));
    if (!o.inbox.add(o.binding, ev.event_id, encodeEvent(ev))) return;
    try {
      await o.onQueued?.(ev);
    } catch (err) {
      this.log("warn", `onQueued: ${(err as Error).message}`);
    }
  }
}
