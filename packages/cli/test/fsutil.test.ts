import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../src/fsutil.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

test("private writes lock the directory; shared writes leave it alone", () => {
  const root = mkdtempSync(join(tmpdir(), "wxfs-"));
  const shared = join(root, "workspace");
  mkdirSync(shared);
  chmodSync(shared, 0o755);
  writeAtomic(join(shared, "qr-1.png"), "png", 0o644);
  expect([mode(shared), mode(join(shared, "qr-1.png"))]).toEqual([0o755, 0o644]);

  writeAtomic(join(root, "new", "qr.png"), "png", 0o644);
  expect(mode(join(root, "new", "qr.png"))).toBe(0o644);

  const priv = join(root, "state");
  mkdirSync(priv);
  chmodSync(priv, 0o755);
  writeAtomic(join(priv, "session.json"), "{}");
  expect([mode(priv), mode(join(priv, "session.json"))]).toEqual([0o700, 0o600]);
});
