// electron-builder compiles build/icon.icon (Icon Composer) with Xcode 26's actool. Older Xcode
// versions, or a Mac with only the Command Line Tools, cannot, so packaging falls back to the
// committed build/icon.icns. That build has the flat icon on every macOS version, without the
// Liquid Glass, dark and tinted appearances of macOS 26.
const { execFileSync } = require("node:child_process");

const ICON_COMPOSER = "build/icon.icon";
const ICNS = "build/icon.icns";
const MIN_XCODE = 26;

/** The major version in `xcodebuild -version` output ("Xcode 26.0.1"), or undefined. */
function xcodeMajor(output) {
  const match = /^Xcode (\d+)(?:\.|\s|$)/m.exec(output ?? "");
  return match ? Number(match[1]) : undefined;
}

/** The icon to package for the given `xcodebuild -version` output; null when it failed. */
function macIconFor(output) {
  const major = xcodeMajor(output);
  return major !== undefined && major >= MIN_XCODE ? ICON_COMPOSER : ICNS;
}

function readXcodeVersion() {
  try {
    return execFileSync("xcodebuild", ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    // Not installed, or xcode-select points at the Command Line Tools.
    return null;
  }
}

/** Picks the icon and says so when it falls back. */
function macIcon(read = readXcodeVersion, log = (message) => process.stderr.write(`${message}\n`)) {
  const icon = macIconFor(read());
  if (icon === ICNS)
    log(
      `Xcode ${MIN_XCODE} or later not found: packaging with ${ICNS}. The app gets the flat icon without the macOS 26 Liquid Glass appearances.`,
    );
  return icon;
}

module.exports = { ICNS, ICON_COMPOSER, macIcon, macIconFor, xcodeMajor };
