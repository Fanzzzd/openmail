import type { ExpoConfig } from "expo/config";

const iosBundle = process.env.OPENMAIL_IOS_BUNDLE_ID ?? "com.openmail.mobile";
const androidPackage = process.env.OPENMAIL_ANDROID_PACKAGE ?? "com.openmail.mobile";
const mobileOAuth = {
  googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? "",
  googleAndroidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? "",
  microsoftClientId: process.env.EXPO_PUBLIC_MICROSOFT_CLIENT_ID ?? "",
  microsoftIosRedirect: `msauth.${iosBundle}://auth`,
  microsoftAndroidRedirect: process.env.EXPO_PUBLIC_MICROSOFT_ANDROID_REDIRECT ?? "",
};
const googleSchemes = [mobileOAuth.googleIosClientId, mobileOAuth.googleAndroidClientId]
  .filter(Boolean)
  .map((id) => id.split(".").toReversed().join("."));
const config: ExpoConfig = {
  name: "openmail",
  slug: "openmail-mobile",
  version: "0.1.0",
  scheme: ["openmail", `msauth.${iosBundle}`, ...googleSchemes],
  ios: { bundleIdentifier: iosBundle },
  android: {
    package: androidPackage,
    allowBackup: false,
    blockedPermissions: [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.RECEIVE_BOOT_COMPLETED",
      "com.google.android.c2dm.permission.RECEIVE",
    ],
    intentFilters: mobileOAuth.microsoftAndroidRedirect
      ? [
          {
            action: "VIEW",
            category: ["BROWSABLE", "DEFAULT"],
            data: [
              {
                scheme: "msauth",
                host: androidPackage,
                path: decodeURIComponent(new URL(mobileOAuth.microsoftAndroidRedirect).pathname),
              },
            ],
          },
        ]
      : [],
  },
  plugins: [
    "expo-router",
    "expo-background-task",
    "./plugins/local-notifications.cjs",
    "expo-secure-store",
    "expo-localization",
    "expo-web-browser",
    ["expo-image-picker", { cameraPermission: false, microphonePermission: false }],
  ],
  experiments: { autolinkingModuleResolution: true },
  extra: { mobileOAuth },
};
export default config;
