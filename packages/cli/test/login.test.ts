import { expect, test } from "bun:test";
import { qrPngPath } from "../src/cmd/login.ts";

test("qrPngPath numbers each QR", () => {
  expect(qrPngPath("/home/m/wx-bot-qr.png", 1)).toBe("/home/m/wx-bot-qr-1.png");
  expect(qrPngPath("/home/m/qr", 2)).toBe("/home/m/qr-2.png");
  expect(qrPngPath("qr.v1.png", 3)).toBe("qr.v1-3.png");
});
