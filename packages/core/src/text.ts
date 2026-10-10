import { ItemType, MAX_TEXT_RUNES } from "./types.ts";

/** Split text into chunks of at most maxRunes code points, in order. */
export function splitText(text: string, maxRunes = MAX_TEXT_RUNES): string[] {
  const runes = Array.from(text);
  if (maxRunes <= 0) maxRunes = MAX_TEXT_RUNES;
  if (runes.length <= maxRunes) return [text];
  const out: string[] = [];
  for (let i = 0; i < runes.length; i += maxRunes) out.push(runes.slice(i, i + maxRunes).join(""));
  return out;
}

/** Last path segment ("/" or "\\" separated). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "attachment";
}

/** Keep [A-Za-z0-9._-], replace everything else with '_'. */
export function sanitizeFilename(name: string): string {
  const parts = name.trim().split(/[\\/]/);
  const base = parts[parts.length - 1] ?? "";
  if (base === "" || base === "." || base === "..") return "attachment";
  let out = "";
  for (const ch of base) out += /[A-Za-z0-9._-]/.test(ch) ? ch : "_";
  return out === "" || out === "." ? "attachment" : out;
}

export function defaultMediaName(itemType: number, fileName?: string): string {
  if (fileName) return fileName;
  switch (itemType) {
    case ItemType.Image:
      return "image.jpg";
    case ItemType.Voice:
      return "voice.ogg";
    case ItemType.Video:
      return "video.mp4";
    default:
      return "attachment";
  }
}

export function mediaTypeName(itemType: number): "image" | "voice" | "file" | "video" {
  switch (itemType) {
    case ItemType.Image:
      return "image";
    case ItemType.Voice:
      return "voice";
    case ItemType.Video:
      return "video";
    default:
      return "file";
  }
}

/** Item type to send a file as, from its extension. */
export function itemTypeFromName(name: string): number {
  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return ItemType.Image;
  if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) return ItemType.Video;
  return ItemType.File;
}
