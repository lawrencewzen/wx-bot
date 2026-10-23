import type { FetchLike } from "./client.ts";
import { bytes, toHex } from "./crypto.ts";
import type { Inbox, QueuedEvent } from "./inbox.ts";

export interface WebhookConfig {
  url: string;
  key?: string;
  /** Default "Authorization". */
  keyHeader?: string;
  /** Default "Bearer ". */
  keyPrefix?: string;
  /** When set, adds X-WxBot-Signature: sha256=HMAC(secret, body). */
  secret?: string;
}

export const WEBHOOK_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_ERROR_BODY = 2048;
const REJECT_STATUSES = [400, 413, 422];
const RATE_LIMIT_RE = /rate limit/i;
/** 1, 2, 5, then 10 minutes for every later attempt. */
const RATE_LIMIT_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];

export class WebhookStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body = "",
  ) {
    super(body ? `webhook status ${status}: ${body.length > 240 ? `${body.slice(0, 240)}…` : body}` : `webhook status ${status}`);
    this.name = "WebhookStatusError";
  }
}

function isRateLimitReject(err: unknown): boolean {
  return err instanceof WebhookStatusError && REJECT_STATUSES.includes(err.status) && RATE_LIMIT_RE.test(err.body);
}

/** A rejection that will not succeed on retry with the same body. */
export function isPermanent(err: unknown): boolean {
  return err instanceof WebhookStatusError && REJECT_STATUSES.includes(err.status) && !RATE_LIMIT_RE.test(err.body);
}

/** Default 2s, 4s, 8s ... capped at 5 minutes. Rate-limited 400/413/422 use 1/2/5/10 min. */
export function retryBackoffMs(attempt: number, err?: unknown): number {
  if (isRateLimitReject(err)) {
    return RATE_LIMIT_BACKOFF_MS[Math.min(Math.max(attempt, 1), RATE_LIMIT_BACKOFF_MS.length) - 1]!;
  }
  let d = 2000;
  for (let i = 1; i < attempt && d < MAX_BACKOFF_MS; i++) d *= 2;
  return Math.min(d, MAX_BACKOFF_MS);
}

/** First ~2KB of a non-2xx body for logs and rate-limit detection. Read failures are ignored. */
async function peekErrorBody(resp: Response): Promise<string> {
  try {
    const reader = resp.body?.getReader();
    if (!reader) return "";
    try {
      const buf = new Uint8Array(MAX_ERROR_BODY);
      let n = 0;
      while (n < buf.length) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        const take = Math.min(value.byteLength, buf.length - n);
        buf.set(value.subarray(0, take), n);
        n += take;
      }
      return new TextDecoder().decode(buf.subarray(0, n));
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    return "";
  }
}

export async function signBody(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return `sha256=${toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(body))))}`;
}

/** POST one encoded event. Throws WebhookStatusError on non-2xx. */
export async function postWebhook(cfg: WebhookConfig, body: Uint8Array, fetchImpl: FetchLike = fetch): Promise<void> {
  if (!cfg.url) throw new Error("webhook url is empty");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.key) headers[cfg.keyHeader || "Authorization"] = (cfg.keyPrefix ?? "Bearer ") + cfg.key;
  if (cfg.secret) {
    headers["X-WxBot-Signature"] = await signBody(cfg.secret, body);
    headers["X-WxBot-Timestamp"] = String(Math.floor(Date.now() / 1000));
  }
  const resp = await fetchImpl(cfg.url, {
    method: "POST",
    headers,
    body: bytes(body),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    redirect: "manual",
  });
  if (resp.status < 300) {
    await resp.body?.cancel();
    return;
  }
  throw new WebhookStatusError(resp.status, await peekErrorBody(resp));
}

export type DeliveryOutcome = "idle" | "delivered" | "retry" | "dead";

/**
 * Claim and deliver the oldest ready event of binding. A failure is retried
 * with backoff without blocking later events.
 */
export async function deliverNext(
  inbox: Inbox,
  binding: string,
  cfg: WebhookConfig,
  opts: { fetch?: FetchLike; leaseMs?: number; now?: () => number; log?: (msg: string) => void } = {},
): Promise<DeliveryOutcome> {
  const [ev] = inbox.claim([binding], 1, opts.leaseMs ?? 2 * 60_000);
  if (!ev) return "idle";
  return deliverEvent(inbox, ev, cfg, opts);
}

export async function deliverEvent(
  inbox: Inbox,
  ev: QueuedEvent,
  cfg: WebhookConfig,
  opts: { fetch?: FetchLike; now?: () => number; log?: (msg: string) => void } = {},
): Promise<DeliveryOutcome> {
  const now = opts.now ?? Date.now;
  try {
    await postWebhook(cfg, ev.payload, opts.fetch);
    inbox.ack([], [ev.eventId]);
    return "delivered";
  } catch (err) {
    const reason = (err as Error).message;
    if (isPermanent(err)) {
      opts.log?.(`webhook rejected ${ev.eventId}; giving up: ${reason}`);
      inbox.dead(ev.eventId, reason);
      return "dead";
    }
    const delay = retryBackoffMs(ev.attempts, err);
    opts.log?.(`webhook delivery of ${ev.eventId} failed (attempt ${ev.attempts}); retry in ${delay / 1000}s: ${reason}`);
    inbox.retry(ev.eventId, reason, now() + delay);
    return "retry";
  }
}
