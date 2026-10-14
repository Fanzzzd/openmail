// Electron keeps its license and Chromium's notices next to Electron.app in its dist folder, so
// the mac target never copies them into the bundle. The dist script runs this file, which puts
// both notices in build/generated/electron-licenses/. extraResources ships that folder in
// Contents/Resources/licenses/electron/, and scripts/smoke-dist.mjs checks a packaged app has them.
//
// Electron 44 has no install script of its own. apps/desktop's postinstall runs its
// install-electron bin, which fills node_modules/electron/dist, but an install with
// --ignore-scripts skips that. Without dist, this file takes the two notices from the Electron zip for the installed version,
// fetched through @electron/get into the cache electron-builder also uses.
const { execFile } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { copyFile, mkdir, rm, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");

const ELECTRON_LICENSE_DIR = "licenses/electron";
const ELECTRON_LICENSE_FILES = ["LICENSE", "LICENSES.chromium.html"];
/** The gitignored folder the dist script fills and extraResources copies from. */
const ELECTRON_LICENSE_SOURCE = path.join(__dirname, "generated", "electron-licenses");
/** Records which Electron version the notices in ELECTRON_LICENSE_SOURCE belong to. */
const VERSION_FILE = "version";

/** extraResources entries that copy the notices into Contents/Resources. */
function electronLicenseResources(source = ELECTRON_LICENSE_SOURCE) {
  return ELECTRON_LICENSE_FILES.map((file) => ({
    from: path.join(source, file),
    to: `${ELECTRON_LICENSE_DIR}/${file}`,
  }));
}

/** Notices absent from a directory: a dist folder, the prepared folder, or a packaged app's. */
function missingElectronLicenses(dir) {
  return ELECTRON_LICENSE_FILES.filter((file) => !existsSync(path.join(dir, file)));
}

/** Stops packaging when the dist script did not prepare the notices. */
function checkElectronLicenses(source = ELECTRON_LICENSE_SOURCE) {
  const missing = missingElectronLicenses(source);
  if (missing.length)
    throw new Error(
      `Electron's license notices are missing from ${source}: ${missing.join(", ")}. ` +
        "The dist script prepares them with node build/electron-licenses.cjs.",
    );
}

function readVersion(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim().replace(/^v/, "") : "";
}

/** The installed electron package: its folder and version. */
function installedElectron() {
  const dir = path.dirname(require.resolve("electron/package.json"));
  return { dir, version: require(path.join(dir, "package.json")).version };
}

/** The Electron zip for a version, from the electron-builder cache or downloaded into it. */
async function downloadElectronZip(version) {
  const electron = createRequire(path.join(installedElectron().dir, "package.json"));
  const { downloadArtifact } = await import(pathToFileURL(electron.resolve("@electron/get")).href);
  return downloadArtifact({
    version,
    artifactName: "electron",
    platform: "darwin",
    arch: process.arch,
    checksums: electron("./checksums.json"),
  });
}

/** One entry of a zip, read by name, so nothing else from the archive lands on disk. */
async function readZipEntry(zip, name) {
  const { stdout } = await promisify(execFile)("unzip", ["-p", zip, name], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Puts Electron's notices for `version` in `out`. Copies them from Electron's dist folder when it
 * holds that version, otherwise reads them from the version's zip. Returns where they came from.
 */
async function prepareElectronLicenses({
  out = ELECTRON_LICENSE_SOURCE,
  dist,
  version,
  download = downloadElectronZip,
} = {}) {
  if (!dist || !version) {
    const electron = installedElectron();
    dist ??= path.join(electron.dir, "dist");
    version ??= electron.version;
  }
  if (!missingElectronLicenses(out).length && readVersion(path.join(out, VERSION_FILE)) === version)
    return "prepared";
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  let source;
  if (
    !missingElectronLicenses(dist).length &&
    readVersion(path.join(dist, "version")) === version
  ) {
    for (const file of ELECTRON_LICENSE_FILES)
      await copyFile(path.join(dist, file), path.join(out, file));
    source = "dist";
  } else {
    const zip = await download(version);
    for (const file of ELECTRON_LICENSE_FILES)
      await writeFile(path.join(out, file), await readZipEntry(zip, file));
    source = "zip";
  }
  await writeFile(path.join(out, VERSION_FILE), `${version}\n`);
  return source;
}

module.exports = {
  ELECTRON_LICENSE_DIR,
  ELECTRON_LICENSE_FILES,
  ELECTRON_LICENSE_SOURCE,
  checkElectronLicenses,
  electronLicenseResources,
  missingElectronLicenses,
  prepareElectronLicenses,
};

if (require.main === module) {
  // OPENMAIL_ELECTRON_DIST points the dist lookup elsewhere, e.g. at an empty folder to take the
  // zip path the way a fresh CI install does.
  const how = { prepared: "already prepared", dist: "copied from dist", zip: "read from zip" };
  prepareElectronLicenses({ dist: process.env.OPENMAIL_ELECTRON_DIST || undefined })
    .then((source) =>
      process.stdout.write(`Electron license notices ${how[source]}: ${ELECTRON_LICENSE_SOURCE}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
