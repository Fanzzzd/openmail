import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
mkdirSync("out/native", { recursive: true });
if (process.platform === "darwin") {
  const result = spawnSync("swiftc", ["-O", "native/VisionCLI.swift", "-o", "out/native/vision"], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
