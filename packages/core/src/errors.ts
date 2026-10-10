/** Machine-readable failure kinds, mapped to HTTP status by the API layer. */
export type ErrorKind =
  | "bad_request" // 400
  | "unauthorized" // 401 (local API token)
  | "expired" // 401 (iLink session expired, -14)
  | "forbidden" // 403 (recipient not allowlisted)
  | "not_found" // 404 (unknown binding / not a pull binding)
  | "no_context" // 409 (user never messaged the bot)
  | "too_large" // 413
  | "upstream"; // 502 (iLink / CDN failure)

export class WxBotError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WxBotError";
  }
}

export const HTTP_STATUS: Record<ErrorKind, number> = {
  bad_request: 400,
  unauthorized: 401,
  expired: 401,
  forbidden: 403,
  not_found: 404,
  no_context: 409,
  too_large: 413,
  upstream: 502,
};

export function errorStatus(err: unknown): number {
  return err instanceof WxBotError ? HTTP_STATUS[err.kind] : 502;
}
