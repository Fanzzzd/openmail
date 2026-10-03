import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { createSmokeCleanup, prepareSmokeDatabase } from "@openmail/core/node";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    port: { type: "string" },
    timeout: { type: "string", default: "60000" },
  },
});
const timeout = Number(values.timeout);
if (!Number.isSafeInteger(timeout) || timeout < 1000) throw new Error("Invalid --timeout");
const requestedPort = values.port ? Number(values.port) : 0;
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)
  throw new Error("Invalid --port");
const reserve = createServer();
await new Promise((resolve, reject) => {
  reserve.once("error", reject);
  reserve.listen(requestedPort, "127.0.0.1", resolve);
});
const address = reserve.address();
const port = values.port
  ? Number(values.port)
  : typeof address === "object" && address
    ? address.port
    : 0;
await new Promise((resolve) => {
  reserve.close(resolve);
});
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port");
const directory = await mkdtemp(join(tmpdir(), "openmail-smoke-"));
const report = {
  readOnly: true,
  copiedDatabase: !!values.db,
  steps: [],
  consoleErrors: [],
  exceptions: [],
  ipcRejections: [],
  failure: "",
};
let child, socket;
const cleanup = createSmokeCleanup({ directory, child: () => child, socket: () => socket });
const pending = new Map();
let sequence = 0;
const deadline = Date.now() + timeout;
const delay = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
async function until(action) {
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(`Preview exited: ${child.exitCode ?? child.signalCode}`);
    const result = await action();
    if (result) return result;
    await delay();
  }
  throw new Error("Smoke timeout");
}
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      },
      Math.max(1, deadline - Date.now()),
    );
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error("Smoke UI evaluation failed");
  return result.result?.value;
}
const present = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
async function click(selector, ready) {
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`));
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  if (ready) await until(() => evaluate(`!!document.querySelector(${JSON.stringify(ready)})`));
}
try {
  const snapshot = prepareSmokeDatabase(values.db, directory);
  child = spawn(
    "pnpm",
    [
      "exec",
      "electron-vite",
      "preview",
      "--skipBuild",
      `--remote-debugging-port=${port}`,
      "--",
      `--user-data-dir=${directory}`,
      "--enable-automation",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, OPENMAIL_READ_ONLY: "1", OPENMAIL_HOME: directory },
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.once("error", (error) => {
    report.failure = error.message;
  });
  child.stderr.on("data", (data) => {
    process.stderr.write(data);
  });
  const target = await until(async () => {
    if (report.failure) throw new Error(report.failure);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      ).json();
      return targets.find(
        (candidate) => candidate.type === "page" && /\/index\.html(?:$|[?#])/.test(candidate.url),
      );
    } catch {
      return null;
    }
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CDP connection timeout")),
      Math.max(1, deadline - Date.now()),
    );
    timer.unref();
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
      { once: true },
    );
  });
  const contexts = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
      return;
    }
    const params = message.params;
    if (message.method === "Runtime.executionContextCreated")
      contexts.set(params.context.id, params.context.origin);
    if (message.method === "Runtime.exceptionThrown")
      report.exceptions.push(params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && params.type === "error") {
      const text = params.args
        .map((arg) => arg.value ?? arg.description ?? "")
        .join(" ")
        .slice(0, 2000);
      if (text.startsWith("OPENMAIL_SMOKE_IPC:")) report.ipcRejections.push(text.slice(19));
      else if (
        !(
          contexts.get(params.executionContextId) === "about:srcdoc" &&
          /Refused to load.*image.*Content Security Policy/i.test(text)
        )
      )
        report.consoleErrors.push(text);
    }
    if (message.method === "Log.entryAdded" && params.entry.level === "error") {
      const entry = params.entry;
      if (
        !(
          entry.url === "about:srcdoc" &&
          /Refused to load.*image.*Content Security Policy/i.test(entry.text)
        )
      )
        report.consoleErrors.push(entry.text.slice(0, 2000));
    }
  });
  socket.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("CDP closed"));
    pending.clear();
  });
  const launch = await send("Browser.getBrowserCommandLine");
  if (!launch.arguments?.includes(`--user-data-dir=${directory}`))
    throw new Error("CDP belongs to a different application session");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `if (window.top === window && window.openmailRpc) window.openmailRpc.onFrame(frame => {
    try { const frames = JSON.parse(frame); for (const response of Array.isArray(frames) ? frames : [frames]) {
      if (response._tag === 'Defect' || response._tag === 'ClientProtocolError' || (response._tag === 'Exit' && response.exit?._tag === 'Failure' && !response.exit.cause?.every(cause => cause._tag === 'Interrupt'))) console.error('OPENMAIL_SMOKE_IPC:' + response._tag);
    }} catch { console.error('OPENMAIL_SMOKE_IPC:Invalid frame'); }
  });`,
  });
  await send("Page.reload");
  await until(() => evaluate('!!document.querySelector("aside")'));
  report.steps.push({ step: "main-window", status: "passed" });
  if (snapshot.accounts) await until(() => present('[role="listbox"][aria-busy="false"]'));
  const first = await evaluate('!!document.querySelector("[data-id][role=option]")');
  if (first) {
    await click('[data-id][role="option"]', 'article[aria-label="Selected message"]');
    report.steps.push({ step: "first-thread", status: "passed" });
  } else
    report.steps.push({
      step: "first-thread",
      status: "skipped",
      reason: "No cached inbox threads",
    });
  const accounts = snapshot.accounts > 0;
  if (accounts) {
    await click('aside button[aria-label="New message"]', "[data-compose]");
    report.steps.push({ step: "composer", status: "passed" });
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await until(() => evaluate('!document.querySelector("[data-compose]")'));
  } else report.steps.push({ step: "composer", status: "skipped", reason: "No account" });
  if (snapshot.accounts) {
    await click('aside button[aria-label="Settings"]', '[role="dialog"][aria-label="Settings"]');
    report.steps.push({ step: "settings", status: "passed" });
  } else
    report.steps.push({ step: "settings", status: "skipped", reason: "Account setup is open" });
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
} finally {
  await cleanup();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    report.failure ||
    report.exceptions.length ||
    report.ipcRejections.length ||
    report.consoleErrors.length
  )
    process.exitCode ??= 1;
}
