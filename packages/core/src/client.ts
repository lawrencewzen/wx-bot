import { aesEcbPaddedSize, bytes, parseAesKey, portableCrypto, randomBytes, toBase64, toHex, type MediaCrypto } from "./crypto.ts";
import { WxBotError } from "./errors.ts";
import { appHeaders } from "./headers.ts";
import { parseIlinkJson } from "./json.ts";
import { baseName, splitText } from "./text.ts";
import {
  CHANNEL_VERSION,
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
}

export interface MediaToSend {
  data: Uint8Array;
  /** Display name for files; also picks the type when itemType is omitted. */
  fileName: string;
  itemType: number;
  caption?: string;
}

const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Talks to the iLink bot API for one logged-in binding. */
export class IlinkClient {
  readonly baseUrl: string;
  readonly botId: string;
  private readonly token: string;
  private readonly fetch: FetchLike;
  private readonly crypto: MediaCrypto;
  private readonly cdnBase: string;
  private readonly timeoutMs: number;
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
  }

  loadTokens(tokens: Record<string, string>): void {
    for (const [wxid, tok] of Object.entries(tokens)) if (wxid && tok) this.contextTokens.set(wxid, tok);
  }

  tokens(): Record<string, string> {
    return Object.fromEntries(this.contextTokens);
  }

  /**
   * One getupdates long-poll. A client-side timeout (server held the request
   * past timeoutMs + 10s) returns an empty response, like the official plugin.
   */
  async getUpdates(cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("poll timeout")), timeoutMs + 10_000);
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const resp = await this.fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...appHeaders(this.token) },
        body: JSON.stringify({ get_updates_buf: cursor, base_info: { channel_version: CHANNEL_VERSION } }),
        signal: ctl.signal,
      });
      if (resp.status !== 200) throw new Error(`getupdates: status ${resp.status}`);
      return parseIlinkJson<GetUpdatesResponse>(await resp.text());
    } catch (err) {
      if (ctl.signal.aborted && !signal?.aborted) return {};
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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

    const resp = await this.fetch(url, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    if (resp.status !== 200) throw new Error(`cdn download: status ${resp.status}`);
    const len = Number(resp.headers.get("content-length") ?? "0");
    if (len > MAX_MEDIA_BYTES) throw new WxBotError("too_large", "media too large (>100 MB)");
    const encrypted = new Uint8Array(await resp.arrayBuffer());
    if (encrypted.length > MAX_MEDIA_BYTES) throw new WxBotError("too_large", "media too large (>100 MB)");
    return this.crypto.decryptAesEcb(encrypted, key);
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
      base_info: { channel_version: CHANNEL_VERSION },
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
      base_info: { channel_version: CHANNEL_VERSION },
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
