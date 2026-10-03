import { spawn } from "node:child_process";
import { createSmokeCleanup } from "../../../../dist/platform/node/smoke-cleanup.js";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: process.platform !== "win32",
  stdio: "ignore",
});
if (process.argv[4]) process.exitCode = Number(process.argv[4]);
const cleanup = createSmokeCleanup({
  directory: process.argv[2],
  keepDirectory: process.argv[5] === "keep",
  child: () => child,
  socket: () => ({ close: () => process.stdout.write("socket-closed\n") }),
});
child.once("spawn", async () => {
  process.stdout.write(`child:${child.pid}\n`);
  if (process.argv[3] === "normal") await Promise.all([cleanup(), cleanup()]);
});
