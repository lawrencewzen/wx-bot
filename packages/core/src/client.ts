import { aesEcbPaddedSize, bytes, parseAesKey, portableCrypto, randomBytes, toBase64, toHex, type MediaCrypto } from "./crypto.ts";
import { WxBotError } from "./errors.ts";
import { appHeaders } from "./headers.ts";
import { parseIlinkJson } from "./json.ts";
import { baseName, splitText } from "./text.ts";
import {
  BASE_INFO,
  DEFAULT_CDN_BASE,
  ERR_CODE_EXPIRED,
  ItemType,
  MAX_MEDIA_BYTES,
  MAX_TEXT_RUNES,
  UploadMediaType,
  type CDNMedia,
  type GetUpdatesResponse,
  type GetUploadUrlResponse,
  type MessageItem,
  type Session,
} from "./types.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  fetch?: FetchLike;
  crypto?: MediaCrypto;
  cdnBase?: string;
  /** Per-request timeout for ordinary API calls (default 15s). */
  timeoutMs?: number;
  /** Backoff between CDN download retries (default 1s, then 3s). */
  downloadRetryDelaysMs?: number[];
  /**
   * Extra wait past the getupdates hold before giving up (default 10s).
   * The server may answer right as the hold ends; this keeps that response.
   */
  pollSlackMs?: number;
}

export interface MediaToSend {
  data: Uint8Array;
  /** Display name for files; also picks the type when itemType is omitted. */
  fileName: string;
  itemType: number;
  caption?: string;
}

const UPLOAD_TIMEOUT_MS = 5 * 60_000;
/** One CDN download attempt; 5 minutes usually means a stuck connection. */
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 90_000;
const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 3_000];
/** Added to the getupdates hold. Matches the official plugin's client-side margin. */
export const POLL_TIMEOUT_SLACK_MS = 10_000;
/**
 * After abort(), how long fetch or the body read may take to reject.
 * Bun can leave both pending on a half-open socket; past this the caller moves on.
 */
const ABORT_SETTLE_MS = 500;
/** setTimeout coerces larger delays to 1ms, which would abort a healthy long-poll immediately. */
const MAX_TIMER_MS = 2_147_483_647;

/** Talks to the iLink bot API for one logged-in binding. */
export class IlinkClient {
  readonly baseUrl: string;
  readonly botId: string;
  private readonly token: string;
  private readonly fetch: FetchLike;
  private readonly crypto: MediaCrypto;
  private readonly cdnBase: string;
  private readonly timeoutMs: number;
  private readonly pollSlackMs: number;
  private readonly downloadRetryDelaysMs: number[];
  /** Latest context_token per wxid; required to reply. */
  readonly contextTokens = new Map<string, string>();

  constructor(session: Session, opts: ClientOptions = {}) {
    this.baseUrl = session.base_url.replace(/\/+$/, "");
    this.token = session.bot_token;
    this.botId = session.ilink_bot_id;
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
    this.crypto = opts.crypto ?? portableCrypto;
    this.cdnBase = (opts.cdnBase ?? DEFAULT_CDN_BASE).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.pollSlackMs = nonNegative(opts.pollSlackMs, POLL_TIMEOUT_SLACK_MS);
    this.downloadRetryDelaysMs = opts.downloadRetryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS;
  }

  loadTokens(tokens: Record<string, string>): void {
    for (const [wxid, tok] of Object.entries(tokens)) if (wxid && tok) this.contextTokens.set(wxid, tok);
  }

  tokens(): Record<string, string> {
    return Object.fromEntries(this.contextTokens);
  }

  /**
   * One getupdates long-poll. A client-side timeout (server held the request
   * past timeoutMs + pollSlackMs) returns an empty response, like the official
   * plugin. The deadline does not depend on AbortSignal: Bun can leave fetch()
   * or resp.text() pending on a half-open socket after abort, and awaiting that
   * forever stalls the poller with no error. A caller abort settles immediately.
   */
  async getUpdates(cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    if (signal?.aborted) throw abortError(signal.reason);

    const ctl = new AbortController();
    const hold = nonNegative(timeoutMs, 0);
    const budget = Math.min(hold + this.pollSlackMs, MAX_TIMER_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timedOut = false;
    let resp: Response | undefined;

    let rejectGate: (err: unknown) => void = () => {};
    const gate = new Promise<never>((_, reject) => {
      rejectGate = reject;
    });
    const onAbort = () => {
      const err = abortError(signal?.reason);
      ctl.abort(err);
      rejectGate(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort(new Error("poll timeout"));
      grace = setTimeout(() => {
        if (!settled) rejectGate(new Error(`getupdates hung after ${budget}ms; abort did not settle the request`));
      }, ABORT_SETTLE_MS);
    }, budget);

    const work = (async () => {
      const r = await this.fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...appHeaders(this.token) },
        body: JSON.stringify({ get_updates_buf: cursor, base_info: BASE_INFO }),
        signal: ctl.signal,
      });
      resp = r;
      if (r.status !== 200) {
        await r.body?.cancel().catch(() => {});
        throw new Error(`getupdates: status ${r.status}`);
      }
      return parseIlinkJson<GetUpdatesResponse>(await r.text());
    })();
    const guarded = work.then(
      (value) => {
        settled = true;
        return value;
      },
      (err) => {
        settled = true;
        throw err;
      },
    );
    // A read abandoned after the deadline can reject later. That must not be unhandled.
    void guarded.catch(() => {});

    try {
      return await Promise.race([guarded, gate]);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timedOut && !settled) throw err;
      if (timedOut || ctl.signal.aborted) return {};
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
      if (!settled) cancelBody(resp);
    }
  }

  /** Send text, split into MAX_TEXT_RUNES chunks. */
  async sendText(wxid: string, text: string): Promise<void> {
    for (const chunk of splitText(text, MAX_TEXT_RUNES)) {
      await this.sendItem(wxid, { type: ItemType.Text, text_item: { text: chunk } });
    }
  }

  /** Upload and send an image, video or file. A caption goes first as text. */
  async sendMedia(wxid: string, m: MediaToSend): Promise<void> {
    if (m.data.length > MAX_MEDIA_BYTES) throw new WxBotError("too_large", "file too large (>100 MB)");
    const up = await this.uploadMedia(wxid, m.data, m.itemType);
    const media: CDNMedia = {
      encrypt_query_param: up.downloadParam,
      // Matches the official plugin: base64 of the 32-char hex key string.
      aes_key: toBase64(new TextEncoder().encode(up.aesKeyHex)),
      encrypt_type: 1,
    };
    let item: MessageItem;
    if (m.itemType === ItemType.Image) {
      item = { type: ItemType.Image, image_item: { media, mid_size: up.cipherSize } };
    } else if (m.itemType === ItemType.Video) {
      item = { type: ItemType.Video, video_item: { media, video_size: up.cipherSize } };
    } else {
      item = {
        type: ItemType.File,
        file_item: { media, file_name: baseName(m.fileName), len: String(m.data.length) },
      };
    }
    if (m.caption) await this.sendItem(wxid, { type: ItemType.Text, text_item: { text: m.caption } });
    await this.sendItem(wxid, item);
  }

  /** Download and decrypt one CDN media item. */
  async downloadMedia(media: CDNMedia, aesKeyOverride?: Uint8Array): Promise<Uint8Array> {
    const key = aesKeyOverride && aesKeyOverride.length > 0 ? aesKeyOverride : parseAesKey(media.aes_key ?? "");
    let url: string;
    if (media.full_url) url = media.full_url;
    else if (media.encrypt_query_param)
      url = `${this.cdnBase}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    else throw new Error("CDNMedia has neither full_url nor encrypt_query_param");

    let lastErr: Error = new Error("cdn download failed");
    let attempts = 0;
    for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      let resp: Response;
      try {
        resp = await this.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_ATTEMPT_TIMEOUT_MS) });
      } catch (err) {
        lastErr = err as Error;
        if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
          await sleep(this.downloadRetryDelaysMs[attempt - 1] ?? 0);
          continue;
        }
        break;
      }

      if (resp.status !== 200) {
        lastErr = new Error(`cdn download: status ${resp.status}`);
        await resp.body?.cancel();
        if (retryableDownloadStatus(resp.status) && attempt < DOWNLOAD_MAX_ATTEMPTS) {
          await sleep(this.downloadRetryDelaysMs[attempt - 1] ?? 0);
          continue;
        }
        break;
      }

      const len = Number(resp.headers.get("content-length") ?? "0");
      if (len > MAX_MEDIA_BYTES) {
        await resp.body?.cancel();
        throw withAttemptCount(new WxBotError("too_large", "media too large (>100 MB)"), attempt);
      }
      let encrypted: Uint8Array;
      try {
        encrypted = new Uint8Array(await resp.arrayBuffer());
      } catch (err) {
        lastErr = err as Error;
        if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
          await sleep(this.downloadRetryDelaysMs[attempt - 1] ?? 0);
          continue;
        }
        break;
      }
      if (encrypted.length > MAX_MEDIA_BYTES) {
        throw withAttemptCount(new WxBotError("too_large", "media too large (>100 MB)"), attempt);
      }
      // Decrypt after a successful download; do not retry crypto failures.
      return this.crypto.decryptAesEcb(encrypted, key);
    }
    throw withAttemptCount(lastErr, attempts);
  }

  private async sendItem(wxid: string, item: MessageItem): Promise<void> {
    await this.post("/ilink/bot/sendmessage", {
      msg: {
        from_user_id: this.botId,
        to_user_id: wxid,
        client_id: `wxbot-${toHex(randomBytes(8))}`,
        message_type: 2,
        message_state: 2,
        context_token: this.contextTokens.get(wxid) ?? "",
        item_list: [item],
      },
      base_info: BASE_INFO,
    });
  }

  private async uploadMedia(wxid: string, data: Uint8Array, itemType: number) {
    const aesKey = randomBytes(16);
    const filekey = toHex(randomBytes(16));
    const aesKeyHex = toHex(aesKey);
    const encrypted = await this.crypto.encryptAesEcb(data, aesKey);
    const cipherSize = aesEcbPaddedSize(data.length);
    const resp = await this.post<GetUploadUrlResponse>("/ilink/bot/getuploadurl", {
      filekey,
      media_type: uploadMediaType(itemType),
      to_user_id: wxid,
      rawsize: data.length,
      rawfilemd5: await this.crypto.md5Hex(data),
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: BASE_INFO,
    });
    if (resp.ret) throw new WxBotError("upstream", `get upload url: ret=${resp.ret} ${resp.errmsg ?? ""}`.trim());
    let uploadUrl = (resp.upload_full_url ?? "").trim();
    if (!uploadUrl) {
      if (!resp.upload_param) {
        throw new WxBotError("upstream", "get upload url: response has neither upload_full_url nor upload_param");
      }
      uploadUrl =
        `${this.cdnBase}/upload?encrypted_query_param=${encodeURIComponent(resp.upload_param)}` +
        `&filekey=${encodeURIComponent(filekey)}`;
    }
    const downloadParam = await this.uploadBytes(uploadUrl, encrypted);
    return { downloadParam, aesKeyHex, cipherSize };
  }

  /** POST ciphertext to the CDN; returns the x-encrypted-param download param. */
  private async uploadBytes(url: string, data: Uint8Array): Promise<string> {
    let lastErr: Error = new Error("cdn upload failed");
    for (let attempt = 1; attempt <= 3; attempt++) {
      let resp: Response;
      try {
        resp = await this.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes(data),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        lastErr = err as Error;
        continue;
      }
      await resp.body?.cancel();
      const msg = resp.headers.get("x-error-message") ?? "";
      if (resp.status >= 400 && resp.status < 500) {
        throw new WxBotError("upstream", `cdn client error ${resp.status}: ${msg}`);
      }
      if (resp.status !== 200) {
        lastErr = new Error(`cdn server error ${resp.status}: ${msg}`);
        continue;
      }
      const dl = resp.headers.get("x-encrypted-param");
      if (!dl) {
        lastErr = new Error("cdn response missing x-encrypted-param header");
        continue;
      }
      return dl;
    }
    throw new WxBotError("upstream", `upload to cdn: ${lastErr.message}`, { cause: lastErr });
  }

  private async post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    let resp: Response;
    try {
      resp = await this.fetch(this.baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...appHeaders(this.token) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new WxBotError("upstream", `ilink request ${path}: ${(err as Error).message}`, { cause: err });
    }
    if (resp.status !== 200) throw new WxBotError("upstream", `ilink request ${path}: status ${resp.status}`);
    const raw = await resp.text();
    if (!raw) return {} as T;
    let parsed: Record<string, unknown>;
    try {
      parsed = parseIlinkJson<Record<string, unknown>>(raw);
    } catch (err) {
      throw new WxBotError("upstream", `decode response ${path}: ${(err as Error).message}`);
    }
    const ret = Number(parsed.ret ?? 0);
    const errcode = Number(parsed.errcode ?? 0);
    if (ret === ERR_CODE_EXPIRED || errcode === ERR_CODE_EXPIRED) {
      throw new WxBotError("expired", `${path}: ilink session expired (errcode -14)`);
    }
    if (path === "/ilink/bot/sendmessage" && ret !== 0) throw new WxBotError("upstream", `${path}: ret=${ret}`);
    return parsed as T;
  }
}

function uploadMediaType(itemType: number): number {
  switch (itemType) {
    case ItemType.Image:
      return UploadMediaType.Image;
    case ItemType.Video:
      return UploadMediaType.Video;
    case ItemType.Voice:
      return UploadMediaType.Voice;
    default:
      return UploadMediaType.File;
  }
}

/** 5xx, 408, and 429 are retried; other 4xx and too_large are not. */
function retryableDownloadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function withAttemptCount(err: Error, attempts: number): Error {
  const suffix = ` (${attempts} attempt${attempts === 1 ? "" : "s"})`;
  if (err instanceof WxBotError) return new WxBotError(err.kind, err.message + suffix, { cause: err });
  return new Error(`${err.message}${suffix}`, { cause: err });
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function nonNegative(ms: number | undefined, fallback: number): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason) return new Error(reason);
  return new Error("aborted");
}

function cancelBody(resp: Response | undefined): void {
  try {
    const pending = resp?.body?.cancel();
    if (pending) void pending.catch(() => {});
  } catch {
    // The body may already be closed. Cleanup must not hide the poll error.
  }
}
