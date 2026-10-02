// dist is always local. Signing is an explicit build mode; publishing stays off.
const signed = process.env.OPENMAIL_SIGNED_BUILD === "1";
const appleId =
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
const apiKey =
  process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
const profile = process.env.APPLE_KEYCHAIN_PROFILE;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "app.openmail.desktop",
  productName: "OpenMail",
  protocols: [
    { name: "OpenMail message links", schemes: ["openmail"], role: "Viewer" },
    { name: "Email", schemes: ["mailto"], role: "Editor" },
  ],
  extraResources: [
    { from: "build/trayTemplate.png", to: "trayTemplate.png" },
    { from: "build/trayTemplate@2x.png", to: "trayTemplate@2x.png" },
    {
      from: "out/native",
      to: "native",
      filter: ["vision", "attachment-apps", "notification-permissions.node"],
    },
  ],
  directories: { buildResources: "build", output: "release" },
  files: [
    "out/**",
    "package.json",
    "!**/*.test.*",
    "!**/*.map",
    "!**/.turbo/**",
    "!out/native/**",
    "!**/node_modules/onnxruntime-node/bin/napi-v6/linux/**",
    "!**/node_modules/onnxruntime-node/bin/napi-v6/win32/**",
    "!**/node_modules/onnxruntime-node/bin/napi-v6/darwin/!(${arch})/**",
  ],
  npmRebuild: false,
  asar: true,
  asarUnpack: [
    "**/*.node",
    "**/*.dylib",
    "**/node_modules/onnxruntime-node/**",
    "**/node_modules/@img/**",
    "**/node_modules/@napi-rs/keyring-*/**",
    "**/node_modules/sqlite-vec*/**",
  ],
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  forceCodeSigning: signed,
  publish: [{ provider: "github", owner: "Fanzzzd", repo: "openmail", private: true }],
  mac: {
    extendInfo: {
      NSUserNotificationAlertStyle: "alert",
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Attachment",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "None",
          LSItemContentTypes: ["public.data", "public.content"],
        },
      ],
    },
    category: "public.app-category.productivity",
    // Existing artwork is a placeholder. User choices are in docs/design/icon-options.
    icon: "build/icon.icon",
    // Ad-hoc signing repairs Electron's seal on Apple Silicon. It does not enable updates.
    identity: signed ? undefined : "-",
    hardenedRuntime: true,
    entitlements: signed ? "build/entitlements.mac.plist" : "build/entitlements.mac.unsigned.plist",
    entitlementsInherit: signed
      ? "build/entitlements.mac.inherit.plist"
      : "build/entitlements.mac.unsigned.plist",
    notarize: signed && Boolean(appleId || apiKey || profile),
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
  },
};
