import type { IlinkClient } from "./client.ts";
import { fromHex, isHex } from "./crypto.ts";
import { defaultMediaName, mediaTypeName, sanitizeFilename } from "./text.ts";
import { ItemType, type CDNMedia, type IncomingMessage } from "./types.ts";

/** Inbound event format version (docs/protocol.md). */
export const EVENT_SCHEMA = "wxbot.event.v1";

export interface MediaRef {
  type: "image" | "voice" | "file" | "video";
  /** Where the shell stored it: an absolute path (CLI) or an object key (Cloudflare). */
  path: string;
  file_name: string;
  size: number;
}

/** The inbound event delivered to agents. Key order matches the Go encoder. */
export interface WxEvent {
  schema: string;
  event_id: string;
  binding: string;
  message_id: string;
  from_wxid: string;
  to_bot_id: string;
  create_time: number;
  text: string;
  voice_text?: string;
  media: MediaRef[];
  media_errors?: string[];
  has_context_token: boolean;
  reply_hint: string;
}

export interface MediaToStore {
  binding: string;
  messageId: string;
  type: MediaRef["type"];
  /** Sanitized, unique within the message. */
  fileName: string;
  createdAt: Date;
  data: Uint8Array;
}

/** Stores downloaded media and returns where it went. */
export type MediaSink = (m: MediaToStore) => Promise<{ path: string }>;

export function replyHint(binding: string, wxid: string): string {
  return `wx-bot send --binding ${binding} --to ${wxid} --text - <<'EOF'\n<reply>\nEOF`;
}

/** Build the event for one message, downloading media into sink. */
export async function buildEvent(
  binding: string,
  msg: IncomingMessage,
  client: IlinkClient,
  sink: MediaSink,
  log: (msg: string) => void = () => {},
): Promise<WxEvent> {
  const msgid = String(msg.message_id);
  const createdMs = msg.create_time_ms ?? 0;
  const created = createdMs ? new Date(createdMs) : new Date();
  const texts: string[] = [];
  let voiceText = "";
  const media: MediaRef[] = [];
  const mediaErrors: string[] = [];

  const save = async (cdn: CDNMedia, keyOverride: Uint8Array | undefined, itemType: number, index: number, name?: string) => {
    const type = mediaTypeName(itemType);
    let fileName = sanitizeFilename(defaultMediaName(itemType, name));
    if (index > 0) {
      const dot = fileName.lastIndexOf(".");
      fileName = dot > 0 ? `${fileName.slice(0, dot)}_${index}${fileName.slice(dot)}` : `${fileName}_${index}`;
    }
    try {
      const data = await client.downloadMedia(cdn, keyOverride);
      const { path } = await sink({ binding, messageId: msgid, type, fileName, createdAt: created, data });
      media.push({ type, path, file_name: fileName, size: data.length });
    } catch (err) {
      const reason = (err as Error).message;
      log(`download ${type}: ${reason}`);
      mediaErrors.push(name ? `${type} ${name}: ${reason}` : `${type}: ${reason}`);
    }
  };

  const items = msg.item_list ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    switch (item.type) {
      case ItemType.Text:
        if (item.text_item?.text) texts.push(item.text_item.text);
        break;
      case ItemType.Voice:
        if (item.voice_item) {
          if (item.voice_item.text) voiceText = item.voice_item.text;
          else await save(item.voice_item.media, undefined, item.type, i);
        }
        break;
      case ItemType.Image:
        if (item.image_item) {
          const k = item.image_item.aeskey;
          const key = k && k.length === 32 && isHex(k) ? fromHex(k) : undefined;
          await save(item.image_item.media, key, item.type, i);
        }
        break;
      case ItemType.File:
        if (item.file_item) await save(item.file_item.media, undefined, item.type, i, item.file_item.file_name);
        break;
      case ItemType.Video:
        if (item.video_item) await save(item.video_item.media, undefined, item.type, i);
        break;
    }
  }

  // Literal key order is the documented (and Go-encoded) order.
  return {
    schema: EVENT_SCHEMA,
    event_id: `${binding}:${msgid}`,
    binding,
    message_id: msgid,
    from_wxid: msg.from_user_id,
    to_bot_id: msg.to_user_id || client.botId,
    create_time: createdMs >= 1000 ? Math.floor(createdMs / 1000) : createdMs,
    text: texts.join("\n"),
    ...(voiceText ? { voice_text: voiceText } : {}),
    media,
    ...(mediaErrors.length ? { media_errors: mediaErrors } : {}),
    has_context_token: !!msg.context_token || client.contextTokens.has(msg.from_user_id),
    reply_hint: replyHint(binding, msg.from_user_id),
  };
}

/** Exact wire body: JSON plus a trailing newline (HMAC covers these bytes). */
export function encodeEvent(e: WxEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(e) + "\n");
}
