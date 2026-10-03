const { createRequire } = require("node:module");
const path = require("node:path");

/** Native helpers have individual entitlements; never inherit Electron's JIT permissions. */
function contactsSigningOptions(options) {
  const entitlements = new Map(
    ["contacts", "grammar"].map((name) => [
      path.join(options.app, `Contents/Resources/native/${name}`),
      path.join(__dirname, `entitlements.${name}.plist`),
    ]),
  );
  const photos = path.join(options.app, "Contents/Resources/native/OpenMailPhotos.app");
  for (const file of [photos, path.join(photos, "Contents/MacOS/photos")])
    entitlements.set(file, path.join(__dirname, "entitlements.photos.plist"));
  return {
    ...options,
    optionsForFile: (file) => ({
      ...options.optionsForFile(file),
      ...(entitlements.has(file) ? { entitlements: entitlements.get(file) } : {}),
    }),
  };
}
async function sign(options) {
  // Resolve the exact signer version already used by electron-builder.
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const signingRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const { signAsync } = signingRequire("@electron/osx-sign");
  await signAsync(contactsSigningOptions(options));
}
module.exports = { sign, contactsSigningOptions };
