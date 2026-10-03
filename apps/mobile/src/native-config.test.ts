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
              Schema.Struct({ service: Schema.optionalKey(Schema.Array(attributes)) }),
            ),
          }),
        }),
      }),
    }),
  }),
});
const root = fileURLToPath(new URL("../", import.meta.url));
it("resolved native configuration adds no camera, microphone, notification, boot or push capability", () => {
  const config = Schema.decodeUnknownSync(Schema.fromJsonString(resolved))(
    execFileSync(`${root}node_modules/.bin/expo`, ["config", "--type", "introspect", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  )._internal.modResults;
  for (const name of ["CAMERA", "RECORD_AUDIO", "POST_NOTIFICATIONS", "RECEIVE_BOOT_COMPLETED"])
    expect(
      config.android.manifest.manifest["uses-permission"].find(
        (item) => item.$["android:name"] === `android.permission.${name}`,
      )?.$["tools:node"],
    ).toBe("remove");
  expect(config.ios.entitlements).not.toHaveProperty("aps-environment");
  expect(config.ios.infoPlist).not.toHaveProperty("NSCameraUsageDescription");
  expect(config.ios.infoPlist).not.toHaveProperty("NSMicrophoneUsageDescription");
  const services = config.android.manifest.manifest.application
    .flatMap((application) => application.service ?? [])
    .map((service) => service.$["android:name"]);
  expect(services.some((name) => /FirebaseMessaging|Notifications|Boot/i.test(name ?? ""))).toBe(
    false,
  );
  const packageJson = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
    ),
  )(readFileSync(`${root}package.json`, "utf8"));
  expect(packageJson.dependencies).not.toHaveProperty("expo-notifications");
});
it("autolinks the synchronous backup-exclusion module without notifications", () => {
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
      { cwd: root, encoding: "utf8" },
    ),
  ).modules;
  expect(
    modules.find((module) => module.packageName === "openmail-storage")?.modules,
  ).toContainEqual({ class: "OpenmailStorageModule" });
  expect(modules.some((module) => module.packageName === "expo-notifications")).toBe(false);
});
