import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  ELECTRON_LICENSE_SOURCE,
  checkElectronLicenses,
  electronLicenseResources,
  missingElectronLicenses,
  prepareElectronLicenses,
} from "../../../build/electron-licenses.cjs";
import { desktopRoot } from "../../renderer/src/test-support/paths";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openmail-electron-licenses-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A folder laid out like Electron's dist: the notices, a version file and Electron.app. */
async function fakeDist(version: string, notices = true) {
  const dist = path.join(dir, `dist-${version}`);
  await mkdir(path.join(dist, "Electron.app"), { recursive: true });
  await writeFile(path.join(dist, "version"), version);
  if (notices) {
    await writeFile(path.join(dist, "LICENSE"), `dist license ${version}`);
    await writeFile(path.join(dist, "LICENSES.chromium.html"), `<p>dist notices ${version}</p>`);
  }
  return dist;
}

/** A zip laid out like Electron's release zip, with an entry that must not be extracted. */
async function fakeZip(version: string) {
  const content = path.join(dir, `zip-content-${version}`);
  await mkdir(path.join(content, "Electron.app"), { recursive: true });
  await writeFile(path.join(content, "Electron.app", "binary"), "not a notice");
  await writeFile(path.join(content, "LICENSE"), `zip license ${version}`);
  await writeFile(path.join(content, "LICENSES.chromium.html"), `<p>zip notices ${version}</p>`);
  await writeFile(path.join(content, "version"), version);
  const zip = path.join(dir, `electron-v${version}-darwin-arm64.zip`);
  await promisify(execFile)("zip", ["-qr", zip, "."], { cwd: content });
  return zip;
}

const notices = async (out: string) => [
  await readFile(path.join(out, "LICENSE"), "utf8"),
  await readFile(path.join(out, "LICENSES.chromium.html"), "utf8"),
];

it("ships the prepared notices in Resources/licenses/electron", () => {
  expect(electronLicenseResources()).toEqual([
    { from: path.join(ELECTRON_LICENSE_SOURCE, "LICENSE"), to: "licenses/electron/LICENSE" },
    {
      from: path.join(ELECTRON_LICENSE_SOURCE, "LICENSES.chromium.html"),
      to: "licenses/electron/LICENSES.chromium.html",
    },
  ]);
  const require = createRequire(import.meta.url);
  const config = Schema.decodeUnknownSync(
    Schema.Struct({
      extraResources: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
    }),
  )(require(path.join(desktopRoot, "electron-builder.config.cjs")));
  expect(config.extraResources).toEqual(expect.arrayContaining(electronLicenseResources()));
});

it("names the notices a folder lacks and stops packaging without them", async () => {
  expect(missingElectronLicenses(dir)).toEqual(["LICENSE", "LICENSES.chromium.html"]);
  expect(() => checkElectronLicenses(dir)).toThrow(/LICENSE, LICENSES\.chromium\.html/);
  await writeFile(path.join(dir, "LICENSE"), "MIT");
  await writeFile(path.join(dir, "LICENSES.chromium.html"), "<html></html>");
  expect(missingElectronLicenses(dir)).toEqual([]);
  expect(() => checkElectronLicenses(dir)).not.toThrow();
});

it("copies the notices from Electron's dist when it holds the installed version", async () => {
  const out = path.join(dir, "out");
  const download = () => Promise.reject(new Error("no download expected"));
  const dist = await fakeDist("44.7.0");
  await expect(prepareElectronLicenses({ out, dist, version: "44.7.0", download })).resolves.toBe(
    "dist",
  );
  expect(await notices(out)).toEqual(["dist license 44.7.0", "<p>dist notices 44.7.0</p>"]);
  await expect(prepareElectronLicenses({ out, dist, version: "44.7.0", download })).resolves.toBe(
    "prepared",
  );
});

it("reads only the notices from the version's zip when dist lacks them", async () => {
  const out = path.join(dir, "out");
  const requested: string[] = [];
  const zip = await fakeZip("44.7.0");
  const download = (version: string) => {
    requested.push(version);
    return Promise.resolve(zip);
  };
  for (const dist of [path.join(dir, "absent"), await fakeDist("44.7.0", false)]) {
    await rm(out, { recursive: true, force: true });
    await expect(prepareElectronLicenses({ out, dist, version: "44.7.0", download })).resolves.toBe(
      "zip",
    );
    expect(await notices(out)).toEqual(["zip license 44.7.0", "<p>zip notices 44.7.0</p>"]);
  }
  expect(requested).toEqual(["44.7.0", "44.7.0"]);
  await expect(readFile(path.join(out, "Electron.app", "binary"))).rejects.toThrow();
});

it("replaces notices from another Electron version and ignores a stale dist", async () => {
  const out = path.join(dir, "out");
  await prepareElectronLicenses({ out, dist: await fakeDist("44.6.0"), version: "44.6.0" });
  const zip = await fakeZip("44.7.0");
  await expect(
    prepareElectronLicenses({
      out,
      dist: await fakeDist("44.6.0"),
      version: "44.7.0",
      download: () => Promise.resolve(zip),
    }),
  ).resolves.toBe("zip");
  expect(await notices(out)).toEqual(["zip license 44.7.0", "<p>zip notices 44.7.0</p>"]);
});

it("fails when the zip has no notices", async () => {
  const content = path.join(dir, "empty");
  await mkdir(content);
  await writeFile(path.join(content, "README"), "nothing here");
  const zip = path.join(dir, "empty.zip");
  await promisify(execFile)("zip", ["-qr", zip, "."], { cwd: content });
  await expect(
    prepareElectronLicenses({
      out: path.join(dir, "out"),
      dist: path.join(dir, "absent"),
      version: "44.7.0",
      download: () => Promise.resolve(zip),
    }),
  ).rejects.toThrow();
  expect(missingElectronLicenses(path.join(dir, "out")).length).toBeGreaterThan(0);
});
