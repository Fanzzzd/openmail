import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("Blocked parser fixture requires a parent");
const port = parentPort;
const blocked = new Int32Array(new SharedArrayBuffer(4));
port.on("message", () => {
  port.postMessage({ kind: "start", stage: "visible-text" });
  Atomics.wait(blocked, 0, 0);
});
port.postMessage({ kind: "ready" });
