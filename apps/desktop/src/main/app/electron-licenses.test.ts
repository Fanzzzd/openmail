import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import {
  checkElectronLicenses,
  electronLicenseResources,
  missingElectronLicenses,
} from "../../../build/electron-licenses.cjs";
import { desktopRoot } from "../../renderer/src/test-support/paths";

it("copies Electron's license and Chromium's notices into Resources/licenses/electron", () => {
  expect(electronLicenseResources("/x/electron/dist")).toEqual([
    { from: "/x/electron/dist/LICENSE", to: "licenses/electron/LICENSE" },
    {
      from: "/x/electron/dist/LICENSES.chromium.html",
      to: "licenses/electron/LICENSES.chromium.html",
    },
  ]);
  const require = createRequire(import.meta.url);
  const config = Schema.decodeUnknownSync(
    Schema.Struct({ extraResources: Schema.Array(Schema.Struct({ to: Schema.String })) }),
  )(require(path.join(desktopRoot, "electron-builder.config.cjs")));
  expect(config.extraResources.map((entry) => entry.to)).toEqual(
    expect.arrayContaining([
      "licenses/electron/LICENSE",
      "licenses/electron/LICENSES.chromium.html",
    ]),
  );
});

it("names the notices a folder lacks and stops packaging without them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openmail-electron-licenses-"));
  try {
    expect(missingElectronLicenses(dir)).toEqual(["LICENSE", "LICENSES.chromium.html"]);
    expect(() => checkElectronLicenses(dir)).toThrow(/LICENSE, LICENSES\.chromium\.html/);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "LICENSE"), "MIT");
    await writeFile(path.join(dir, "LICENSES.chromium.html"), "<html></html>");
    expect(missingElectronLicenses(dir)).toEqual([]);
    expect(() => checkElectronLicenses(dir)).not.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
