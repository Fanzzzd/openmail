import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
mkdirSync("out/native", { recursive: true });
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const headers = join(dirname(require.resolve("node-api-headers/package.json")), "include");
  run("clang++", [
    "-std=c++17",
    "-shared",
    "-fPIC",
    "-fobjc-arc",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-mmacosx-version-min=13.0",
    "-undefined",
    "dynamic_lookup",
    "-I",
    headers,
    "-framework",
    "Foundation",
    "-framework",
    "UserNotifications",
    "native/NotificationPermissions.mm",
    "-o",
    "out/native/notification-permissions.node",
  ]);
  // Both release architectures use the same universal Vision helper.
  for (const arch of ["arm64", "x86_64"])
    run("swiftc", [
      "-O",
      "-target",
      `${arch}-apple-macos13.0`,
      "native/VisionCLI.swift",
      "-o",
      `out/native/vision-${arch}`,
    ]);
  for (const arch of ["arm64", "x86_64"])
    run("swiftc", [
      "-O",
      "-target",
      `${arch}-apple-macos13.0`,
      "native/AttachmentApps.swift",
      "-o",
      `out/native/attachment-apps-${arch}`,
    ]);
  run("lipo", [
    "-create",
    "out/native/attachment-apps-arm64",
    "out/native/attachment-apps-x86_64",
    "-output",
    "out/native/attachment-apps",
  ]);
  run("lipo", [
    "-create",
    "out/native/vision-arm64",
    "out/native/vision-x86_64",
    "-output",
    "out/native/vision",
  ]);
}
