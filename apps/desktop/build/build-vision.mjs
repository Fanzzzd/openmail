import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
mkdirSync("out/native", { recursive: true });
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (process.platform === "darwin") {
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
  run("lipo", [
    "-create",
    "out/native/vision-arm64",
    "out/native/vision-x86_64",
    "-output",
    "out/native/vision",
  ]);
}
