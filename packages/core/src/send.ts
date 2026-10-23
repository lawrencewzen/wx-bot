import type { IlinkClient } from "./client.ts";
import { WxBotError } from "./errors.ts";
import { itemTypeFromName } from "./text.ts";
import { ItemType, MAX_MEDIA_BYTES } from "./types.ts";

export type MediaKind = "image" | "file" | "video";

export interface OutgoingMedia {
  kind: MediaKind;
  data: Uint8Array;
  fileName: string;
  /** Absolute path when the caller had one (CLI / JSON local API). Omitted for uploads. */
  path?: string;
}

export interface SendRequest {
  binding: string;
  to: string;
  text?: string;
  media?: OutgoingMedia;
  caption?: string;
}

/** The scanned login user is the only wxid that may talk to a binding. */
export function allowlist(loginUserId: string): Set<string> {
  return new Set(loginUserId ? [loginUserId] : []);
}

/** Exactly one of text / image / file / video. */
export function validateSend(fields: { binding?: string; to?: string; text?: string; image?: unknown; file?: unknown; video?: unknown }): void {
  if (!fields.binding) throw new WxBotError("bad_request", "binding is required");
  if (!fields.to) throw new WxBotError("bad_request", "to (wxid) is required");
  const n = [fields.text, fields.image, fields.file, fields.video].filter((v) => v !== undefined && v !== "").length;
  if (n === 0) throw new WxBotError("bad_request", "one of text, image, file, video is required");
  if (n > 1) throw new WxBotError("bad_request", "text, image, file, video are mutually exclusive");
}

/** Check the allowlist and context token, then deliver. */
export async function sendMessage(client: IlinkClient, allow: Set<string>, req: SendRequest): Promise<void> {
  if (!allow.has(req.to)) {
    throw new WxBotError("forbidden", `wxid ${req.to} is not in the allowlist for binding ${req.binding}`);
  }
  if (!client.contextTokens.get(req.to)) {
    throw new WxBotError("no_context", `no context_token for ${req.to}: user must message the bot first`);
  }
  if (req.text !== undefined && req.text !== "") return client.sendText(req.to, req.text);
  if (!req.media) throw new WxBotError("bad_request", "one of text, image, file, video is required");
  if (req.media.data.length > MAX_MEDIA_BYTES) throw new WxBotError("too_large", "file too large (>100 MB)");
  const itemType =
    req.media.kind === "image" ? ItemType.Image : req.media.kind === "video" ? ItemType.Video : itemTypeFromName(req.media.fileName);
  await client.sendMedia(req.to, { data: req.media.data, fileName: req.media.fileName, itemType, caption: req.caption });
}
