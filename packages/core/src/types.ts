// iLink bot protocol types. Field names match the wire JSON.

export const ItemType = {
  Text: 1,
  Image: 2,
  Voice: 3,
  File: 4,
  Video: 5,
} as const;
export type ItemTypeValue = (typeof ItemType)[keyof typeof ItemType];

/** getuploadurl media_type. Not the same numbers as ItemType. */
export const UploadMediaType = {
  Image: 1,
  Video: 2,
  File: 3,
  Voice: 4,
} as const;

/** Mirrors the official @tencent-weixin/openclaw-weixin release we track. */
export const CHANNEL_VERSION = "2.4.10";
export const ILINK_APP_ID = "bot";
/** ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (10 & 0xff) */
export const ILINK_CLIENT_VERSION = 132106;
/** base_info.bot_agent; the official plugin's default when the app declares none. */
export const BOT_AGENT = "OpenClaw";
/** base_info sent with every authenticated API request. */
export const BASE_INFO = { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } as const;
/** WeChat text limit per message, counted in code points. */
export const MAX_TEXT_RUNES = 2000;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/** iLink session expired. */
export const ERR_CODE_EXPIRED = -14;

export const DEFAULT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
export const DEFAULT_AUTH_BASE = "https://ilinkai.weixin.qq.com";

export interface CDNMedia {
  encrypt_query_param?: string;
  /**
   * Outbound: base64 of the 32-char hex key. Inbound: raw 16 bytes, hex32,
   * base64(raw) or base64(hex) — see parseAesKey.
   */
  aes_key?: string;
  /** 1 = AES-128-ECB */
  encrypt_type?: number;
  /** Complete download URL; preferred when set. */
  full_url?: string;
}

export interface TextItem {
  text: string;
}

export interface ImageItem {
  media: CDNMedia;
  thumb_media?: CDNMedia;
  /** Raw AES-128 key as 32 hex chars; preferred over media.aes_key. */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media: CDNMedia;
  sample_rate?: number;
  playtime?: number;
  /** Transcription from WeChat. */
  text?: string;
}

export interface FileItem {
  media: CDNMedia;
  file_name?: string;
  md5?: string;
  /** Size in bytes, as a string. */
  len?: string;
}

export interface VideoItem {
  media: CDNMedia;
  thumb_media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
}

export interface MessageItem {
  type: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

export interface IncomingMessage {
  seq?: number;
  /** int64 on the wire; kept as a decimal string to avoid precision loss. */
  message_id: string;
  from_user_id: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  context_token?: string;
  item_list?: MessageItem[];
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  msgs?: IncomingMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface OutgoingMessage {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  /** 2 = BOT */
  message_type: number;
  /** 2 = FINISH */
  message_state: number;
  context_token: string;
  item_list: MessageItem[];
}

export interface GetUploadUrlResponse {
  ret?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

/** Credentials returned by a confirmed QR login. */
export interface Session {
  bot_token: string;
  base_url: string;
  ilink_bot_id: string;
  ilink_user_id: string;
}
