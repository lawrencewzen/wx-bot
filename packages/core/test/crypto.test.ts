import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import {
  aesEcbPaddedSize,
  decryptAes128Ecb,
  encryptAes128Ecb,
  fromHex,
  md5Hex,
  parseAesKey,
  toBase64,
  toHex,
} from "../src/crypto.ts";

const nodeEcb = (data: Uint8Array, key: Uint8Array) => {
  const c = createCipheriv("aes-128-ecb", key, null);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
};

describe("AES-128-ECB", () => {
  test("FIPS-197 appendix C.1 vector", () => {
    const key = fromHex("000102030405060708090a0b0c0d0e0f");
    const pt = fromHex("00112233445566778899aabbccddeeff");
    const ct = encryptAes128Ecb(pt, key);
    expect(toHex(ct.subarray(0, 16))).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");
    expect(toHex(decryptAes128Ecb(ct, key))).toBe(toHex(pt));
  });

  test("matches node:crypto for many sizes and keys", () => {
    for (let n = 0; n < 200; n += 7) {
      const key = crypto.getRandomValues(new Uint8Array(16));
      const data = crypto.getRandomValues(new Uint8Array(n));
      const ours = encryptAes128Ecb(data, key);
      expect(toHex(ours)).toBe(toHex(nodeEcb(data, key)));
      expect(ours.length).toBe(aesEcbPaddedSize(n));
      expect(toHex(decryptAes128Ecb(ours, key))).toBe(toHex(data));
    }
  });

  test("rejects bad key, length and padding", () => {
    expect(() => encryptAes128Ecb(new Uint8Array(1), new Uint8Array(15))).toThrow("16 bytes");
    expect(() => decryptAes128Ecb(new Uint8Array(15), new Uint8Array(16))).toThrow("multiple");
    const key = new Uint8Array(16);
    const bad = nodeEcb(new Uint8Array(16), key).subarray(0, 16); // last block has no padding block
    expect(() => decryptAes128Ecb(bad, key)).toThrow("padding");
  });
});

describe("MD5", () => {
  test("matches node:crypto", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const data = crypto.getRandomValues(new Uint8Array(n));
      expect(md5Hex(data)).toBe(createHash("md5").update(data).digest("hex"));
    }
    expect(md5Hex(new TextEncoder().encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
});

describe("parseAesKey", () => {
  const raw = fromHex("00112233445566778899aabbccddeeff");
  const hex = toHex(raw);
  test.each([
    ["hex32", hex],
    ["base64(raw)", toBase64(raw)],
    ["base64(hex)", toBase64(new TextEncoder().encode(hex))],
    ["base64(raw) unpadded", toBase64(raw).replace(/=+$/, "")],
  ])("%s", (_, input) => {
    expect(toHex(parseAesKey(input))).toBe(hex);
  });
  test("raw 16-char string", () => {
    expect(parseAesKey("0123456789abcdef")).toEqual(new TextEncoder().encode("0123456789abcdef"));
  });
});
