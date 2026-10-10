import { expect, test } from "bun:test";
import { formatDuration, parseDuration } from "../src/duration.ts";
import { parseFlags } from "../src/flags.ts";

test("go-style flags", () => {
  const spec = { config: { type: "string", usage: "", default: "" }, limit: { type: "int", usage: "", default: 20 }, v: { type: "bool", usage: "" } } as const;
  expect(parseFlags(["-config", "a.json", "--limit=5", "-v", "run", "-x"], spec)).toEqual({
    values: { config: "a.json", limit: 5, v: true },
    rest: ["run", "-x"],
  });
  expect(parseFlags(["--", "-config"], spec).rest).toEqual(["-config"]);
  expect(() => parseFlags(["-nope"], spec)).toThrow("not defined");
  expect(() => parseFlags(["-config"], spec)).toThrow("needs an argument");
  expect(() => parseFlags(["-limit", "x"], spec)).toThrow("invalid value");
});

test("go durations", () => {
  expect(parseDuration("5m")).toBe(300_000);
  expect(parseDuration("1h30m")).toBe(5_400_000);
  expect(parseDuration("1.5s")).toBe(1500);
  expect(parseDuration("0")).toBe(0);
  expect(parseDuration("300ms")).toBe(300);
  expect(() => parseDuration("5")).toThrow();
  expect(() => parseDuration("5x")).toThrow();
  expect(formatDuration(3_600_000)).toBe("1h0m0s");
  expect(formatDuration(60_000)).toBe("1m0s");
});
