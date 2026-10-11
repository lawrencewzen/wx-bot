import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function mkdir0700(path: string): void {
  if (!path || path === ".") return;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * Write via temp file + rename. Defaults suit private state: mode 0600 in a
 * directory forced to 0700. For files meant to be shared (mode 0644) the
 * directory is created if missing but its mode is left alone.
 */
export function writeAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(path);
  if (mode === 0o600) mkdir0700(dir);
  else if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    chmodSync(path, mode);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
