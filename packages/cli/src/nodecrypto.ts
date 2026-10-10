import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import type { MediaCrypto } from "@wx-bot/core";

/** Native AES/MD5 for the CLI (the portable TS versions work too, just slower). */
export const nodeCrypto: MediaCrypto = {
  encryptAesEcb(data, key) {
    const c = createCipheriv("aes-128-ecb", key, null);
    return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
  },
  decryptAesEcb(data, key) {
    if (data.length % 16 !== 0) throw new Error(`ciphertext length ${data.length} not a multiple of block size`);
    const d = createDecipheriv("aes-128-ecb", key, null);
    return new Uint8Array(Buffer.concat([d.update(data), d.final()]));
  },
  md5Hex: (data) => createHash("md5").update(data).digest("hex"),
};
