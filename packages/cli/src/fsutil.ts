import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function mkdir0700(path: string): void {
  if (!path || path === ".") return;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Write via temp file + rename, mode 0600. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdir0700(dir);
  const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
