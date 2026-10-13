import { expect, it } from "vitest";
import { readRasterImage } from "./compose-images.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ2kAAAAASUVORK5CYII=",
  "base64",
);
async function* pieces() {
  yield png.subarray(0, 8);
  yield png.subarray(8);
}
it("chunked image responses enforce size/type limits before keeping unbounded content", async () => {
  await expect(readRasterImage(pieces(), "image/png", png.length)).resolves.toEqual({
    mimeType: "image/png",
    content: png.toString("base64"),
  });
  await expect(readRasterImage(pieces(), "image/jpeg", png.length)).rejects.toThrow(
    "does not match",
  );
  await expect(readRasterImage(pieces(), "image/svg+xml", png.length)).rejects.toThrow(
    "invalid type",
  );
  let consumedTail = false;
  async function* oversized() {
    yield png;
    yield new Uint8Array(1);
    consumedTail = true;
    yield png;
  }
  await expect(readRasterImage(oversized(), "image/png", png.length)).rejects.toThrow("size limit");
  expect(consumedTail).toBe(false);
});
