import { expect, test } from "bun:test";
import { assetName, compareSemver, keepaliveFor, parseSemver } from "../src/cmd/update.ts";

test("semver", () => {
  expect(parseSemver("v0.4.1")).toEqual([0, 4, 1]);
  expect(parseSemver("0.10.0")).toEqual([0, 10, 0]);
  expect(parseSemver("dev")).toBeUndefined();
  expect(parseSemver("v0.3.0-3-gabc")).toBeUndefined();
  expect(compareSemver([0, 10, 0], [0, 9, 9])).toBeGreaterThan(0);
  expect(compareSemver([0, 4, 0], [0, 4, 0])).toBe(0);
});

test("asset names match release files", () => {
  expect(assetName("linux", "x64", false)).toBe("wx-bot_linux_amd64");
  expect(assetName("linux", "arm64", true)).toBe("wx-bot_linux_arm64_musl");
  expect(assetName("darwin", "arm64", true)).toBe("wx-bot_darwin_arm64");
  expect(assetName("darwin", "x64", false)).toBe("wx-bot_darwin_amd64");
});

test("keepalive default binary path follows the install location", () => {
  const script = 'WXBOT="${WXBOT:-$HOME/.local/bin/wx-bot}"\n';
  expect(keepaliveFor(script, "/usr/local/bin/wx-bot")).toBe('WXBOT="${WXBOT:-/usr/local/bin/wx-bot}"\n');
});
