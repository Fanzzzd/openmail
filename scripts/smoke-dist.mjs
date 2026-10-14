// Checks one packaged OpenMail.app, always with new temporary data directories:
//
//   1. The security fuses read back from the binary match build/security-fuses.cjs.
//   2. ELECTRON_RUN_AS_NODE=1 does not turn the app into Node.
//   3. `OpenMail --mcp` answers initialize and tools/list over stdio with exactly the
//      read-only tool set, writes only JSON-RPC frames to stdout, and exits 0 when stdin closes.
//   4. The GUI starts: renderer, preload and core, then a screenshot. Skip with --no-gui.
//
//   node scripts/smoke-dist.mjs apps/desktop/release/mac-arm64/OpenMail.app [--no-gui]
//
// Needs `pnpm --filter @openmail/core build` (the dist script runs it) for the expected tool
// list. Nothing here reads the real profile, OPENMAIL_HOME or the keychain.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const gui = !args.includes("--no-gui");
const bundle = path.resolve(
  args.find((arg) => !arg.startsWith("--")) ?? "apps/desktop/release/mac-arm64/OpenMail.app",
);
const executable = path.join(bundle, "Contents/MacOS/OpenMail");
const output = path.resolve(process.env.OPENMAIL_DIST_REPORT_DIR ?? "out/dist-smoke");
const scratch = mkdtempSync(path.join(os.tmpdir(), "openmail-dist-test-"));
const report = { bundle };
const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const running = (target) => target.exitCode === null && target.signalCode === null;

/** Output of a diagnostic command, or why it failed; never throws. */
function capture(command, argv) {
  try {
    return execFileSync(command, argv, { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 });
  } catch (error) {
    return `${command} failed: ${error instanceof Error ? error.message : String(error)}\n${error?.stdout ?? ""}`;
  }
}

/**
 * What a hung app process and its children are doing, for the timeout error. A process with
 * no output is often blocked in a modal dialog or a keychain prompt, which `sample` shows.
 */
function describeHang(pid) {
  const children = capture("pgrep", ["-P", String(pid)])
    .split("\n")
    .filter((line) => /^\d+$/.test(line));
  const parts = [
    `ps:\n${capture("ps", ["-o", "pid,ppid,stat,etime,command", "-p", [pid, ...children].join(",")])}`,
  ];
  for (const target of [String(pid), ...children])
    parts.push(`sample ${target}:\n${capture("sample", [target, "3"])}`);
  return parts.join("\n\n");
}

/** The environment an AI client starts the app with: none of this shell's Node, Electron or OpenMail settings. */
function clientEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^(NODE_|ELECTRON_|OPENMAIL_)/.test(key)) env[key] = value;
  return { ...env, ...extra };
}

/**
 * Runs the app with stdin lines, closes stdin once `until` accepts stdout, and waits for exit.
 * @param {string[]} argv
 * @param {Record<string, string>} env
 * @param {{ input?: object[], until?: (stdout: string) => boolean, timeoutMs?: number }} [options]
 */
function runApp(argv, env, { input = [], until = () => true, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let closed = false;
    const closeInput = () => {
      if (closed) return;
      closed = true;
      child.stdin.end();
    };
    let hang = "";
    const timer = setTimeout(() => {
      if (child.pid) hang = describeHang(child.pid);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (until(stdout)) closeInput();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, hang });
    });
    for (const line of input) child.stdin.write(`${JSON.stringify(line)}\n`);
    if (!input.length) closeInput();
  });
}

async function checkFuses() {
  const desktop = createRequire(path.join(root, "apps/desktop/package.json"));
  const fuses = await import(pathToFileURL(desktop.resolve("@electron/fuses")).href);
  const { securityFuses } = desktop("./build/security-fuses.cjs");
  const wire = await fuses.getCurrentFuseWire(bundle);
  const wrong = Object.entries(securityFuses(fuses.FuseV1Options))
    .map(([index, on]) => ({
      fuse: fuses.FuseV1Options[index],
      want: on ? "ENABLE" : "DISABLE",
      got: fuses.FuseState[wire[index]] ?? String(wire[index]),
    }))
    .filter((entry) => entry.want !== entry.got);
  if (wrong.length)
    throw new Error(`Fuses differ from build/security-fuses.cjs: ${JSON.stringify(wrong)}`);
  report.fuses = "match";
}

// With RunAsNode off the variable is ignored and the app starts. `--mcp` keeps that start
// windowless, and closing stdin ends it. With RunAsNode on, Node would run the probe script.
async function checkRunAsNode() {
  const probe = path.join(scratch, "probe.js");
  const marker = "OPENMAIL_RAN_AS_NODE";
  writeFileSync(probe, `process.stdout.write(${JSON.stringify(marker)}); process.exit(0);\n`);
  const result = await runApp(
    [probe, "--mcp"],
    clientEnv({ ELECTRON_RUN_AS_NODE: "1", OPENMAIL_HOME: path.join(scratch, "node-probe") }),
    { timeoutMs: 60_000 },
  );
  if (result.stdout.includes(marker) || result.stderr.includes(marker))
    throw new Error("ELECTRON_RUN_AS_NODE=1 ran a script: the RunAsNode fuse is on.");
  if (result.code !== 0)
    throw new Error(
      `With ELECTRON_RUN_AS_NODE=1 the app did not start and exit cleanly (${result.code ?? result.signal}): ${result.stderr}\n${result.hang}`,
    );
  report.runAsNode = "ignored";
}

async function checkMcp() {
  const core = path.join(root, "packages/core/dist/common.js");
  if (!existsSync(core)) throw new Error("packages/core/dist is missing. Run `pnpm build` first.");
  const { ReadMailToolkit } = await import(pathToFileURL(core).href);
  const expected = Object.keys(ReadMailToolkit.tools).toSorted();
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openmail-dist-smoke", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const result = await runApp(
    ["--mcp"],
    clientEnv({ OPENMAIL_HOME: path.join(scratch, "mcp-home") }),
    { input: requests, until: (stdout) => /"id":2[,}]/.test(stdout) },
  );
  const context = `exit ${result.code ?? result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n${result.hang}`;
  if (result.code !== 0) throw new Error(`OpenMail --mcp did not exit cleanly. ${context}`);
  const lines = result.stdout.split("\n").filter(Boolean);
  const frames = lines.map((line) => {
    try {
      const frame = JSON.parse(line);
      if (frame.jsonrpc === "2.0") return frame;
    } catch {
      // Reported below.
    }
    throw new Error(`OpenMail --mcp wrote a non-JSON-RPC line to stdout: ${line}`);
  });
  const init = frames.find((frame) => frame.id === 1);
  const list = frames.find((frame) => frame.id === 2);
  if (!init?.result?.serverInfo) throw new Error(`No initialize result. ${context}`);
  const tools = (list?.result?.tools ?? []).map((tool) => tool.name).toSorted();
  if (JSON.stringify(tools) !== JSON.stringify(expected))
    throw new Error(
      `--mcp tools differ from the read-only toolkit.\nexpected ${expected.join(", ")}\nreceived ${tools.join(", ")}`,
    );
  report.mcp = { server: init.result.serverInfo.name, tools: tools.length };
}

async function checkGui() {
  const dataDir = path.join(scratch, "gui");
  const server = net.createServer();
  let child;
  let ws;
  let log = "";
  // Written as it arrives, so a job killed mid-check still leaves the log for the artifact.
  const logFile = path.join(output, "startup.log");
  mkdirSync(output, { recursive: true });
  writeFileSync(logFile, "");
  const record = (chunk) => {
    log += chunk;
    appendFileSync(logFile, chunk);
  };
  /** @type {{ error: Error | null }} */
  const launch = { error: null };
  try {
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => {
      server.close(resolve);
    });
    child = spawn(executable, [`--user-data-dir=${dataDir}`, `--remote-debugging-port=${port}`], {
      env: clientEnv({}),
    });
    child.on("error", (error) => {
      launch.error = error;
    });
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    let page;
    for (let attempt = 0; attempt < 400; attempt++) {
      if (launch.error) throw launch.error;
      if (child.exitCode !== null) throw new Error(`App exited (${child.exitCode}): ${log}`);
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      })
        .then((response) => response.json())
        .catch(() => []);
      page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (page) break;
      await wait(300);
    }
    if (!page) throw new Error(`No renderer page within 120 seconds: ${log}`);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 10_000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener("error", () => reject(new Error("CDP connection failed")), {
        once: true,
      });
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
    ws.addEventListener("close", () => {
      for (const request of pending.values()) request.reject(new Error(`CDP closed: ${log}`));
      pending.clear();
    });
    const call = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10_000);
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
    writeFileSync(path.join(output, "startup.png"), Buffer.from(screenshot.data, "base64"));
    report.started = true;
    report.screenshot = path.join(output, "startup.png");
  } finally {
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
  }
}

try {
  if (!existsSync(executable)) throw new Error(`No app at ${bundle}`);
  await checkFuses();
  await checkRunAsNode();
  await checkMcp();
  if (gui) await checkGui();
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
