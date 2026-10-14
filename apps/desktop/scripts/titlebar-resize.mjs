// Resizes a real Electron window and checks, frame by frame, that the controls beside the macOS
// traffic lights do not move. See docs/testing.md#titlebar-resize-check.
//
//   pnpm build
//   node apps/desktop/scripts/titlebar-resize.mjs             # seeds demo data, starts the preview
//   node apps/desktop/scripts/titlebar-resize.mjs --port 9333 # a dev app already on that CDP port
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { smokeEnvironment } from "./smoke-ui.mjs";

const { values } = parseArgs({
  options: { port: { type: "string" }, timeout: { type: "string", default: "120000" } },
});
const deadline = Date.now() + Number(values.timeout);
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const report = { attached: !!values.port, checks: [], failure: "" };
/** @type {import("node:child_process").ChildProcess | undefined} */
let child;
/** @type {string | undefined} */
let directory;
/** @type {WebSocket | undefined} */
let socket;

async function until(action, what) {
  while (Date.now() < deadline) {
    const result = await action().catch(() => null);
    if (result) return result;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let sequence = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
  return result.result.value;
}

// Samples once per frame from a ResizeObserver created after the app's own, so each sample sees
// the layout that frame paints, after the app's observers have run.
const sampler = `window.__titlebarFrames = (sample) => {
  const frames = [];
  const probe = document.body.appendChild(document.createElement("div"));
  probe.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  let on = true, flip = false;
  const observer = new ResizeObserver(() => { if (on) frames.push(sample()); });
  observer.observe(probe);
  const tick = () => { if (!on) return; flip = !flip; probe.style.width = flip ? "2px" : "1px"; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return () => { on = false; observer.disconnect(); probe.remove(); return frames; };
}`;
const left = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? Math.round(el.getBoundingClientRect().left) : null; })()`;
const toggle = 'button[aria-label="Show sidebar"]';
const search = '[role="combobox"][aria-label="Search mail"]';

function check(name, frames, expected) {
  const moved = frames.filter((frame) =>
    Object.entries(expected).some(([key, value]) => frame[key] !== value),
  );
  report.checks.push({ name, frames: frames.length, expected, moved: moved.slice(0, 5) });
  if (moved.length > 0) throw new Error(`${name}: ${moved.length} frames moved`);
}

try {
  let port = Number(values.port);
  if (!values.port) {
    directory = await mkdtemp(join(tmpdir(), "openmail-titlebar-"));
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    execFileSync(process.execPath, [join(root, "scripts/demo-data.mjs"), directory], {
      stdio: "ignore",
    });
    port = 9200 + Math.floor(Math.random() * 500);
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
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: smokeEnvironment(process.env, directory),
        stdio: "ignore",
        detached: true,
      },
    );
  }
  const target = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find(
      (candidate) =>
        candidate.type === "page" &&
        /\/index\.html/.test(candidate.url) &&
        !/#\/(thread|compose)/.test(candidate.url),
    );
  }, "the main window");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await until(() => evaluate("!!navigator.windowControlsOverlay?.visible"), "the traffic lights");
  await evaluate(sampler);

  // One pane at a time: the sidebar toggle and the search field share the lights' row.
  await evaluate("window.resizeTo(600, 700)");
  await sleep(300);
  await evaluate(`document.querySelector('button[aria-label="Back to messages"]')?.click()`);
  await until(() => evaluate(`!!document.querySelector('${search}')`), "the search row");
  await sleep(500);
  const resting = { toggle: await evaluate(left(toggle)), search: await evaluate(left(search)) };
  if (resting.toggle === null) throw new Error("No sidebar toggle in the narrow window");
  const frames = await evaluate(`(async () => {
    const stop = window.__titlebarFrames(() => ({ toggle: ${left(toggle)}, search: ${left(search)},
      overlay: navigator.windowControlsOverlay.getTitlebarAreaRect().x }));
    for (const width of [620, 640, 660, 680, 700, 720, 700, 660, 620, 600]) {
      window.resizeTo(width, 700);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return stop();
  })()`);
  report.overlayXs = [...new Set(frames.map((frame) => frame.overlay))];
  check(
    "resize",
    frames.map(({ toggle: t, search: s }) => ({ toggle: t, search: s })),
    resting,
  );

  // A wide window with the sidebar hidden: the toggle moves to the list header beside the
  // lights. Showing and hiding the sidebar must not paint a frame with the old spacer.
  await evaluate("window.resizeTo(1320, 860)");
  await sleep(500);
  const key = `window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true, altKey: true, shiftKey: true, bubbles: true }))`;
  const docked = () => evaluate("!!document.querySelector('[data-mail-pane=\"sidebar\"]')");
  if (await docked()) {
    await evaluate(key);
    await until(async () => !(await docked()), "the sidebar to hide");
    await sleep(300);
  }
  const hidden = {
    toggle: await evaluate(left(toggle)),
    title: await evaluate(left("section h1")),
  };
  await evaluate(key);
  await until(docked, "the sidebar to show");
  await sleep(300);
  const shown = { toggle: null, title: await evaluate(left("section h1")) };
  const toggled = await evaluate(`(async () => {
    const stop = window.__titlebarFrames(() => ({ toggle: ${left(toggle)}, title: ${left("section h1")} }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    ${key};
    await new Promise((resolve) => setTimeout(resolve, 400));
    ${key};
    await new Promise((resolve) => setTimeout(resolve, 400));
    return stop();
  })()`);
  const states = [hidden, shown].map((state) => JSON.stringify(state));
  const between = toggled.filter((frame) => !states.includes(JSON.stringify(frame)));
  report.checks.push({ name: "sidebar", frames: toggled.length, states, moved: between });
  if (between.length > 0) throw new Error(`sidebar: ${between.length} frames between states`);
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
} finally {
  socket?.close();
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The preview already exited.
    }
    await sleep(1500);
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failure) process.exitCode = 1;
}
