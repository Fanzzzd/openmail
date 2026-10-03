import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("registers only app-specific schemes and the decoded Android signing path, with backup disabled", async () => {
  vi.stubEnv("OPENMAIL_IOS_BUNDLE_ID", "com.example.mail");
  vi.stubEnv("OPENMAIL_ANDROID_PACKAGE", "com.example.mail");
  vi.stubEnv("EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID", "ios.apps.googleusercontent.com");
  vi.stubEnv("EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID", "android.apps.googleusercontent.com");
  vi.stubEnv(
    "EXPO_PUBLIC_MICROSOFT_ANDROID_REDIRECT",
    "msauth://com.example.mail/abc%2Bdef%2Fghi%3D",
  );
  const { default: config } = await import("../app.config");
  expect(config.scheme).toEqual([
    "openmail",
    "msauth.com.example.mail",
    "com.googleusercontent.apps.ios",
    "com.googleusercontent.apps.android",
  ]);
  expect(config.scheme).not.toContain("msauth");
  expect(config.android?.allowBackup).toBe(false);
  expect(config.android?.intentFilters).toEqual([
    {
      action: "VIEW",
      category: ["BROWSABLE", "DEFAULT"],
      data: [{ scheme: "msauth", host: "com.example.mail", path: "/abc+def/ghi=" }],
    },
  ]);
});
it("does not register a broad MSAL intent filter when Android OAuth is unconfigured", async () => {
  vi.stubEnv("EXPO_PUBLIC_MICROSOFT_ANDROID_REDIRECT", "");
  const { default: config } = await import("../app.config");
  expect(config.scheme).not.toContain("msauth");
  expect(config.android?.intentFilters).toEqual([]);
  expect(config.android?.allowBackup).toBe(false);
});

it("blocks push, boot, camera and microphone capabilities", async () => {
  const { default: config } = await import("../app.config");
  expect(config.android?.blockedPermissions).toEqual(
    expect.arrayContaining([
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.RECEIVE_BOOT_COMPLETED",
    ]),
  );
  expect(config.plugins).toContainEqual([
    "expo-image-picker",
    { cameraPermission: false, microphonePermission: false },
  ]);
  expect(config.plugins).not.toContain("expo-notifications");
  expect(config.plugins).toContain("./plugins/local-notifications.cjs");
  expect(config.plugins).toContain("expo-background-task");
});
