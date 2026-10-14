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
  // Shown in Finder's Get Info and the About panel. The license field comes from package.json.
  copyright: "Copyright (c) 2026 Fanzzzd and OpenMail contributors",
  protocols: [
    { name: "OpenMail message links", schemes: ["openmail"], role: "Viewer" },
    { name: "Email", schemes: ["mailto"], role: "Editor" },
  ],
  extraResources: [
    { from: "../../LICENSE", to: "LICENSE" },
    { from: "../../THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    { from: "build/contacts-locales", to: ".", filter: ["**/InfoPlist.strings"] },
    { from: "build/trayTemplate.png", to: "trayTemplate.png" },
    { from: "build/trayTemplate@2x.png", to: "trayTemplate@2x.png" },
    {
      from: "out/native",
      to: "native",
      filter: [
        "vision",
        "attachment-apps",
        "contacts",
        "OpenMailPhotos.app",
        "OpenMailPhotos.app/**/*",
        "grammar",
        "notification-permissions.node",
      ],
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
  afterPack: require("./build/security-fuses.cjs").afterPack,
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
  publish: [{ provider: "github", owner: "Fanzzzd", repo: "openmail" }],
  mac: {
    extendInfo: {
      NSContactsUsageDescription:
        "Use Apple Contacts for local recipient suggestions. Contacts are never sent to AI models.",
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
    // Sources and regeneration: docs/design/icons.md.
    icon: "build/icon.icon",
    // Ad-hoc signing repairs Electron's seal on Apple Silicon. It does not enable updates.
    identity: signed ? undefined : "-",
    hardenedRuntime: true,
    binaries: [
      "Contents/Resources/native/contacts",
      "Contents/Resources/native/OpenMailPhotos.app/Contents/MacOS/photos",
      "Contents/Resources/native/grammar",
    ],
    sign: require("./build/sign-contacts.cjs").sign,
    entitlements: signed ? "build/entitlements.mac.plist" : "build/entitlements.mac.unsigned.plist",
    entitlementsInherit: signed
      ? "build/entitlements.mac.inherit.plist"
      : "build/entitlements.mac.unsigned.inherit.plist",
    notarize: signed && Boolean(appleId || apiKey || profile),
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
  },
};
