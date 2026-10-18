import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

import { desktopRoot } from "./test-support/paths";

const publicDir = path.join(desktopRoot, "src/renderer/web-public");

// Without `maskable`, Android drew the icons shrunk on a white disc. The icons are the full-bleed
// opaque body, and the mark stays within the central 80 % that every mask keeps.
it("offers each home-screen icon as maskable, opaque and full bleed", () => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON file read from disk.
  const manifest = JSON.parse(
    readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8"),
  ) as {
    icons: { src: string; purpose?: string }[];
  };
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    expect(icon.purpose?.split(" ")).toContain("maskable");
    expect(icon.purpose?.split(" ")).toContain("any");
    const png = readFileSync(path.join(publicDir, icon.src));
    // Colour type 2 is truecolour without alpha.
    expect(png[25]).toBe(2);
    expect(png.includes("tRNS")).toBe(false);
  }
});
