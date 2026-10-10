// Media crypto for the WeChat CDN: AES-128-ECB with PKCS7 padding, plus MD5.
// WebCrypto has neither ECB nor MD5, so both are implemented here in plain TS
// and run anywhere (Workers, Bun, Node, browsers). Shells with native crypto
// can pass a faster MediaCrypto to the client.

export interface MediaCrypto {
  encryptAesEcb(data: Uint8Array, key: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decryptAesEcb(data: Uint8Array, key: Uint8Array): Uint8Array | Promise<Uint8Array>;
  md5Hex(data: Uint8Array): string | Promise<string>;
}

// ---------- AES-128 (FIPS-197), T-table implementation ----------

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const TE = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] as const;
const TD = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] as const;

(function initTables() {
  // GF(2^8) log/exp tables with generator 3.
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 256; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  const mul = (a: number, b: number) => (a && b ? exp[(log[a]! + log[b]!) % 255]! : 0);
  for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : exp[255 - log[i]!]!;
    let s = inv;
    let r = inv;
    for (let k = 0; k < 4; k++) {
      r = ((r << 1) | (r >> 7)) & 0xff;
      s ^= r;
    }
    s ^= 0x63;
    SBOX[i] = s;
    INV_SBOX[s] = i;
  }
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i]!;
    const e = (mul(s, 2) << 24) | (s << 16) | (s << 8) | mul(s, 3);
    const v = INV_SBOX[i]!;
    const d = (mul(v, 14) << 24) | (mul(v, 9) << 16) | (mul(v, 13) << 8) | mul(v, 11);
    for (let t = 0; t < 4; t++) {
      TE[t]![i] = ((e >>> (8 * t)) | (e << (32 - 8 * t))) >>> 0;
      TD[t]![i] = ((d >>> (8 * t)) | (d << (32 - 8 * t))) >>> 0;
    }
  }
})();

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function expandKey(key: Uint8Array): { enc: Uint32Array; dec: Uint32Array } {
  if (key.length !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${key.length}`);
  const enc = new Uint32Array(44);
  for (let i = 0; i < 4; i++) {
    enc[i] = ((key[4 * i]! << 24) | (key[4 * i + 1]! << 16) | (key[4 * i + 2]! << 8) | key[4 * i + 3]!) >>> 0;
  }
  for (let i = 4; i < 44; i++) {
    let t = enc[i - 1]!;
    if (i % 4 === 0) {
      t =
        ((SBOX[(t >>> 16) & 0xff]! << 24) |
          (SBOX[(t >>> 8) & 0xff]! << 16) |
          (SBOX[t & 0xff]! << 8) |
          SBOX[t >>> 24]!) ^
        (RCON[i / 4 - 1]! << 24);
    }
    enc[i] = (enc[i - 4]! ^ t) >>> 0;
  }
  // Equivalent inverse cipher key schedule.
  const dec = new Uint32Array(44);
  for (let r = 0; r <= 10; r++) {
    for (let c = 0; c < 4; c++) {
      const w = enc[(10 - r) * 4 + c]!;
      dec[r * 4 + c] =
        r === 0 || r === 10
          ? w
          : (TD[0][SBOX[w >>> 24]!]! ^
              TD[1][SBOX[(w >>> 16) & 0xff]!]! ^
              TD[2][SBOX[(w >>> 8) & 0xff]!]! ^
              TD[3][SBOX[w & 0xff]!]!) >>>
            0;
    }
  }
  return { enc, dec };
}

function cryptBlock(
  input: Uint8Array,
  inOff: number,
  out: Uint8Array,
  outOff: number,
  k: Uint32Array,
  T: readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array],
  S: Uint8Array,
  inverse: boolean,
): void {
  let s0 = ((input[inOff]! << 24) | (input[inOff + 1]! << 16) | (input[inOff + 2]! << 8) | input[inOff + 3]!) ^ k[0]!;
  let s1 = ((input[inOff + 4]! << 24) | (input[inOff + 5]! << 16) | (input[inOff + 6]! << 8) | input[inOff + 7]!) ^ k[1]!;
  let s2 = ((input[inOff + 8]! << 24) | (input[inOff + 9]! << 16) | (input[inOff + 10]! << 8) | input[inOff + 11]!) ^ k[2]!;
  let s3 = ((input[inOff + 12]! << 24) | (input[inOff + 13]! << 16) | (input[inOff + 14]! << 8) | input[inOff + 15]!) ^ k[3]!;
  const [T0, T1, T2, T3] = T;
  // Encryption reads columns (s0,s1,s2,s3) shifted left; decryption shifted right.
  const a = inverse ? 3 : 1;
  const b = 2;
  const c = inverse ? 1 : 3;
  let ki = 4;
  for (let round = 1; round < 10; round++) {
    const st = [s0, s1, s2, s3];
    const t0 = T0[st[0]! >>> 24]! ^ T1[(st[a % 4]! >>> 16) & 0xff]! ^ T2[(st[b % 4]! >>> 8) & 0xff]! ^ T3[st[c % 4]! & 0xff]! ^ k[ki]!;
    const t1 = T0[st[1]! >>> 24]! ^ T1[(st[(1 + a) % 4]! >>> 16) & 0xff]! ^ T2[(st[(1 + b) % 4]! >>> 8) & 0xff]! ^ T3[st[(1 + c) % 4]! & 0xff]! ^ k[ki + 1]!;
    const t2 = T0[st[2]! >>> 24]! ^ T1[(st[(2 + a) % 4]! >>> 16) & 0xff]! ^ T2[(st[(2 + b) % 4]! >>> 8) & 0xff]! ^ T3[st[(2 + c) % 4]! & 0xff]! ^ k[ki + 2]!;
    const t3 = T0[st[3]! >>> 24]! ^ T1[(st[(3 + a) % 4]! >>> 16) & 0xff]! ^ T2[(st[(3 + b) % 4]! >>> 8) & 0xff]! ^ T3[st[(3 + c) % 4]! & 0xff]! ^ k[ki + 3]!;
    s0 = t0;
    s1 = t1;
    s2 = t2;
    s3 = t3;
    ki += 4;
  }
  const st = [s0, s1, s2, s3];
  for (let i = 0; i < 4; i++) {
    const w =
      ((S[st[i]! >>> 24]! << 24) |
        (S[(st[(i + a) % 4]! >>> 16) & 0xff]! << 16) |
        (S[(st[(i + b) % 4]! >>> 8) & 0xff]! << 8) |
        S[st[(i + c) % 4]! & 0xff]!) ^
      k[40 + i]!;
    out[outOff + 4 * i] = w >>> 24;
    out[outOff + 4 * i + 1] = (w >>> 16) & 0xff;
    out[outOff + 4 * i + 2] = (w >>> 8) & 0xff;
    out[outOff + 4 * i + 3] = w & 0xff;
  }
}

export function pkcs7Pad(data: Uint8Array, blockSize = 16): Uint8Array {
  const pad = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

export function pkcs7Unpad(data: Uint8Array, blockSize = 16): Uint8Array {
  if (data.length === 0) throw new Error("empty data");
  const pad = data[data.length - 1]!;
  if (pad === 0 || pad > blockSize || pad > data.length) throw new Error(`invalid padding ${pad}`);
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error(`invalid padding byte at position ${i}`);
  }
  return data.subarray(0, data.length - pad);
}

/** AES-128-ECB with PKCS7 padding. */
export function encryptAes128Ecb(data: Uint8Array, key: Uint8Array): Uint8Array {
  const { enc } = expandKey(key);
  const padded = pkcs7Pad(data);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) cryptBlock(padded, i, out, i, enc, TE, SBOX, false);
  return out;
}

/** AES-128-ECB decryption with PKCS7 unpadding. */
export function decryptAes128Ecb(data: Uint8Array, key: Uint8Array): Uint8Array {
  const { dec } = expandKey(key);
  if (data.length % 16 !== 0) throw new Error(`ciphertext length ${data.length} not a multiple of block size`);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) cryptBlock(data, i, out, i, dec, TD, INV_SBOX, true);
  return pkcs7Unpad(out);
}

/** AES-128-ECB/PKCS7 ciphertext size for n plaintext bytes. */
export function aesEcbPaddedSize(n: number): number {
  return (Math.floor(n / 16) + 1) * 16;
}

// ---------- MD5 (RFC 1321) ----------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5Hex(data: Uint8Array): string {
  const bitLen = data.length * 8;
  const total = (((data.length + 8) >>> 6) + 1) * 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + 4 * i, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i]! + m[g]!) >>> 0;
      const s = MD5_S[i]!;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return toHex(out);
}

/** Pure-TS MediaCrypto; works on every runtime. */
export const portableCrypto: MediaCrypto = {
  encryptAesEcb: encryptAes128Ecb,
  decryptAesEcb: decryptAes128Ecb,
  md5Hex,
};

// ---------- encoding helpers ----------

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !isHex(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function isHex(s: string): boolean {
  return /^[0-9a-fA-F]*$/.test(s);
}

export function toBase64(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array {
  let t = s.trim();
  // Accept unpadded input, like Go's RawStdEncoding fallback.
  if (t.length % 4 !== 0) t += "=".repeat(4 - (t.length % 4));
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array as a fetch body / WebCrypto input (TS 5.9 distinguishes ArrayBuffer-backed views). */
export const bytes = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

const latin1 = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);

/**
 * Decode an AES-128 key from the formats used by the WeChat CDN:
 * raw 16-byte string, 32 hex chars, base64(16 raw bytes), base64(32 hex chars).
 */
export function parseAesKey(s: string): Uint8Array {
  if (s.length === 16) return latin1(s);
  if (s.length === 32 && isHex(s)) return fromHex(s);
  let decoded: Uint8Array;
  try {
    decoded = fromBase64(s);
  } catch (e) {
    throw new Error(`base64 decode aes_key: ${(e as Error).message}`);
  }
  if (decoded.length === 32) {
    const asText = String.fromCharCode(...decoded);
    if (isHex(asText)) return fromHex(asText);
  }
  return decoded;
}
