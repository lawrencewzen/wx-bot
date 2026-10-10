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

export class WebhookStatusError extends Error {
  constructor(readonly status: number) {
    super(`webhook status ${status}`);
    this.name = "WebhookStatusError";
  }
}

/** A rejection that will not succeed on retry with the same body. */
export function isPermanent(err: unknown): boolean {
  return err instanceof WebhookStatusError && [400, 413, 422].includes(err.status);
}

/** 2s, 4s, 8s ... capped at 5 minutes. */
export function retryBackoffMs(attempt: number): number {
  let d = 2000;
  for (let i = 1; i < attempt && d < MAX_BACKOFF_MS; i++) d *= 2;
  return Math.min(d, MAX_BACKOFF_MS);
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
  await resp.body?.cancel();
  if (resp.status >= 300) throw new WebhookStatusError(resp.status);
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
    const delay = retryBackoffMs(ev.attempts);
    opts.log?.(`webhook delivery of ${ev.eventId} failed (attempt ${ev.attempts}); retry in ${delay / 1000}s: ${reason}`);
    inbox.retry(ev.eventId, reason, now() + delay);
    return "retry";
  }
}
