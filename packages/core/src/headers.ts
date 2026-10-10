import { ILINK_APP_ID, ILINK_CLIENT_VERSION } from "./types.ts";

/** App id + client version: the only headers QR status polling sends. */
export function appIdentityHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION),
  };
}

/** Common iLink headers. Pass the bot_token for authenticated bot APIs. */
export function appHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { ...appIdentityHeaders(), "X-WECHAT-UIN": generateUin() };
  if (token) {
    h["AuthorizationType"] = "ilink_bot_token";
    h["Authorization"] = `Bearer ${token}`;
  }
  return h;
}

/** base64(decimal(random uint32)), fresh per request like the official plugin. */
export function generateUin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return btoa(String(n));
}
