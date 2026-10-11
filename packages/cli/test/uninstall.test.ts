import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDirs, ownedDir } from "../src/cmd/uninstall.ts";

test("only wx-bot's own directories are removed whole", () => {
  expect(ownedDir("/home/m/.config/wx-bot", "/home/m")).toBe(true);
  expect(ownedDir("/home/m/.local/state/wx-bot/media", "/home/m")).toBe(true);
  expect(ownedDir("/home/m", "/home/m")).toBe(false);
  expect(ownedDir("/", "/home/m")).toBe(false);
  expect(ownedDir("/data/bot-state", "/home/m")).toBe(false);
});

test("data dirs come from the config without resolving env: values", () => {
  const d = mkdtempSync(join(tmpdir(), "wxun-"));
  const cfg = join(d, "config.json");
  writeFileSync(cfg, JSON.stringify({ state_dir: "/srv/wx-bot", bindings: [{ name: "x", webhook: { key: "env:UNSET_KEY" } }] }));
  expect(dataDirs(cfg)).toEqual({ state: "/srv/wx-bot", media: "/srv/wx-bot/media" });
  mkdirSync(join(d, "x"));
  writeFileSync(cfg, JSON.stringify({ state_dir: "env:STATE", media_dir: "/m" }));
  expect(dataDirs(cfg).media).toBe("/m");
  expect(dataDirs(join(d, "missing.json")).state).toContain(join(".local", "state", "wx-bot"));
});
