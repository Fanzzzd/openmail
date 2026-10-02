const { createRequire } = require("node:module");
const path = require("node:path");

/** Preserve electron-builder's options for every binary except the Contacts CLI. */
function contactsSigningOptions(options) {
  const helper = path.join(options.app, "Contents/Resources/native/contacts");
  return {
    ...options,
    optionsForFile: (file) => ({
      ...options.optionsForFile(file),
      ...(file === helper
        ? { entitlements: path.join(__dirname, "entitlements.contacts.plist") }
        : {}),
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
