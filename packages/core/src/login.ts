import type { FetchLike } from "./client.ts";
import { appHeaders, appIdentityHeaders } from "./headers.ts";
import { DEFAULT_AUTH_BASE, type Session } from "./types.ts";

export const QR_MAX_EXPIRY = 3;
const QR_POLL_INTERVAL_MS = 1000;

export class QrExpiredError extends Error {
  constructor() {
    super("qr code expired");
    this.name = "QrExpiredError";
  }
}

export interface QrCode {
  /** Id used to poll the status. */
  qrcode: string;
  /** Content to render as a QR image (a URL). */
  imageContent: string;
}

/** Result of one status check; "pending" means keep polling. */
export type QrStatus =
  | { state: "pending"; host: string }
  | { state: "confirmed"; session: Session }
  | { state: "expired" };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** QR login against the iLink auth host. */
export class LoginApi {
  private readonly authBase: string;
  private readonly fetch: FetchLike;

  constructor(opts: { authBase?: string; fetch?: FetchLike } = {}) {
    this.authBase = (opts.authBase ?? DEFAULT_AUTH_BASE).replace(/\/+$/, "");
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  /** POST get_bot_qrcode: JSON headers with AuthorizationType and X-WECHAT-UIN, no Authorization. */
  async getQrCode(signal?: AbortSignal): Promise<QrCode> {
    const resp = await this.fetch(`${this.authBase}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: "POST",
      headers: {
        ...appHeaders(),
        AuthorizationType: "ilink_bot_token",
        "Content-Type": "application/json",
      },
      body: '{"local_token_list":[]}',
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (resp.status !== 200) throw new Error(`get qrcode: status ${resp.status}`);
    const r = (await resp.json()) as { ret?: number; qrcode?: string; qrcode_img_content?: string };
    if (r.ret) throw new Error(`get qrcode: ret=${r.ret}`);
    if (!r.qrcode) throw new Error("get qrcode: empty qrcode id");
    return { qrcode: r.qrcode, imageContent: r.qrcode_img_content ?? "" };
  }

  /**
   * One get_qrcode_status check against host (the auth base, or the redirect
   * host from an earlier check). Network errors count as "pending".
   */
  async checkQrStatus(qrcode: string, host = this.authBase, signal?: AbortSignal): Promise<QrStatus> {
    let r: {
      status?: string;
      bot_token?: string;
      baseurl?: string;
      ilink_bot_id?: string;
      ilink_user_id?: string;
      redirect_host?: string;
    };
    try {
      const resp = await this.fetch(
        `${host.replace(/\/+$/, "")}/ilink/bot/get_qrcode_status?${new URLSearchParams({ qrcode })}`,
        { headers: appIdentityHeaders(), signal: signal ?? AbortSignal.timeout(40_000) },
      );
      r = await resp.json();
    } catch (err) {
      if (signal?.aborted) throw err;
      return { state: "pending", host };
    }
    switch (r.status) {
      case "confirmed":
        if (!r.bot_token || !r.baseurl) throw new Error("confirmed but missing token or base_url");
        return {
          state: "confirmed",
          session: {
            bot_token: r.bot_token,
            base_url: r.baseurl.replace(/\/+$/, ""),
            ilink_bot_id: r.ilink_bot_id ?? "",
            ilink_user_id: r.ilink_user_id ?? "",
          },
        };
      case "expired":
        return { state: "expired" };
      case "scaned_but_redirect": {
        if (!r.redirect_host) throw new Error("scaned_but_redirect with empty redirect_host");
        const h = r.redirect_host;
        return { state: "pending", host: /^https?:\/\//.test(h) ? h : `https://${h}` };
      }
      default:
        return { state: "pending", host };
    }
  }

  /** Poll until confirmed, expired, or aborted. */
  async pollQrStatus(qrcode: string, signal?: AbortSignal): Promise<Session> {
    let host = this.authBase;
    for (;;) {
      const st = await this.checkQrStatus(qrcode, host, signal);
      if (st.state === "confirmed") return st.session;
      if (st.state === "expired") throw new QrExpiredError();
      host = st.host;
      await sleep(QR_POLL_INTERVAL_MS, signal);
    }
  }

  /** Full login: show a QR (attempt is 1-based), refresh up to QR_MAX_EXPIRY times. */
  async login(onQr: (qr: QrCode, attempt: number) => void | Promise<void>, signal?: AbortSignal): Promise<Session> {
    let qr = await this.getQrCode(signal);
    await onQr(qr, 1);
    for (let attempt = 1; attempt <= QR_MAX_EXPIRY; attempt++) {
      try {
        return await this.pollQrStatus(qr.qrcode, signal);
      } catch (err) {
        if (!(err instanceof QrExpiredError) || attempt === QR_MAX_EXPIRY) throw err;
        qr = await this.getQrCode(signal);
        await onQr(qr, attempt + 1);
      }
    }
    throw new QrExpiredError();
  }
}
