import { connectCdp, listTargets } from "./cdp.mjs";
import { smokeClickExpression, isBlockedSmokeImage, smokeEnvironment } from "./smoke-ui.mjs";
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
    timeout: { type: "string", default: "180000" },
    keep: { type: "boolean", default: false },
    // Off by default: no provider calls. Pass --network to let the copy sync and check health.
    network: { type: "boolean", default: false },
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
if (values.keep) process.stderr.write(`Smoke directory: ${directory}\n`);
const report = {
  readOnly: true,
  network: values.network,
  copiedDatabase: !!values.db,
  ...(values.keep ? { directory } : {}),
  steps: [],
  consoleErrors: [],
  exceptions: [],
  ipcRejections: [],
  syncHealth: [],
  failure: "",
};
const STDERR_TAIL_BYTES = 4096;
/** @type {import("node:child_process").ChildProcess | undefined} */
let child;
let cdp;
let stderrTail = "";
let uiReady = false;
const cleanup = createSmokeCleanup({
  directory,
  keepDirectory: values.keep,
  child: () => child,
  socket: () => cdp?.socket,
});
const deadline = Date.now() + timeout;
const delay = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
function step(value) {
  report.steps.push(value);
  process.stderr.write(`Smoke step: ${value.step} (${value.status})\n`);
}
async function until(action, condition = String(action).slice(0, 200)) {
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(`Preview exited: ${child.exitCode ?? child.signalCode}`);
    if (uiReady && (await dismissFirstRunPrompts())) {
      await delay();
      continue;
    }
    const result = await action();
    if (result) return result;
    await delay();
  }
  throw new Error(`Smoke timeout while waiting for ${condition}`);
}
// Every CDP call and the socket open share the run's deadline.
const remaining = () => deadline - Date.now();
const send = (method, params) => cdp.send(method, params);
const evaluate = (expression) => cdp.evaluate(expression);
const dismissFirstRunPrompts = () =>
  evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      for (const dialog of dialogs) {
        if (dialog.textContent.includes('Create Personal and Work profiles?')) {
          const skip = [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === 'Skip');
          if (skip && !skip.disabled) skip.click();
          return true;
        }
      }
      return false;
    })()`);
const present = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
async function click(selector, ready, retry = false) {
  await until(
    () => evaluate(smokeClickExpression(selector, retry ? ready : undefined)),
    ready && retry ? `click ${selector} and find ${ready}` : `click ${selector}`,
  );
  if (ready && !retry)
    await until(() => present(ready), `find ${ready} after clicking ${selector}`);
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
      "--",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${directory}`,
      "--enable-automation",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: smokeEnvironment(process.env, directory, values.network),
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.once("error", (error) => {
    report.failure = error.message;
  });
  child.stderr.on("data", (data) => {
    process.stderr.write(data);
    stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_BYTES);
  });
  const target = await until(async () => {
    if (report.failure) throw new Error(report.failure);
    const targets = await listTargets(port);
    return targets.find(
      (candidate) => candidate.type === "page" && /\/index\.html(?:$|[?#])/.test(candidate.url),
    );
  });
  // Say why the page went away: the renderer crashed, or the preview process exited.
  let crashed = false;
  cdp = await connectCdp(target.webSocketDebuggerUrl, {
    connectTimeoutMs: remaining,
    callTimeoutMs: remaining,
    closeReason: () => {
      const exited =
        child && (child.exitCode !== null || child.signalCode !== null)
          ? `preview exited: ${child.exitCode ?? child.signalCode}`
          : "preview state unknown";
      return `CDP closed (${crashed ? "renderer crashed, " : ""}${exited})`;
    },
  });
  const contexts = new Map();
  cdp.onEvent((message) => {
    const params = message.params;
    if (message.method === "Inspector.targetCrashed") crashed = true;
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
      else if (!isBlockedSmokeImage(contexts.get(params.executionContextId), text))
        report.consoleErrors.push(text);
    }
    if (message.method === "Log.entryAdded" && params.entry.level === "error") {
      const entry = params.entry;
      if (!isBlockedSmokeImage(entry.url, entry.text))
        report.consoleErrors.push(entry.text.slice(0, 2000));
    }
  });
  const launch = await send("Browser.getBrowserCommandLine");
  if (!launch.arguments?.includes(`--user-data-dir=${directory}`))
    throw new Error("CDP belongs to a different application session");
  await send("Runtime.enable");
  await send("Inspector.enable");
  await send("Log.enable");
  await send("Page.enable");
  // Window managers may tile the window narrow; the steps below need the three-pane layout.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1320,
    height: 860,
    deviceScaleFactor: 0,
    mobile: false,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `if (window.top === window && window.openmailRpc) window.openmailRpc.onFrame(frame => {
    try { const frames = JSON.parse(frame); for (const response of Array.isArray(frames) ? frames : [frames]) {
      if (response._tag === 'Defect' || response._tag === 'ClientProtocolError' || (response._tag === 'Exit' && response.exit?._tag === 'Failure' && !response.exit.cause?.every(cause => cause._tag === 'Interrupt'))) console.error('OPENMAIL_SMOKE_IPC:' + JSON.stringify(response).slice(0, 1000));
    }} catch { console.error('OPENMAIL_SMOKE_IPC:Invalid frame'); }
  });`,
  });
  await send("Page.reload");
  await until(() => evaluate('!!document.querySelector("aside")'));
  step({ step: "main-window", status: "passed" });
  uiReady = true;
  await until(async () => !(await dismissFirstRunPrompts()));
  step({ step: "first-run-prompts", status: "passed" });
  if (snapshot.accounts) await until(() => present('[role="listbox"][aria-busy="false"]'));
  const first = await evaluate('!!document.querySelector("[data-id][role=option]")');
  if (first) {
    await click('[data-id][role="option"]', "article[data-message-id]", true);
    step({ step: "first-thread", status: "passed" });
  } else
    step({
      step: "first-thread",
      status: "skipped",
      reason: "No cached inbox threads",
    });
  const accounts = snapshot.accounts > 0;
  if (accounts) {
    await click('aside button[aria-label="New message"]', "[data-compose]");
    step({ step: "composer", status: "passed" });
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
  } else step({ step: "composer", status: "skipped", reason: "No account" });
  if (snapshot.accounts) {
    await click('aside button[aria-label="Settings"]', '[role="dialog"][aria-label="Settings"]');
    step({ step: "settings", status: "passed" });
  } else step({ step: "settings", status: "skipped", reason: "Account setup is open" });
  report.syncHealth = await evaluate("window.openmailSyncHealth()");
  step({ step: "sync-health", status: "passed" });
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  // The socket closes before the pnpm wrapper exits, so give it a moment to report how it ended.
  if (child && report.failure.startsWith("CDP closed")) {
    const exited = child.exitCode !== null || child.signalCode !== null;
    const settled =
      exited ||
      (await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      }));
    report.failure += settled
      ? `; preview exited: ${child.exitCode ?? child.signalCode}`
      : "; preview still running after 3 s";
  }
} finally {
  report.stderrTail = stderrTail;
  await cleanup();
  if (values.keep) process.stderr.write(`Smoke directory kept: ${directory}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    report.failure ||
    report.exceptions.length ||
    report.ipcRejections.length ||
    report.consoleErrors.length
  )
    process.exitCode ??= 1;
}
