import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// iOS fills a touch icon's transparent pixels with black, so the padded macOS grid icon showed a
// black frame around the body. apps/desktop/build/render-icons.sh writes the full-bleed body.
test("the touch icon is a 180 px PNG without an alpha channel", () => {
  const png = readFileSync(new URL("../app/apple-icon.png", import.meta.url));
  expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  // Colour type 2 is truecolour without alpha; a tRNS chunk would add transparency back.
  expect(png[25]).toBe(2);
  expect(png.includes("tRNS")).toBe(false);
});
