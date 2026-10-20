// Resizes a real Electron window and checks, frame by frame, that the controls beside the macOS
// traffic lights do not move. See docs/testing.md#titlebar-resize-check.
//
//   pnpm build
//   node apps/desktop/scripts/titlebar-resize.mjs             # seeds demo data, starts the preview
//   node apps/desktop/scripts/titlebar-resize.mjs --app apps/desktop/release/mac-arm64/OpenMail.app
//   node apps/desktop/scripts/titlebar-resize.mjs --port 9333 # a dev app already on that CDP port
//
// --timeout (ms, default 120000) bounds each attempt. A failed attempt runs the whole check once
// more on a fresh launch, and the run fails only when both fail. A started app that exits early
// fails its attempt at once, and a failed attempt carries the app's stdout and stderr.
// --report <path> also writes the JSON report, with every attempt, to that file.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { requireVisibleWindows, smokeEnvironment } from "./smoke-ui.mjs";

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    port: { type: "string" },
    timeout: { type: "string", default: "120000" },
    report: { type: "string" },
  },
});
// The check reads the native titlebar and resizes a real window frame by frame, so the window must
// be on a screen. A launched app runs only where that is allowed; `--port` attaches to an app the
// caller already started.
if (!values.port)
  requireVisibleWindows(
    "The titlebar resize check",
    "it resizes a real window and reads the traffic lights' native titlebar area",
  );
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Per-attempt state. `attempt()` resets it, so a retry starts from a fresh launch.
let deadline = 0;
/** @type {{ checks: object[], failure: string, overlayXs?: number[], output?: string }} */
let report = { checks: [], failure: "" };
/** @type {import("node:child_process").ChildProcess | undefined} */
let child;
/** @type {string | undefined} */
let directory;
/** @type {WebSocket | undefined} */
let socket;
/** The started app's stdout and stderr, interleaved, for the failure report. */
let output = "";
/** Why the started app stopped before the attempt ended. */
let exited = "";

async function until(action, what) {
  while (Date.now() < deadline) {
    if (exited) throw new Error(`The app exited (${exited}) while waiting for ${what}`);
    const result = await action().catch(() => null);
    if (result) return result;
    await sleep(200);
  }
  throw new Error(`Timed out after ${values.timeout} ms waiting for ${what}`);
}

const record = (chunk) => {
  output = (output + chunk).slice(-20_000);
};

/** Starts the packaged app at `--app`, or the electron-vite preview of the built sources. */
function launch(port) {
  const flags = [`--remote-debugging-port=${port}`, `--user-data-dir=${directory}`];
  const options = {
    env: smokeEnvironment(process.env, directory, false, "background"),
    stdio: /** @type {const} */ (["ignore", "pipe", "pipe"]),
    detached: true,
  };
  const started = values.app
    ? spawn(join(resolvePath(values.app), "Contents/MacOS/OpenMail"), flags, options)
    : spawn("pnpm", ["exec", "electron-vite", "preview", "--skipBuild", "--", ...flags], {
        ...options,
        cwd: fileURLToPath(new URL("..", import.meta.url)),
      });
  // A killed app from the first attempt can still report its exit; only the current one counts.
  const current =
    (listener) =>
    (...args) => {
      if (child === started) listener(...args);
    };
  started.stdout?.on("data", current(record));
  started.stderr?.on("data", current(record));
  started.on(
    "error",
    current((error) => {
      exited = error.message;
    }),
  );
  started.on(
    "exit",
    current((code, signal) => {
      exited = signal ?? `code ${code}`;
    }),
  );
  return started;
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
// What crosses the lights' box, from the window's left edge to the free area and down their row:
// a pane divider (a border or a 1 px separator) or a control or heading.
const underLights = `window.__underLights = (x, height) => {
  const found = [];
  const name = (el) => el.tagName.toLowerCase() + (el.getAttribute("aria-label") ? "[" + el.getAttribute("aria-label") + "]" : "") + (el.dataset.mailPane ? "[" + el.dataset.mailPane + "]" : "");
  const drawn = (width, color) => parseFloat(width) > 0 && color !== "transparent" && !/,\\s*0\\)$/.test(color);
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.top >= height || r.left >= x || r.right <= 0) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.opacity === "0") continue;
    const lines = [];
    if (drawn(s.borderRightWidth, s.borderRightColor)) lines.push(r.right);
    if (drawn(s.borderLeftWidth, s.borderLeftColor)) lines.push(r.left);
    if (el.getAttribute("role") === "separator" && r.width <= 2) lines.push(r.left);
    for (const line of lines) if (line > 0.5 && line < x) found.push({ divider: name(el), x: Math.round(line), top: Math.round(r.top) });
    if (el.matches("button, a, input, h1, h2, [role=combobox]") && r.width > 4 && r.height > 4 && r.left < x - 0.5)
      found.push({ control: name(el), left: Math.round(r.left), top: Math.round(r.top) });
  }
  return found;
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

function reset() {
  deadline = Date.now() + Number(values.timeout);
  report = { checks: [], failure: "" };
  child = undefined;
  directory = undefined;
  socket = undefined;
  output = "";
  exited = "";
  pending.clear();
}

/** One full check against a freshly started app (or the attached one). Fills `report`. */
async function attempt() {
  reset();
  try {
    await checkWindow();
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    socket?.close();
    if (child?.pid && !exited) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The app already exited.
      }
      const stopped = () => !!exited;
      for (let waited = 0; waited < 5000 && !stopped(); waited += 100) await sleep(100);
      if (!stopped()) process.kill(-child.pid, "SIGKILL");
    }
    if (report.failure && output) report.output = output;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return report;
}

async function checkWindow() {
  let port = Number(values.port);
  if (!values.port) {
    directory = await mkdtemp(join(tmpdir(), "openmail-titlebar-"));
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    try {
      execFileSync(process.execPath, [join(root, "scripts/demo-data.mjs"), directory], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
      throw new Error("Seeding demo data failed", { cause: error });
    }
    port = 9200 + Math.floor(Math.random() * 500);
    child = launch(port);
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
  await evaluate(underLights);
  const lights = await evaluate("navigator.windowControlsOverlay.getTitlebarAreaRect().toJSON()");
  const under = `window.__underLights(${lights.x}, ${lights.y + lights.height})`;

  // Nothing crosses the lights at any width, across the narrow, medium and wide breakpoints, in
  // the mail view and the overview. The rail is narrower than the lights.
  // CI runners have a 1024x768 screen, less the menu bar, so every size is capped to what the
  // screen holds. Only widths are checked; heights just need to fit.
  const { availWidth: screenWidth, availHeight: screenHeight } = await evaluate(
    "({ availWidth: screen.availWidth, availHeight: screen.availHeight })",
  );
  if (screenWidth < 961)
    throw new Error(`The screen is ${screenWidth} px wide; the wide layout needs at least 961 px`);
  const wide = Math.min(1320, screenWidth);
  const tall = Math.min(860, screenHeight);
  const height = Math.min(720, screenHeight);
  const short = Math.min(700, screenHeight);
  const widths = [wide, 961, 960, 959, 880, 801, 800, 799, 640];
  const crossings = [];
  for (const view of ["Overview", "All accounts"]) {
    await evaluate(`window.resizeTo(880, ${height})`);
    await sleep(400);
    await evaluate(
      `[...document.querySelectorAll("[data-sidebar-rail] button")].find((b) => b.textContent.trim().startsWith("${view}"))?.click()`,
    );
    for (const width of widths) {
      await evaluate(`window.resizeTo(${width}, ${height})`);
      await sleep(400);
      // A tiling window manager or a small screen can hold the window at another width.
      const actual = await evaluate("outerWidth");
      if (actual !== width)
        throw new Error(`The window is ${actual} px wide after resizing it to ${width} px`);
      const found = await evaluate(under);
      if (found.length > 0) crossings.push({ view, width, found });
    }
  }
  const sweep = await evaluate(`(async () => {
    window.resizeTo(1000, ${height});
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stop = window.__titlebarFrames(() => ({ width: innerWidth, found: ${under} }));
    for (let width = 1000; width >= 760; width -= 16) {
      window.resizeTo(width, ${height});
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return stop().filter((frame) => frame.found.length > 0);
  })()`);
  report.checks.push({ name: "lights", widths, crossings, sweepFrames: sweep.slice(0, 5) });
  if (crossings.length > 0 || sweep.length > 0)
    throw new Error(`lights: ${crossings.length} widths and ${sweep.length} frames cross them`);

  // One pane at a time: the sidebar toggle and the search field share the lights' row.
  await evaluate(`window.resizeTo(600, ${short})`);
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
      window.resizeTo(width, ${short});
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
  await evaluate(`window.resizeTo(${wide}, ${tall})`);
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
}

// A shared runner sometimes drops a frame or starts the app slowly. The whole check runs again
// once on a fresh launch; only a failure on both attempts fails the run. The report keeps both.
const attempts = [await attempt()];
if (attempts[0].failure) {
  process.stderr.write(`The first attempt failed (${attempts[0].failure}); running it again.\n`);
  attempts.push(await attempt());
}
const failure = attempts.at(-1)?.failure ?? "";
const result = {
  attached: !!values.port,
  app: values.app ?? "preview",
  failure,
  retried: attempts.length > 1,
  attempts,
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (values.report) {
  await mkdir(dirname(resolvePath(values.report)), { recursive: true });
  await writeFile(values.report, json);
}
process.stdout.write(json);
if (failure) process.exitCode = 1;
