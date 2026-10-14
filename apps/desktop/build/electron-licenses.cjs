// Electron keeps its license and Chromium's notices next to Electron.app in its dist folder, so
// the mac target never copies them into the bundle. extraResources ships them in
// Contents/Resources/licenses/electron/, and scripts/smoke-dist.mjs checks a packaged app has them.
const { existsSync } = require("node:fs");
const path = require("node:path");

const ELECTRON_LICENSE_DIR = "licenses/electron";
const ELECTRON_LICENSE_FILES = ["LICENSE", "LICENSES.chromium.html"];

/** The installed electron package's dist folder. */
function electronDist() {
  return path.join(path.dirname(require.resolve("electron/package.json")), "dist");
}

/** extraResources entries that copy the notices into Contents/Resources. */
function electronLicenseResources(dist = electronDist()) {
  return ELECTRON_LICENSE_FILES.map((file) => ({
    from: path.join(dist, file),
    to: `${ELECTRON_LICENSE_DIR}/${file}`,
  }));
}

/** Notices absent from a directory: an Electron dist folder, or a packaged app's licenses/electron. */
function missingElectronLicenses(dir) {
  return ELECTRON_LICENSE_FILES.filter((file) => !existsSync(path.join(dir, file)));
}

/** Stops packaging when Electron's download left out the notices. */
function checkElectronLicenses(dist = electronDist()) {
  const missing = missingElectronLicenses(dist);
  if (missing.length)
    throw new Error(
      `Electron's license notices are missing from ${dist}: ${missing.join(", ")}. Reinstall electron.`,
    );
}

module.exports = {
  ELECTRON_LICENSE_DIR,
  ELECTRON_LICENSE_FILES,
  checkElectronLicenses,
  electronLicenseResources,
  missingElectronLicenses,
};
