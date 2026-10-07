// Launch only the supplied build, always with a new temporary core/Chromium directory.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const bundle = path.resolve(process.argv[2] ?? "apps/desktop/release/mac-arm64/OpenMail.app");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "openmail-dist-test-"));
const output = path.resolve(process.env.OPENMAIL_DIST_REPORT_DIR ?? "out/dist-smoke");
const server = net.createServer();
let child;
let ws;
let log = "";
/** @type {{ error: Error | null }} */
const launch = { error: null };
const running = (target) => target.exitCode === null && target.signalCode === null;
const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
try {
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => {
    server.close(resolve);
  });
  child = spawn(path.join(bundle, "Contents/MacOS/OpenMail"), [
    `--user-data-dir=${dataDir}`,
    `--remote-debugging-port=${port}`,
  ]);
  child.on("error", (error) => {
    launch.error = error;
  });
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  let page;
  for (let attempt = 0; attempt < 400; attempt++) {
    if (launch.error) throw launch.error;
    if (child.exitCode !== null) throw new Error(`App exited (${child.exitCode}): ${log}`);
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => response.json())
      .catch(() => []);
    page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    if (page) break;
    await wait(300);
  }
  if (!page) throw new Error(`No renderer page within 120 seconds: ${log}`);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    if (frame.error) request.reject(new Error(JSON.stringify(frame.error)));
    else request.resolve(frame.result);
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await call("Runtime.evaluate", {
      expression:
        "typeof window.openmailRpc?.send === 'function' && document.body.innerText.length > 20 && document.querySelectorAll('button').length > 0",
      returnByValue: true,
    });
    ready = result.result.value === true;
    if (ready) break;
    await wait(200);
  }
  if (!ready || !existsSync(path.join(dataDir, "mail.db")))
    throw new Error(`Renderer/preload/core did not start: ${log}`);
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "startup.png"), Buffer.from(screenshot.data, "base64"));
  process.stdout.write(
    `${JSON.stringify({ started: true, bundle, screenshot: path.join(output, "startup.png") })}\n`,
  );
} finally {
  try {
    ws?.close();
    if (server.listening) server.close();
    if (child?.pid && running(child)) {
      child.kill("SIGTERM");
      await wait(500);
      if (running(child)) {
        child.kill("SIGKILL");
        await new Promise((resolve) => {
          child.once("exit", resolve);
        });
      }
    }
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "startup.log"), log);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
