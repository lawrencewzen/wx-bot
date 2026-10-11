import { expect, test } from "bun:test";
import { qrPngPath } from "../src/cmd/login.ts";

test("qrPngPath numbers each QR", () => {
  expect(qrPngPath("/home/m/wx-bot-qr.png", 1, "5bbf0bb1d2e3")).toBe("/home/m/wx-bot-qr-1-5bbf0bb1.png");
  expect(qrPngPath("/home/m/qr", 2, "ab/c")).toBe("/home/m/qr-2-abc.png");
  expect(qrPngPath("qr.v1.png", 3, "")).toBe("qr.v1-3.png");
});
