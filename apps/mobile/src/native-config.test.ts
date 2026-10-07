import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { expect, it } from "vitest";
const attributes = Schema.Struct({ $: Schema.Record(Schema.String, Schema.String) });
const resolved = Schema.Struct({
  _internal: Schema.Struct({
    modResults: Schema.Struct({
      ios: Schema.Struct({
        entitlements: Schema.Record(Schema.String, Schema.Unknown),
        infoPlist: Schema.Record(Schema.String, Schema.Unknown),
      }),
      android: Schema.Struct({
        manifest: Schema.Struct({
          manifest: Schema.Struct({
            "uses-permission": Schema.Array(attributes),
            application: Schema.Array(
              Schema.Struct({
                service: Schema.optionalKey(Schema.Array(attributes)),
                receiver: Schema.optionalKey(
                  Schema.Array(
                    Schema.Struct({
                      $: Schema.Record(Schema.String, Schema.String),
                      "intent-filter": Schema.optionalKey(
                        Schema.Array(Schema.Struct({ action: Schema.Array(attributes) })),
                      ),
                    }),
                  ),
                ),
              }),
            ),
          }),
        }),
      }),
    }),
  }),
});
const root = fileURLToPath(new URL("../", import.meta.url));
// Native permission inspection needs no network or CLI telemetry initialization.
const nativeEnv = { ...process.env, EXPO_OFFLINE: "1", EXPO_NO_TELEMETRY: "1" };
it("resolved native configuration allows local notifications and fetch, without camera, microphone, boot or push capability", () => {
  const config = Schema.decodeUnknownSync(Schema.fromJsonString(resolved))(
    execFileSync(`${root}node_modules/.bin/expo`, ["config", "--type", "introspect", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: nativeEnv,
    }),
  )._internal.modResults;
  for (const name of ["CAMERA", "RECORD_AUDIO", "RECEIVE_BOOT_COMPLETED"])
    expect(
      config.android.manifest.manifest["uses-permission"].find(
        (item) => item.$["android:name"] === `android.permission.${name}`,
      )?.$["tools:node"],
    ).toBe("remove");
  expect(
    config.android.manifest.manifest["uses-permission"].find(
      (item) => item.$["android:name"] === "android.permission.POST_NOTIFICATIONS",
    )?.$["tools:node"],
  ).not.toBe("remove");
  const taskReceiver = config.android.manifest.manifest.application
    .flatMap((application) => application.receiver ?? [])
    .find(
      (receiver) => receiver.$["android:name"] === "expo.modules.taskManager.TaskBroadcastReceiver",
    );
  expect(taskReceiver?.$["tools:node"]).toBe("replace");
  expect(
    taskReceiver?.["intent-filter"]?.flatMap((filter) =>
      filter.action.map((action) => action.$["android:name"]),
    ),
  ).toEqual(["expo.modules.taskManager.TaskBroadcastReceiver.INTENT_ACTION"]);
  expect(config.ios.infoPlist.UIBackgroundModes).toEqual(["fetch"]);
  expect(config.ios.infoPlist.BGTaskSchedulerPermittedIdentifiers).toEqual([
    "com.openmail.mobile.refresh",
  ]);
  expect(config.ios.entitlements).not.toHaveProperty("aps-environment");
  expect(config.ios.infoPlist).not.toHaveProperty("NSCameraUsageDescription");
  expect(config.ios.infoPlist).not.toHaveProperty("NSMicrophoneUsageDescription");
  const services = config.android.manifest.manifest.application
    .flatMap((application) => application.service ?? [])
    .filter((service) => service.$["tools:node"] !== "remove")
    .map((service) => service.$["android:name"]);
  expect(services.some((name) => /FirebaseMessaging|Notifications|Boot/i.test(name ?? ""))).toBe(
    false,
  );
  const packageJson = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
    ),
  )(readFileSync(`${root}package.json`, "utf8"));
  expect(packageJson.dependencies).toHaveProperty("expo-notifications");
});
it("autolinks the synchronous backup-exclusion module with local notifications and the background worker", () => {
  const modules = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        modules: Schema.Array(
          Schema.Struct({
            packageName: Schema.String,
            modules: Schema.Array(Schema.Struct({ class: Schema.String })),
          }),
        ),
      }),
    ),
  )(
    execFileSync(
      `${root}node_modules/.bin/expo-modules-autolinking`,
      ["resolve", "--platform", "apple", "--json"],
      { cwd: root, encoding: "utf8", env: nativeEnv },
    ),
  ).modules;
  expect(
    modules.find((module) => module.packageName === "openmail-storage")?.modules,
  ).toContainEqual({ class: "OpenmailStorageModule" });
  expect(modules.some((module) => module.packageName === "expo-notifications")).toBe(true);
  expect(modules.some((module) => module.packageName === "expo-background-task")).toBe(true);
});

it("installed native dependencies use refresh, unmetered work and local notification grouping", () => {
  const read = (file: string) => readFileSync(`${root}node_modules/${file}`, "utf8");
  const scheduler = read("expo-background-task/ios/BackgroundTaskScheduler.swift");
  expect(scheduler).toContain("BGAppRefreshTaskRequest");
  expect(scheduler).not.toContain("BGProcessingTaskRequest");
  const module = read("expo-background-task/ios/BackgroundTaskModule.swift");
  expect(module).toContain('hasBackgroundModeEnabled("fetch")');
  expect(module).not.toContain('notification.userInfo?["url"]');
  expect(read("expo-background-task/ios/BackgroundTaskConstants.swift")).toContain(
    "com.openmail.mobile.refresh",
  );
  const android = read(
    "expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt",
  );
  expect(android).toContain("NetworkType.UNMETERED");
  expect(android).toContain("setRequiresBatteryNotLow(true)");
  const manifest = read("expo-notifications/android/src/main/AndroidManifest.xml");
  expect(manifest).not.toMatch(/BOOT|REBOOT|MY_PACKAGE_REPLACED|FirebaseMessaging/);
  expect(manifest).toContain("NOTIFICATION_EVENT");
  expect(
    read("expo-notifications/ios/ExpoNotifications/Notifications/NotificationRecords.swift"),
  ).toContain('content.threadIdentifier = data?["openmailThread"]');
  const builder = read(
    "expo-notifications/android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt",
  );
  expect(builder).toContain("builder.setGroup(it)");
  expect(builder).toContain("builder.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)");
  expect(builder).toContain("builder.setPublicVersion(createBuilder()");
  expect(builder).toContain('optString("openmailPublicTitle")');
});
