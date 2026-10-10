// The wx-bot HTTP API as a fetch-style handler (Request -> Response).
// Served on loopback by the CLI and behind auth by the Cloudflare Worker.

import { errorStatus, WxBotError } from "./errors.ts";
import { PULL_LIMITS, pullResponseBody, pullScope, type Inbox, type QueuedEvent } from "./inbox.ts";
import { validateSend, type MediaKind, type OutgoingMedia, type SendRequest } from "./send.ts";
import { MAX_MEDIA_BYTES } from "./types.ts";

export interface ApiOptions {
  /** When non-empty, /v1/* requires Authorization: Bearer <token>. */
  token?: string;
  send(req: SendRequest): Promise<void>;
  status(): unknown | Promise<unknown>;
  inbox?: Inbox;
  pullBindings?: string[];
  /** Resolve a path given in a JSON /v1/send body. Omit where there is no filesystem. */
  readLocalFile?(path: string): Promise<{ data: Uint8Array; fileName: string }>;
}

const MAX_FORM_FIELD = 64 * 1024;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + "\n", { status, headers: { "Content-Type": "application/json" } });
}

function fail(err: unknown): Response {
  return json(errorStatus(err), { error: (err as Error).message });
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function parseDurationMs(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(v.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
}

function durationParam(v: string | null, name: string, def: number, min: number, max: number): number {
  if (!v) return def;
  const d = parseDurationMs(v);
  if (!(d >= min && d <= max)) {
    throw new WxBotError("bad_request", `${name} must be a duration between ${min / 1000}s and ${max / 1000}s`);
  }
  return d;
}

/** Claim, waiting up to waitMs for events (in-process adds wake it at once; others are seen within 500ms). */
export async function claimWait(
  inbox: Inbox,
  bindings: string[],
  limit: number,
  leaseMs: number,
  waitMs: number,
  signal?: AbortSignal,
): Promise<QueuedEvent[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const events = inbox.claim(bindings, limit, leaseMs);
    if (events.length > 0 || Date.now() >= deadline || signal?.aborted) return events;
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, Math.min(500, Math.max(0, deadline - Date.now())));
      const off = inbox.onAdd(done);
      signal?.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(t);
        off();
        signal?.removeEventListener("abort", done);
        resolve();
      }
    });
  }
}

export function createApiHandler(o: ApiOptions): (req: Request) => Promise<Response> {
  const authorized = (req: Request) => !o.token || safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${o.token}`);

  return async (req) => {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (url.pathname === "/healthz") {
        if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
        return new Response("ok\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      if (!["/v1/send", "/v1/status", "/v1/events", "/v1/events/ack"].includes(url.pathname)) {
        return new Response("404 page not found\n", { status: 404 });
      }
      const expected: Record<string, string> = {
        "/v1/send": "POST",
        "/v1/status": "GET",
        "/v1/events": "GET",
        "/v1/events/ack": "POST",
      };
      if (req.method !== expected[url.pathname]) return new Response("method not allowed\n", { status: 405 });
      if (!authorized(req)) return json(401, { error: "unauthorized" });

      switch (route) {
        case "POST /v1/send":
          await o.send(await parseSend(req, o));
          return json(200, { ok: true });
        case "GET /v1/status":
          return json(200, { bindings: await o.status() });
        case "GET /v1/events": {
          if (!o.inbox) return json(500, { error: "inbox not configured" });
          let bindings: string[];
          try {
            bindings = pullScope(o.pullBindings ?? [], url.searchParams.get("binding") ?? "");
          } catch (err) {
            throw new WxBotError("not_found", (err as Error).message);
          }
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw ? Number(limitRaw) : PULL_LIMITS.defaultLimit;
          if (!Number.isInteger(limit) || limit < 1 || limit > PULL_LIMITS.maxLimit) {
            throw new WxBotError("bad_request", `limit must be 1..${PULL_LIMITS.maxLimit}`);
          }
          const lease = durationParam(url.searchParams.get("lease"), "lease", PULL_LIMITS.defaultLeaseMs, 1000, PULL_LIMITS.maxLeaseMs);
          const wait = durationParam(url.searchParams.get("wait"), "wait", 0, 0, PULL_LIMITS.maxWaitMs);
          const events = await claimWait(o.inbox, bindings, limit, lease, wait, req.signal);
          return new Response(pullResponseBody(events) + "\n", { headers: { "Content-Type": "application/json" } });
        }
        case "POST /v1/events/ack": {
          if (!o.inbox) return json(500, { error: "inbox not configured" });
          let body: { event_ids?: unknown };
          try {
            body = (await req.json()) as { event_ids?: unknown };
          } catch (err) {
            throw new WxBotError("bad_request", `invalid json: ${(err as Error).message}`);
          }
          const ids = Array.isArray(body.event_ids) ? body.event_ids.filter((x): x is string => typeof x === "string") : [];
          if (ids.length === 0) throw new WxBotError("bad_request", "event_ids is required");
          if (!o.pullBindings?.length) throw new WxBotError("not_found", "no binding uses pull delivery");
          return json(200, { acked: o.inbox.ack(o.pullBindings, ids) });
        }
      }
      return new Response("404 page not found\n", { status: 404 });
    } catch (err) {
      return fail(err);
    }
  };
}

async function parseSend(req: Request, o: ApiOptions): Promise<SendRequest> {
  const ctype = req.headers.get("Content-Type") ?? "";
  if (ctype.toLowerCase().startsWith("multipart/form-data")) return parseMultipart(req);

  let b: { binding?: string; to?: string; text?: string; image?: string; file?: string; video?: string; caption?: string };
  try {
    b = (await req.json()) as typeof b;
  } catch (err) {
    throw new WxBotError("bad_request", `invalid json: ${(err as Error).message}`);
  }
  validateSend(b);
  const out: SendRequest = { binding: b.binding!, to: b.to!, caption: b.caption || undefined };
  if (b.text) {
    out.text = b.text;
    return out;
  }
  const kind: MediaKind = b.image ? "image" : b.video ? "video" : "file";
  const path = (b.image || b.video || b.file)!;
  if (!o.readLocalFile) throw new WxBotError("bad_request", `${kind} paths are not supported here; upload the file as multipart/form-data`);
  const f = await o.readLocalFile(path);
  out.media = { kind, data: f.data, fileName: f.fileName };
  return out;
}

async function parseMultipart(req: Request): Promise<SendRequest> {
  const len = Number(req.headers.get("Content-Length") ?? "0");
  if (len > MAX_MEDIA_BYTES + 1024 * 1024) throw new WxBotError("too_large", "upload too large (>100 MB)");
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    throw new WxBotError("bad_request", `invalid multipart: ${(err as Error).message}`);
  }
  const field = (name: string) => {
    const v = form.get(name);
    if (v === null) return undefined;
    if (typeof v !== "string") throw new WxBotError("bad_request", `${name} must be a text field`);
    if (v.length > MAX_FORM_FIELD) throw new WxBotError("too_large", `field ${name} too large`);
    return v;
  };
  let media: OutgoingMedia | undefined;
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") continue;
    if (name !== "image" && name !== "file" && name !== "video") {
      throw new WxBotError("bad_request", `file part must be named image, file or video, got "${name}"`);
    }
    if (media) throw new WxBotError("bad_request", "only one file part is allowed");
    if (value.size > MAX_MEDIA_BYTES) throw new WxBotError("too_large", "upload too large (>100 MB)");
    media = { kind: name, data: new Uint8Array(await value.arrayBuffer()), fileName: value.name || "attachment" };
  }
  const text = field("text");
  const s: SendRequest = { binding: field("binding") ?? "", to: field("to") ?? "", caption: field("caption") || undefined };
  validateSend({ binding: s.binding, to: s.to, text, [media?.kind ?? "none"]: media ? 1 : undefined });
  if (text) s.text = text;
  else s.media = media;
  return s;
}
