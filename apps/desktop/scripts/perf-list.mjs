// Measures the message list's transitions in a hidden development build over CDP.
// See docs/performance.md#message-list-transitions.
//
//   pnpm build
//   node apps/desktop/scripts/perf-list.mjs --db /tmp/copy/mail.db --runs 5 --out /tmp/list.json
//
// The database is copied into a fresh data directory first (as the smoke test does), so the
// source is never opened by the app. Windows stay hidden, sync is offline and no remote write runs.
import { connectCdp, listTargets } from "./cdp.mjs";
import { requireBuild, smokeEnvironment } from "./smoke-ui.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createSmokeCleanup, prepareSmokeDatabase } from "@openmail/core/node";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    home: { type: "string" },
    runs: { type: "string", default: "5" },
    launches: { type: "string", default: "1" },
    out: { type: "string" },
    actions: { type: "string" },
    label: { type: "string" },
    profile: { type: "string" },
    // A common word in the database: "weekly" for the 100k fixture.
    search: { type: "string", default: "the" },
    // Queries the typing action types, separated by "|", and the time between keys.
    type: { type: "string", default: "meeting|the|re" },
    "key-ms": { type: "string", default: "150" },
    // Runs the actions after every launch rather than only the first: each run starts cold.
    "every-launch": { type: "boolean", default: false },
    scope: { type: "string", default: "all" },
    "results-key": { type: "string", default: "ArrowDown" },
    // Records a renderer trace for the actions whose name contains this text.
    trace: { type: "string" },
    // Sidebar switches move the pointer onto the row this long before the click.
    hover: { type: "string", default: "0" },
    // Minutes of mixed list work for the soak action, which samples memory every 30 s.
    soak: { type: "string", default: "20" },
    // Runs the development server (electron-vite dev: React's development build, Vite's client).
    dev: { type: "boolean", default: false },
    // Changed events per minute for the stress action, sent as SetPrefs requests.
    rate: { type: "string", default: "300" },
    // The stress action changes a pref the window shows (shortcut set) or one it does not.
    "stress-pref": { type: "string", default: "neutral" },
    // Fails the run when the stress action retains render closures or more than 10 MB of heap.
    check: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});
// A missing build makes Electron show a native error box on screen before hidden windows apply.
requireBuild();
const runs = Number(values.runs);
const launches = Number(values.launches);
const only = values.actions ? new Set(values.actions.split(",")) : null;

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const median = (xs) => {
  const sorted = xs.filter((x) => typeof x === "number").toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Heap bytes in a snapshot summary. Compiled code grows while the JIT warms up; renders keep none. */
const heapKb = (counts) =>
  [...counts].reduce((sum, [name, v]) => (name === "(code)" ? sum : sum + v.bytes), 0) / 1024;

// Runs in every new document before the app: RPC frames, long tasks, DOM activity, first row.
const INSTRUMENT = `(() => {
  if (window.top !== window || window.__perf || !window.openmailRpc) return;
  const P = (window.__perf = { longtasks: [], lastActivity: 0, mutations: 0, firstRow: null });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) P.longtasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });
  const watch = () => new MutationObserver(() => {
    P.lastActivity = performance.now(); P.mutations++;
    if (P.firstRow === null && document.querySelector('[role="listbox"] [role="option"][data-id]')) {
      P.firstRow = performance.now(); P.firstRowWall = Date.now();
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) watch(); else document.addEventListener("DOMContentLoaded", watch);
})();`;

// Page-side helpers installed after load. measure() runs one action and reports its timings.
const HELPERS = `(() => {
  const P = window.__perf;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const listbox = () => document.querySelector('[data-mail-pane="list"]:not([hidden]) [role="listbox"]') ?? [...document.querySelectorAll('[role="listbox"]')].find((el) => !el.closest("[hidden]"));
  const rows = () => document.querySelectorAll('[role="listbox"] [role="option"][data-id]').length;
  const visibleRows = () => { const l = listbox(); return l ? l.querySelectorAll('[role="option"][data-id]').length : 0; };
  let mark = 0;
  window.__perfApi = {
    listbox, rows, visibleRows,
    button(text, root = document) {
      return [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text) && !b.closest("[hidden]"));
    },
    unreadRow(fallback) {
      const rows = [...listbox().querySelectorAll('[role="option"][data-id]')];
      const top = listbox().getBoundingClientRect().top;
      const shown = rows.filter((r) => r.getBoundingClientRect().top >= top);
      return shown.find((r) => / Unread(,|$)/.test(r.querySelector(".sr-only")?.textContent ?? "")) ?? shown[fallback];
    },
    async measure(name, act, ready, { quiet = 500, timeout = 20000 } = {}) {
      const before = listbox();
      const token = ++mark;
      if (before) before.__perfToken = token;
      const bodyBefore = before?.firstElementChild ?? null;
      const frameBefore = document.querySelector('[data-mail-pane="reader"] iframe');
      if (frameBefore) frameBefore.__perfToken = token;
      await frame();
      const t0 = performance.now();
      const t0Wall = Date.now();
      let maxRows = rows();
      act();
      const tAct = performance.now() - t0;
      while (!ready()) {
        await frame();
        maxRows = Math.max(maxRows, rows());
        if (performance.now() - t0 > timeout) return { name, error: "ready timeout" };
      }
      await frame();
      const ready_ = performance.now() - t0;
      const readyRows = visibleRows();
      for (;;) {
        await sleep(50);
        maxRows = Math.max(maxRows, rows());
        if (performance.now() - Math.max(P.lastActivity, t0) > quiet) break;
        if (performance.now() - t0 > timeout) break;
      }
      const end = Math.max(P.lastActivity, t0 + ready_);
      const tasks = P.longtasks.filter(([s, d]) => s + d >= t0 && s <= end + 50);
      const after = listbox();
      return {
        name,
        actMs: tAct,
        readyMs: ready_,
        settledMs: end - t0,
        longTaskMs: tasks.reduce((sum, [, d]) => sum + d, 0),
        maxLongTaskMs: tasks.reduce((max, [, d]) => Math.max(max, d), 0),
        t0Wall,
        resources: performance
          .getEntriesByType("resource")
          .filter((e) => e.startTime >= t0)
          .map((e) => [e.name.split("/").pop(), Math.round(e.startTime - t0), Math.round(e.duration)]),
        rowsAtReady: readyRows,
        maxRowsInDom: maxRows,
        listRemounted: !!before && (!after || after.__perfToken !== token),
        readerRemounted: !!frameBefore && document.querySelector('[data-mail-pane="reader"] iframe')?.__perfToken !== token,
        bodyRemounted: !!bodyBefore && after?.firstElementChild !== bodyBefore,
      };
    },
  };
  return "ok";
})()`;

// Main process: each RPC request's receipt and reply, by wall clock, plus pending requests.
const MAIN_RPC_LOG = `(() => {
  if (globalThis.__rpcLog) return "again";
  const { ipcMain, webContents } = require("electron");
  const L = (globalThis.__rpcLog = { req: new Map(), log: [] });
  const STREAMS = new Set(["Events", "Downloads"]);
  const parse = (f) => { try { const v = JSON.parse(f); return Array.isArray(v) ? v : [v]; } catch { return []; } };
  ipcMain.prependListener("openmail:rpc", (e, frame) => {
    for (const m of parse(frame)) if (m && m._tag === "Request" && !STREAMS.has(m.tag))
      L.req.set(e.sender.id + ":" + m.id, { tag: m.tag, start: Date.now(), hr: performance.now(), payload: JSON.stringify(m.payload ?? null).slice(0, 300) });
      else if (m && m._tag === "Interrupt") {
        const r = L.req.get(e.sender.id + ":" + m.requestId);
        if (r) r.interruptedAt = Date.now();
      }
  });
  const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0] ?? {});
  const patch = (target) => {
    const send = target.send;
    target.send = function (channel, ...args) {
      if (channel === "openmail:rpc" && typeof args[0] === "string")
        for (const m of parse(args[0])) if (m && m._tag === "Exit") {
          const key = this.id + ":" + m.requestId;
          const r = L.req.get(key);
          if (r) { L.req.delete(key); L.log.push({ tag: r.tag, start: r.start, end: Date.now(), ms: performance.now() - r.hr, bytes: args[0].length, payload: r.payload, interruptedAt: r.interruptedAt ?? null, exit: m.exit?._tag ?? null }); }
        }
      return send.call(this, channel, ...args);
    };
  };
  patch(proto.send ? proto : require("electron").webContents.prototype ?? proto);
  // Every SQLite statement over 20 ms on the main thread, with its SQL.
  L.sql = [];
  const { StatementSync } = process.getBuiltinModule("node:sqlite");
  for (const method of ["all", "get", "run", "iterate"]) {
    const original = StatementSync.prototype[method];
    StatementSync.prototype[method] = function (...args) {
      const start = performance.now();
      const cpu = process.cpuUsage();
      try { return original.apply(this, args); } finally {
        const ms = performance.now() - start;
        if (ms > 20) {
          const used = process.cpuUsage(cpu);
          L.sql.push({ at: Date.now(), ms: Math.round(ms), cpuMs: Math.round((used.user + used.system) / 1000), sql: String(this.sourceSQL).split(String.fromCharCode(10)).join(" ").replace(/ +/g, " ").slice(0, 4000) });
        }
      }
    };
  }
  return "ok";
})()`;

const searchOf = (r) => /"search":"((?:[^"\\]|\\.)*)"/.exec(r.payload)?.[1] ?? null;

async function launch(home, size) {
  const port = await freePort();
  const inspectPort = await freePort();
  const env = smokeEnvironment(process.env, home, false, "hidden");
  const spawnedAt = Date.now();
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(
    join(root, values.dev ? "node_modules/.bin/electron-vite" : "node_modules/.bin/electron"),
    values.dev
      ? [
          "dev",
          "--inspect",
          String(inspectPort),
          "--remoteDebuggingPort",
          String(port),
          "--",
          `--user-data-dir=${home}`,
          "--enable-automation",
        ]
      : [
          `--inspect=${inspectPort}`,
          ".",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${home}`,
          "--enable-automation",
        ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString()).slice(-8000);
  });
  // Attach to the browser before the window exists, so the instrumentation runs from the start.
  let version;
  for (let i = 0; i < 600 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(20);
    }
  }
  if (!version) throw new Error(`No DevTools endpoint\n${stderr}`);
  const browser = await connectCdp(version.webSocketDebuggerUrl, { callTimeoutMs: 30_000 });
  const attached = new Promise((resolve) => {
    browser.onEvent(async (message) => {
      if (message.method !== "Target.attachedToTarget") return;
      const { sessionId, targetInfo, waitingForDebugger } = message.params;
      let seq = 1e6;
      const call = (method, params = {}) =>
        browser.socket.send(JSON.stringify({ id: ++seq, sessionId, method, params }));
      process.stderr.write(`attached ${targetInfo.type} ${targetInfo.url} ${waitingForDebugger}\n`);
      if (targetInfo.type === "page") {
        call("Page.enable");
        call("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
        if (!targetInfo.url.startsWith("data:")) resolve(targetInfo.targetId);
      }
      if (waitingForDebugger) call("Runtime.runIfWaitingForDebugger");
    });
  });
  await browser.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  // A page that already loaded gets the script and reloads.
  const existing = (await listTargets(port)).find(
    (t) => t.type === "page" && /\/index\.html/.test(t.url),
  );
  const targetId = await Promise.race([
    attached,
    sleep(60_000).then(() => {
      throw new Error(`No page\n${stderr}`);
    }),
  ]);
  const target = (await listTargets(port)).find((t) => t.id === targetId);
  const cdp = await connectCdp(target.webSocketDebuggerUrl, { callTimeoutMs: 60_000 });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  if (existing) {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
    await cdp.send("Page.reload");
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 0,
    mobile: false,
  });
  // The main process: event-loop delay.
  let main = null;
  for (let i = 0; i < 100 && !main; i++) {
    const targets = await listTargets(inspectPort);
    if (targets[0])
      main = await connectCdp(targets[0].webSocketDebuggerUrl, { callTimeoutMs: 180_000 });
    else await sleep(50);
  }
  if (main) {
    await main.send("Runtime.enable");
    await main.send("Runtime.evaluate", {
      expression: `globalThis.__eld = process.getBuiltinModule("node:perf_hooks").monitorEventLoopDelay({ resolution: 5 }); globalThis.__eld.enable(); 1`,
    });
    // A hidden accessory app is a candidate for App Nap, which stretches main-process work several
    // times over on a loaded Mac. The person's app is in front, so the measurement keeps it awake.
    await main.send("Runtime.evaluate", {
      expression: `require("electron").powerSaveBlocker.start("prevent-app-suspension")`,
      includeCommandLineAPI: true,
    });
    for (let i = 0; i < 400; i++) {
      const { result } = await main.send("Runtime.evaluate", {
        expression: `require("electron").webContents.getAllWebContents().length > 0 ? ${MAIN_RPC_LOG} : "wait"`,
        includeCommandLineAPI: true,
        returnByValue: true,
      });
      if (result.value !== "wait") break;
      await sleep(10);
    }
  }
  return { child, cdp, main, browser, spawnedAt, home, stderr: () => stderr };
}

async function run(app, actions) {
  const { cdp, main } = app;
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        `${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`,
      );
    return result.result?.value;
  };
  const until = async (expression, label, timeout = 120_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error(
      `Timeout: ${label} ${JSON.stringify(await evaluate("({ href: location.href, rpc: typeof window.openmailRpc, perf: typeof window.__perf, rows: document.querySelectorAll('[role=option]').length })"))}`,
    );
  };
  try {
    await until(`!!window.__perf`, "instrumentation", 15_000);
  } catch {
    // The development server's page can load before the auto-attached script applies.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
    await cdp.send("Page.reload");
    await until(`!!window.__perf`, "instrumentation");
  }
  await until(
    `!!document.querySelector('[role="listbox"][aria-busy="false"] [role="option"][data-id]')`,
    "first rows",
  );
  const launchInfo = await evaluate(
    `({ firstRow: window.__perf.firstRow, firstRowWall: window.__perf.firstRowWall, wrap: window.__perf.wrap,
       longTaskMs: window.__perf.longtasks.filter(([s]) => s <= window.__perf.firstRow).reduce((a, [, d]) => a + d, 0) })`,
  );
  launchInfo.spawnToFirstRowMs = launchInfo.firstRowWall - app.spawnedAt;
  launchInfo.rpc = (await mainRpc(0)).log
    .filter((r) => r.start <= launchInfo.firstRowWall)
    .map((r) => [r.tag, Math.round(r.ms), r.bytes]);
  await sleep(3000);
  await evaluate(HELPERS);
  const mainDelay = async (reset) => {
    if (!main) return null;
    const { result } = await main.send("Runtime.evaluate", {
      expression: reset
        ? "globalThis.__eld.reset(), globalThis.__cpu0 = process.threadCpuUsage(), 0"
        : "(() => { const u = process.threadCpuUsage(globalThis.__cpu0); return [Math.round(globalThis.__eld.max / 1e5) / 10, Math.round((u.user + u.system) / 100) / 10]; })()",
      returnByValue: true,
    });
    return result.value;
  };
  const setSize = async (width) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 860,
      deviceScaleFactor: 0,
      mobile: false,
    });
    await sleep(800);
  };
  async function mainRpc(since) {
    if (!main) return { log: [], pending: [] };
    const { result } = await main.send("Runtime.evaluate", {
      expression: `(() => { const L = globalThis.__rpcLog; if (!L) return { log: [], pending: [] }; return { sql: (L.sql ?? []).filter((r) => r.at >= ${since}), log: L.log.filter((r) => r.start >= ${since}), pending: [...L.req.values()].filter((r) => r.start >= ${since}).map((r) => r.tag) }; })()`,
      returnByValue: true,
    });
    return result.value;
  }
  /** Runs one measured action; act/ready are page expressions. */
  const measure = async (name, act, ready, options = {}) => {
    const waited = Date.now();
    await mainDelay(true);
    if (Date.now() - waited > 500)
      process.stderr.write(`Main busy for ${Date.now() - waited} ms before ${name}\n`);
    process.stderr.write(`> ${name}\n`);
    const profiling =
      main && values.profile && values.profile !== "all" && name.includes(values.profile);
    if (profiling) {
      await main.send("Profiler.enable");
      await main.send("Profiler.setSamplingInterval", { interval: 200 });
      await main.send("Profiler.start");
    }
    const tracing = values.trace && name.includes(values.trace);
    const traceEvents = [];
    let stopListening = null;
    if (tracing) {
      stopListening = cdp.onEvent((message) => {
        if (message.method === "Tracing.dataCollected") traceEvents.push(...message.params.value);
      });
      await cdp.send("Tracing.start", {
        categories: "devtools.timeline,blink.user_timing,v8.execute",
        transferMode: "ReportEvents",
      });
    }
    const result = await evaluate(
      `window.__perfApi.measure(${JSON.stringify(name)}, () => { ${act} }, () => (${ready}), ${JSON.stringify(options)})`,
    );
    if (tracing) {
      const done = new Promise((resolve) => {
        const off = cdp.onEvent((message) => {
          if (message.method === "Tracing.tracingComplete") {
            off();
            resolve();
          }
        });
      });
      await cdp.send("Tracing.end");
      await done;
      stopListening?.();
      // Renderer main thread: time by event name over the action.
      const thread = traceEvents.find(
        (e) => e.name === "thread_name" && e.args?.name === "CrRendererMain",
      );
      const byName = {};
      for (const e of traceEvents)
        if (e.ph === "X" && thread && e.pid === thread.pid && e.tid === thread.tid && e.dur)
          byName[e.name] = (byName[e.name] ?? 0) + e.dur / 1000;
      result.trace = Object.fromEntries(
        Object.entries(byName)
          .filter(([, ms]) => ms >= 1)
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([k, ms]) => [k, Math.round(ms * 10) / 10]),
      );
    }
    [result.mainLoopMaxMs, result.mainCpuMs] = await mainDelay(false);
    if (profiling) {
      const { profile } = await main.send("Profiler.stop");
      const file = join(tmpdir(), `perf-list-main-${Date.now()}.cpuprofile`);
      await writeFile(file, JSON.stringify(profile));
      process.stderr.write(`Main profile: ${file}\n`);
    }
    const mainLog = await mainRpc(result.t0Wall);
    result.rpc = mainLog.log.map((r) => [r.tag, Math.round(r.ms * 10) / 10, r.bytes, r.payload]);
    result.pendingRpc = mainLog.pending;
    result.slowSql = mainLog.sql;
    const lastReply = Math.max(0, ...mainLog.log.map((r) => r.end - result.t0Wall));
    result.settledMs = Math.max(result.settledMs, lastReply);
    return result;
  };
  const api = "window.__perfApi";
  const listShown = `(${api}.visibleRows() > 0 && !${api}.listbox()?.closest("[hidden]") && ${api}.listbox()?.getAttribute("aria-busy") === "false")`;
  const MAILBOX = { Inbox: "inbox", Starred: "starred", "All Mail": "all" };
  const clickSidebar = (text) =>
    `document.querySelector('[data-mail-pane="sidebar"] [data-focus-key="mailbox:${MAILBOX[text]}"]').click()`;
  const titleIs = (text) =>
    `(${listShown} && ${api}.listbox()?.getAttribute("aria-label") === ${JSON.stringify(text)})`;
  const tiles = `[...document.querySelectorAll('[data-mail-pane="sidebar"] nav > div.grid button')]`;
  const accountTiles = await evaluate(`${tiles}.length`);
  const focusKeys = await evaluate(
    `[...document.querySelectorAll('[data-mail-pane="sidebar"] [data-focus-key]')].map((el) => el.dataset.focusKey)`,
  );
  const firstLabel = focusKeys.find((k) => k.startsWith("label:")) ?? null;
  process.stderr.write(
    `Account tiles ${accountTiles}; label ${firstLabel}; keys ${focusKeys.slice(0, 30).join(" ")}\n`,
  );
  const results = [];
  const want = (name) => actions && (!only || only.has(name));

  if (main && values.profile === "all" && actions) {
    await main.send("Profiler.enable");
    await main.send("Profiler.setSamplingInterval", { interval: 500 });
    await main.send("Profiler.start");
  }
  for (let i = 0; i < (actions ? runs : 0); i++) {
    // Wide: mailbox and account switches, scroll, search, settings.
    await setSize(1320);
    await evaluate(clickSidebar("Inbox"));
    await until(titleIs("Inbox"), "inbox");
    await sleep(400);
    if (want("mailbox")) {
      results.push(
        await measure("wide: Inbox → Starred", clickSidebar("Starred"), titleIs("Starred")),
      );
      results.push(
        await measure("wide: Starred → All Mail", clickSidebar("All Mail"), titleIs("All Mail")),
      );
      if (firstLabel)
        results.push(
          await measure(
            "wide: All Mail → label",
            `document.querySelector('[data-focus-key=${JSON.stringify(firstLabel)}]').click()`,
            `(${listShown} && ${api}.listbox()?.getAttribute("aria-label") !== "All Mail")`,
          ),
        );
      results.push(await measure("wide: → Inbox", clickSidebar("Inbox"), titleIs("Inbox")));
    }
    if (want("account") && accountTiles > 1) {
      results.push(
        await measure(
          "wide: All → one account",
          `${tiles}[1].click()`,
          `${listShown} && ${tiles}[1].getAttribute("aria-current") === "page"`,
        ),
      );
      await sleep(300);
      results.push(
        await measure(
          "wide: one account → All",
          `${tiles}[0].click()`,
          `${listShown} && ${tiles}[0].getAttribute("aria-current") === "page"`,
        ),
      );
    }
    if (want("scroll")) {
      // Load a few pages first, then scroll through them a viewport at a time.
      results.push(
        await measure(
          "wide: scroll 40 viewports",
          `(async () => { const l = ${api}.listbox(); for (let k = 0; k < 40; k++) { l.scrollTop += l.clientHeight; await new Promise((r) => requestAnimationFrame(r)); } window.__scrollDone = true; })()`,
          `window.__scrollDone === true`,
        ),
      );
      await evaluate(`window.__scrollDone = false; ${api}.listbox().scrollTop = 0`);
      await sleep(500);
    }
    if (want("open")) {
      results.push(
        await measure(
          "wide: open conversation",
          `${api}.unreadRow(2).click()`,
          `!!document.querySelector("article[data-message-id]")`,
        ),
      );
      results.push(
        await measure(
          "wide: Escape with conversation open",
          `document.activeElement?.blur(); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
          listShown,
        ),
      );
    }
    if (want("settings")) {
      await sleep(300);
      results.push(
        await measure(
          "wide: open Settings",
          `document.querySelector('[data-mail-pane="sidebar"] button[aria-label="Settings"]').click()`,
          `(() => { const d = document.querySelector('[role="dialog"][aria-label="Settings"]'); return !!d && d.querySelectorAll("button, input, select").length > 5; })()`,
        ),
      );
      await sleep(800);
      results.push(
        await measure(
          "wide: leave Settings",
          `document.querySelector('[role="dialog"][aria-label="Settings"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
          `!document.querySelector('[role="dialog"][aria-label="Settings"]') && ${listShown}`,
        ),
      );
    }
    if (want("search")) {
      await evaluate(
        `(() => { const f = document.querySelector('input[aria-label="Search mail"]'); f.focus(); })()`,
      );
      await cdp.send("Input.insertText", { text: values.search });
      await until(
        `${api}.listbox()?.getAttribute("aria-label") === "Search results" && ${listShown}`,
        "search results",
        30_000,
      );
      await sleep(1500);
      results.push(
        await measure(
          "wide: clear search → Inbox",
          `document.querySelector('button[aria-label="Clear search"]').click()`,
          titleIs("Inbox"),
        ),
      );
      // Nothing on screen changes now, so the main process should go quiet.
      results.push(
        await measure(
          "wide: idle 25 s after clearing search",
          `window.__idleStart = Date.now()`,
          `Date.now() - window.__idleStart > 25000`,
          { timeout: 40_000, quiet: 100 },
        ),
      );
    }
    // Typing: each query typed one character at a time at --key-ms, as a person does. Keys go out
    // on schedule whether or not the app kept up, so a blocked main process shows as input lag.
    if (want("typing")) {
      for (const text of values.type.split("|")) {
        await evaluate(`document.querySelector('button[aria-label="Clear search"]')?.click()`);
        await sleep(300);
        await evaluate(clickSidebar("Inbox"));
        await until(titleIs("Inbox"), "inbox before typing");
        const scopeName = values.scope === "folder" ? "Current folder" : "All Mail";
        const scopeLabel = `Search scope: ${scopeName}`;
        const scopeSet = await evaluate(`!!document.querySelector('[aria-label="${scopeLabel}"]')`);
        if (!scopeSet) {
          await evaluate(`document.querySelector('[aria-label^="Search scope:"]').click()`);
          const option = `[...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.trim() === ${JSON.stringify(scopeName)})`;
          await until(`!!(${option})`, "search scope option");
          await evaluate(`(${option}).click()`);
          await until(
            `!!document.querySelector('[aria-label="${scopeLabel}"]')`,
            "search scope set",
          );
        }
        await sleep(1500);
        await evaluate(`(() => {
          const f = document.querySelector('input[aria-label="Search mail"]');
          window.__typing = { input: [], rows: [] };
          if (!window.__typingObserver) {
            window.__typingObserver = new MutationObserver((records) => {
              if (records.some((r) => (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest?.('[role="listbox"]')))
                window.__typing.rows.push(Date.now());
            });
            window.__typingObserver.observe(document, { subtree: true, childList: true, characterData: true });
          }
          if (f.__typingListener !== true) {
            f.addEventListener("input", (e) => window.__typing.input.push([Date.now(), e.target.value]));
            f.__typingListener = true;
          }
          f.focus();
          return 1;
        })()`);
        await sleep(300);
        await mainDelay(true);
        const started = Date.now();
        const keyMs = Number(values["key-ms"]);
        const keys = [];
        const sends = [];
        // Code points, as a keyboard sends them; the queries are plain words and CJK.
        for (const ch of Array.from(text)) {
          const at = Date.now();
          keys.push(at);
          sends.push(cdp.send("Input.insertText", { text: ch }));
          await sleep(Math.max(0, keyMs - (Date.now() - at)));
        }
        await Promise.all(sends);
        const lastKey = keys.at(-1);
        let error = null;
        for (const deadline = Date.now() + 90_000; ;) {
          const pending = (await mainRpc(started)).pending;
          const state = await evaluate(
            `({ busy: ${api}.listbox()?.getAttribute("aria-busy"), label: ${api}.listbox()?.getAttribute("aria-label"), last: Math.max(0, ...window.__typing.rows) })`,
          );
          if (
            !pending.includes("Threads") &&
            state.busy === "false" &&
            state.label === "Search results" &&
            Date.now() - Math.max(state.last, lastKey) > 500
          )
            break;
          if (Date.now() > deadline) {
            error = "settle timeout";
            break;
          }
          await sleep(50);
        }
        const [loopMax, cpu] = await mainDelay(false);
        const { log, sql: slowSql } = await mainRpc(started);
        const page = await evaluate(`window.__typing`);
        const threads = log
          .filter(
            (r) => r.tag === "Threads" && searchOf(r) !== null && !r.payload.includes("messageIds"),
          )
          .map((r) => ({ ...r, search: searchOf(r) }));
        const final = threads.at(-1)?.search;
        const rowsAfter = (at) => page.rows.find((t) => t >= at) ?? null;
        const perRequest = threads.map((r) => {
          const key = keys.findLast((k) => k <= r.start) ?? started;
          const nextKey = keys.find((k) => k > key) ?? Infinity;
          const rowsAt = rowsAfter(r.end);
          return {
            search: r.search,
            mainMs: Math.round(r.ms),
            kb: Math.round(r.bytes / 1024),
            waitMs: Math.round(r.end - r.ms - key),
            toRowsMs: rowsAt === null ? null : rowsAt - key,
            interrupted: r.interruptedAt !== null || r.exit === "Failure",
            // Its reply came after the person typed on: rows for older text.
            stale: r.exit !== "Failure" && r.end > nextKey && r.search !== final,
          };
        });
        const finalReply = threads.findLast((r) => r.search === final);
        const finalRows = finalReply ? rowsAfter(finalReply.end) : null;
        const echo = page.input.map(([at], index) =>
          keys[index] === undefined ? null : at - keys[index],
        );
        const result = {
          name: `typing: ${text}`,
          error,
          readyMs: finalRows === null ? null : finalRows - lastKey,
          settledMs: Math.max(...page.rows, lastKey) - lastKey,
          mainLoopMaxMs: loopMax,
          mainCpuMs: cpu,
          mainCpuPerKeyMs: Math.round(cpu / keys.length),
          echoMaxMs: Math.max(0, ...echo.filter((x) => x !== null)),
          echoMedianMs: median(echo),
          started: threads.length,
          interrupted: perRequest.filter((r) => r.interrupted).length,
          stale: perRequest.filter((r) => r.stale).length,
          perRequest,
          slowSql,
          rpc: log.map((r) => [r.tag, Math.round(r.ms * 10) / 10, r.bytes, r.payload]),
        };
        process.stderr.write(`${JSON.stringify({ ...result, rpc: undefined })}\n`);
        results.push(result);
        // Enter submits and closes suggestions. Down then selects a result rather than a
        // contact suggestion; Enter into results follows the same handoff in the field.
        await evaluate(
          `document.querySelector('input[aria-label="Search mail"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`,
        );
        await sleep(300);
        // Down from the submitted field selects the first result and opens its match highlights.
        results.push(
          await measure(
            `typing: ${values["results-key"] === "Enter" ? "Enter" : "Down"} opens first result`,
            `document.querySelector('input[aria-label="Search mail"]').dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(values["results-key"])}, bubbles: true }))`,
            `!!document.querySelector('[data-mail-pane="reader"] article[data-message-id]')`,
          ),
        );
        await sleep(800);
        results.push(
          await measure(
            "typing: clear search → Inbox",
            `document.querySelector('button[aria-label="Clear search"]').click()`,
            titleIs("Inbox"),
          ),
        );
      }
    }
    // Stress: Changed events at --rate per minute (SetPrefs that alternate the shortcut set and the
    // menu-bar count, so the application menu and tray inputs change each time), counting the
    // native menu, Dock and badge calls the main process makes, with footprint every 30 s.
    if (want("stress")) {
      const { execFileSync } = await import("node:child_process");
      await main.send("Runtime.evaluate", {
        includeCommandLineAPI: true,
        expression: `(() => {
          const { app, Menu } = require("electron");
          const C = (globalThis.__nativeCalls = { appMenu: 0, dockMenu: 0, badge: 0, build: 0 });
          const wrap = (target, key, counter) => { const f = target[key].bind(target); target[key] = (...a) => { C[counter]++; return f(...a); }; };
          wrap(Menu, "setApplicationMenu", "appMenu");
          wrap(Menu, "buildFromTemplate", "build");
          if (app.dock) wrap(app.dock, "setMenu", "dockMenu");
          wrap(app, "setBadgeCount", "badge");
          return 1;
        })()`,
      });
      const pids = () =>
        execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
          .split("\n")
          .filter(
            (line) =>
              line.includes(app.home) &&
              !line.includes("electron-vite") &&
              !line.includes("cli.js"),
          )
          .map((line) => {
            const [pid, ...rest] = line.trim().split(/\s+/);
            const command = rest.join(" ");
            return { pid: Number(pid), type: /--type=([\w-]+)/.exec(command)?.[1] ?? "main" };
          });
      const footprintOf = (pid) => {
        try {
          const out = execFileSync("footprint", [String(pid)], { encoding: "utf8" });
          const m = /phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out);
          return m ? Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]] : 0;
        } catch {
          return 0;
        }
      };
      const samples = [];
      const start = Date.now();
      let sent = 0;
      const sample = async () => {
        const byType = {};
        for (const p of pids())
          byType[p.type] = Math.round((byType[p.type] ?? 0) + footprintOf(p.pid));
        const { result } = await main.send("Runtime.evaluate", {
          expression:
            "JSON.stringify({ calls: globalThis.__nativeCalls, mem: process.memoryUsage() })",
          returnByValue: true,
        });
        const { calls, mem } = JSON.parse(result.value);
        const heap = await cdp.send("Runtime.getHeapUsage");
        const row = {
          minutes: Math.round((Date.now() - start) / 600) / 100,
          sent,
          ...calls,
          footprintMb: byType,
          mainHeapMb: Math.round(mem.heapUsed / 1048576),
          mainExternalMb: Math.round(mem.external / 1048576),
          rendererHeapMb: Math.round(heap.usedSize / 1048576),
        };
        samples.push(row);
        process.stderr.write(`${JSON.stringify(row)}\n`);
      };
      const snapshot = async () => {
        await cdp.send("HeapProfiler.enable");
        await cdp.send("HeapProfiler.collectGarbage");
        const chunks = [];
        const off = cdp.onEvent((m) => {
          if (m.method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(m.params.chunk);
        });
        await cdp.send(
          "HeapProfiler.takeHeapSnapshot",
          { reportProgress: false },
          { timeoutMs: 300_000 },
        );
        off();
        const raw = chunks.join("");
        if (process.env.PERF_LIST_SNAPSHOT) await writeFile(process.env.PERF_LIST_SNAPSHOT, raw);
        const snap = JSON.parse(raw);
        const fields = snap.snapshot.meta.node_fields;
        const width = fields.length;
        const nameAt = fields.indexOf("name");
        const typeAt = fields.indexOf("type");
        const sizeAt = fields.indexOf("self_size");
        const types = snap.snapshot.meta.node_types[0];
        const counts = new Map();
        for (let at = 0; at < snap.nodes.length; at += width) {
          const type = types[snap.nodes[at + typeAt]];
          const name =
            type === "closure"
              ? `ƒ ${snap.strings[snap.nodes[at + nameAt]]}`
              : type === "object" || type === "native"
                ? snap.strings[snap.nodes[at + nameAt]]
                : `(${type})`;
          const entry = counts.get(name) ?? { count: 0, bytes: 0 };
          entry.count++;
          entry.bytes += snap.nodes[at + sizeAt];
          counts.set(name, entry);
        }
        return counts;
      };
      await sample();
      const firstSnapshot = await snapshot();
      const gap = 60_000 / Number(values.rate);
      let lastSample = Date.now();
      while (Date.now() - start < Number(values.soak) * 60_000) {
        const set = sent % 2 === 0 ? "apple" : "mimestream";
        const patch =
          values["stress-pref"] === "shortcuts"
            ? `{ shortcutSet: "${set}", menuBarUnreadCount: ${sent % 2 === 0} }`
            : `{ undoSendSeconds: ${sent % 2 === 0 ? 5 : 10} }`;
        await evaluate(
          `window.openmailRpc.send(JSON.stringify({ _tag: "Request", id: "9${String(sent).padStart(8, "0")}", tag: "SetPrefs", payload: { patch: ${patch} }, headers: [] }))`,
        );
        sent++;
        await sleep(gap);
        if (Date.now() - lastSample >= 30_000) {
          lastSample = Date.now();
          await sample();
        }
      }
      await sample();
      const lastSnapshot = await snapshot();
      const growth = [...lastSnapshot]
        .map(([name, { count, bytes }]) => {
          const before = firstSnapshot.get(name) ?? { count: 0, bytes: 0 };
          return {
            name,
            count: count - before.count,
            kb: Math.round((bytes - before.bytes) / 1024),
          };
        })
        .filter((g) => g.count > 0)
        .toSorted((a, b) => b.kb - a.kb)
        .slice(0, 40);
      process.stderr.write(`Heap growth: ${JSON.stringify(growth)}\n`);
      // A closure that gains a copy for every few events is a render's closure kept alive, the
      // chain docs/performance.md#memory-across-renders describes.
      const retained = growth.filter((g) => g.name.startsWith("ƒ ") && g.count >= sent / 4);
      const retainedKb = heapKb(lastSnapshot) - heapKb(firstSnapshot);
      process.stderr.write(
        `Retained after ${sent} changes: ${Math.round(retainedKb)} KB; render closures kept: ${retained.map((g) => `${g.name}×${g.count}`).join(", ") || "none"}\n`,
      );
      if (values.check && (retained.length > 0 || retainedKb > 10_240)) process.exitCode = 1;
      results.push({ name: "stress", samples, growth, retainedKb, retained });
    }
    // Soak: mailbox and account switches, opened threads, a search left in the cache and idle
    // periods, with every process's memory sampled every 30 s.
    if (want("soak")) {
      const { execFileSync } = await import("node:child_process");
      const footprint = (pid) => {
        try {
          const out = execFileSync("footprint", [String(pid)], { encoding: "utf8" });
          const match = /phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out);
          if (!match) return null;
          return Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]];
        } catch {
          return null;
        }
      };
      const processes = () =>
        execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" })
          .split("\n")
          .filter((line) => line.includes(`--user-data-dir=${app.home}`) || line.includes(app.home))
          .map((line) => {
            const [pid, rss, ...rest] = line.trim().split(/\s+/);
            const command = rest.join(" ");
            const type =
              /--type=([\w-]+)/.exec(command)?.[1] ??
              (command.includes("cli.js") ? "launcher" : "main");
            const sub = /--utility-sub-type=([\w.]+)/.exec(command)?.[1];
            return {
              pid: Number(pid),
              type: sub ? `${type}:${sub.split(".").at(-2)}` : type,
              rssMb: Number(rss) / 1024,
            };
          })
          .filter((p) => p.type !== "launcher");
      const sample = async (label) => {
        const list = processes();
        const byType = {};
        for (const p of list)
          byType[p.type] = (byType[p.type] ?? 0) + (footprint(p.pid) ?? p.rssMb);
        const { result } = await main.send("Runtime.evaluate", {
          expression: "JSON.stringify(process.memoryUsage())",
          returnByValue: true,
        });
        const mainMemory = JSON.parse(result.value);
        const heap = await cdp.send("Runtime.getHeapUsage");
        const dom = await evaluate(`document.getElementsByTagName("*").length`);
        const row = {
          label,
          minutes: Math.round((Date.now() - soakStart) / 600) / 100,
          footprintMb: Object.fromEntries(
            Object.entries(byType).map(([k, v]) => [k, Math.round(v)]),
          ),
          mainHeapMb: Math.round(mainMemory.heapUsed / 1048576),
          mainExternalMb: Math.round(mainMemory.external / 1048576),
          mainArrayBuffersMb: Math.round(mainMemory.arrayBuffers / 1048576),
          mainRssMb: Math.round(mainMemory.rss / 1048576),
          rendererHeapMb: Math.round(heap.usedSize / 1048576),
          domNodes: dom,
        };
        samples.push(row);
        process.stderr.write(`${JSON.stringify(row)}\n`);
      };
      const samples = [];
      const soakStart = Date.now();
      await setSize(1320);
      await evaluate(`document.querySelector('input[aria-label="Search mail"]').focus()`);
      await cdp.send("Input.insertText", { text: values.search });
      await sleep(4000);
      await evaluate(`document.querySelector('button[aria-label="Clear search"]').click()`);
      await sample("start");
      const soakTiles = `[...document.querySelectorAll('[data-mail-pane="sidebar"] nav > div.grid button')]`;
      const steps = [
        () => clickSidebar("Starred"),
        () => clickSidebar("All Mail"),
        () => `${soakTiles}[1]?.click()`,
        () => clickSidebar("Inbox"),
        () => `${api}.unreadRow(1)?.click()`,
        () => `${soakTiles}[2]?.click()`,
        () => `${api}.unreadRow(2)?.click()`,
        () => `${soakTiles}[0]?.click()`,
        () => `${api}.unreadRow(0)?.click()`,
      ];
      let k = 0;
      let lastSample = Date.now();
      while (Date.now() - soakStart < Number(values.soak) * 60_000) {
        await evaluate(steps[k++ % steps.length]());
        await sleep(k % 40 === 0 ? 15_000 : 1200);
        if (Date.now() - lastSample >= 30_000) {
          lastSample = Date.now();
          await sample(`step ${k}`);
        }
      }
      await sample("end");
      results.push({ name: "soak", samples });
    }
    // Sidebar switches: each view once cold (first visit in this launch), then once warm.
    if (want("switch")) {
      await setSize(1320);
      await evaluate(clickSidebar("Inbox"));
      await until(titleIs("Inbox"), "inbox");
      const nav = `document.querySelector('[data-mail-pane="sidebar"]:not([data-sidebar-rail]) nav[aria-label="Mailboxes"]')`;
      const views = await evaluate(`(() => {
        const nav = ${nav};
        const keys = ["starred", "sent", "drafts", "all", "important", "inbox"].map((id) => "[data-focus-key='mailbox:" + id + "']");
        const tiles = [...nav.querySelectorAll(":scope > div.grid button")].map((_, i) => ":scope > div.grid button:nth-of-type(" + (i + 1) + ")");
        return [...keys, ...tiles.slice(1), tiles[0]].filter(Boolean);
      })()`);
      const settledList = `(() => { const l = ${api}.listbox(); return !!l && l.getAttribute("aria-busy") === "false" && !l.querySelector("[data-stale]"); })()`;
      for (const pass of i === 0 ? ["cold", "warm"] : ["warm"])
        for (const selector of views) {
          const el = `${nav}.querySelector(${JSON.stringify(selector)})`;
          const label = await evaluate(
            `(${el}?.textContent ?? "").trim().split(/\\s+/).slice(0, 2).join(" ")`,
          );
          const kind = selector.includes("mailbox:") ? "mailbox" : "account";
          await sleep(300);
          if (Number(values.hover) > 0) {
            await evaluate(
              `${el}.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); ${el}.dispatchEvent(new PointerEvent("pointerenter"))`,
            );
            await sleep(Number(values.hover));
          }
          results.push(
            await measure(
              `switch ${pass}: ${kind}`,
              `const el = ${el}; el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); el.click()`,
              `${el}?.getAttribute("aria-current") === "page" && ${settledList}`,
              { quiet: 300 },
            ),
          );
          results.at(-1).view = label;
        }
    }
    // The sidebar: hidden and shown again while docked (wide), and the drawer (medium width).
    if (want("sidebar")) {
      await setSize(1320);
      const docked = `document.querySelector('[data-mail-pane="sidebar"]:not([data-sidebar-rail]) nav[aria-label="Mailboxes"]')`;
      if (!(await evaluate(`!!document.querySelector("article[data-message-id]")`))) {
        await evaluate(`${api}.unreadRow(1).click()`);
        await until(`!!document.querySelector("article[data-message-id]")`, "reader");
      }
      await until(`!!${docked}`, "docked sidebar");
      await sleep(800);
      const toggleKey = `document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", altKey: true, shiftKey: true, metaKey: true, bubbles: true }))`;
      results.push(await measure("wide: hide docked sidebar", toggleKey, `!${docked}`));
      await sleep(800);
      results.push(
        await measure(
          "wide: show docked sidebar (button)",
          `document.querySelector('button[aria-label="Show sidebar"]').click()`,
          `!!${docked}`,
        ),
      );
      await sleep(800);
      await setSize(880);
      const drawer = `[...document.querySelectorAll('[data-mail-pane="sidebar"] nav[aria-label="Mailboxes"]')].find((el) => el.closest('[role="dialog"]') && el.getBoundingClientRect().width > 100)`;
      await until(`!!document.querySelector('button[aria-label="Show sidebar"]')`, "rail");
      await sleep(800);
      results.push(
        await measure(
          "medium: open sidebar drawer",
          `document.querySelector('button[aria-label="Show sidebar"]').click()`,
          `!!(${drawer})`,
        ),
      );
      await sleep(500);
      await evaluate(
        `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
      );
      await sleep(800);
      await setSize(1320);
    }
    // Many loaded rows: scroll until about 2000 threads are loaded, then open unread mail at the
    // top, so marking it read refreshes the whole loaded extent.
    if (want("deep")) {
      await setSize(1320);
      await evaluate(clickSidebar("Inbox"));
      await until(titleIs("Inbox"), "inbox");
      const loaded = await evaluate(`(async () => {
        const l = ${api}.listbox();
        const rowHeight = l.querySelector('[role="option"]').getBoundingClientRect().height;
        let last = 0, still = 0;
        for (let k = 0; k < 600 && l.firstElementChild.scrollHeight / rowHeight < 2000; k++) {
          l.scrollTop = l.scrollHeight;
          await new Promise((r) => setTimeout(r, 60));
          const h = l.scrollHeight;
          still = h === last ? still + 1 : 0;
          last = h;
          if (still > 40) break;
        }
        const rows = Math.round(l.firstElementChild.scrollHeight / rowHeight);
        l.scrollTop = 0;
        return rows;
      })()`);
      await sleep(1500);
      for (let k = 0; k < 2; k++) {
        results.push(
          await measure(
            `deep: open unread (~${Math.round(loaded / 100) * 100} loaded)`,
            `${api}.unreadRow(2 + ${k}).click()`,
            `!!document.querySelector("article[data-message-id]")`,
            { quiet: 1500 },
          ),
        );
        await sleep(500);
      }
    }
    // Narrow: open a conversation, then go back.
    if (want("narrow")) {
      await setSize(700);
      await evaluate(`document.querySelector('button[aria-label="Back to messages"]')?.click()`);
      await until(listShown, "narrow list");
      for (const [how, act] of [
        ["Back button", `document.querySelector('button[aria-label="Back to messages"]').click()`],
        [
          "Escape",
          `document.querySelector('[data-mail-pane="reader"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
        ],
        [
          "⌘[",
          `document.querySelector('[data-mail-pane="reader"]').dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, bubbles: true }))`,
        ],
      ]) {
        await sleep(300);
        results.push(
          await measure(
            "narrow: open conversation",
            `${api}.unreadRow(3).click()`,
            `!!document.querySelector('[data-mail-pane="reader"] article[data-message-id]')`,
          ),
        );
        await sleep(600);
        results.push(await measure(`narrow: back (${how})`, act, listShown));
      }
    }
  }
  if (main && values.profile === "all" && actions) {
    const { profile } = await main.send("Profiler.stop");
    const file = join(tmpdir(), `perf-list-main-all-${Date.now()}.cpuprofile`);
    await writeFile(file, JSON.stringify(profile));
    process.stderr.write(`Main profile: ${file}\n`);
  }
  return { launch: launchInfo, results };
}

const summaries = [];
const allLaunches = [];
for (let l = 0; l < launches; l++) {
  const home = values.home ?? (await mkdtemp(join(tmpdir(), "openmail-perf-list-")));
  if (!existsSync(join(home, "mail.db"))) {
    if (!values.db) throw new Error("--db or --home with a mail.db is required");
    prepareSmokeDatabase(values.db, home);
  }
  const app = await launch(home, { width: 1320, height: 860 });
  const cleanup = createSmokeCleanup({
    directory: home,
    keepDirectory: values.keep || !!values.home,
    child: () => app.child,
    socket: () => app.cdp.socket,
  });
  try {
    const result = await run(app, l === 0 || values["every-launch"]);
    allLaunches.push(result);
    process.stderr.write(
      `Launch ${l + 1}: first row ${Math.round(result.launch.spawnToFirstRowMs)} ms\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack}\n${app.stderr()}\n`);
    process.exitCode = 1;
  } finally {
    // Quit cleanly: a killed app counts as a crash and the next launch asks about safe mode.
    await app.main
      ?.send("Runtime.evaluate", {
        expression: 'require("electron").app.quit()',
        includeCommandLineAPI: true,
      })
      .catch(() => null);
    for (let i = 0; i < 200 && app.child.exitCode === null && app.child.signalCode === null; i++)
      await sleep(50);
    app.main?.close();
    app.browser.close();
    await cleanup();
    if (!values.home && !values.keep) await rm(home, { recursive: true, force: true });
  }
}

const results = allLaunches.flatMap((l) => l.results);
const names = [...new Set(results.map((r) => r.name))];
for (const name of names) {
  const xs = results.filter((r) => r.name === name);
  const rpcCounts = {};
  for (const r of xs) for (const [tag] of r.rpc ?? []) rpcCounts[tag] = (rpcCounts[tag] ?? 0) + 1;
  for (const tag of Object.keys(rpcCounts))
    rpcCounts[tag] = Math.round((rpcCounts[tag] / xs.length) * 10) / 10;
  summaries.push({
    name,
    n: xs.length,
    readyMs: median(xs.map((r) => r.readyMs)),
    settledMs: median(xs.map((r) => r.settledMs)),
    longTaskMs: median(xs.map((r) => r.longTaskMs)),
    maxLongTaskMs: median(xs.map((r) => r.maxLongTaskMs)),
    mainLoopMaxMs: median(xs.map((r) => r.mainLoopMaxMs)),
    mainCpuMs: median(xs.map((r) => r.mainCpuMs)),
    maxRowsInDom: Math.max(...xs.map((r) => r.maxRowsInDom ?? 0)),
    listRemounted: xs.filter((r) => r.listRemounted).length,
    readerRemounted: xs.filter((r) => r.readerRemounted).length,
    bodyRemounted: xs.filter((r) => r.bodyRemounted).length,
    rpcPerRun: rpcCounts,
    rpcMaxMs: median(xs.map((r) => Math.max(0, ...(r.rpc ?? []).map(([, ms]) => ms)))),
    ...(xs[0]?.perRequest
      ? {
          mainCpuPerKeyMs: median(xs.map((r) => r.mainCpuPerKeyMs)),
          echoMaxMs: median(xs.map((r) => r.echoMaxMs)),
          echoMedianMs: median(xs.map((r) => r.echoMedianMs)),
          queriesStarted: median(xs.map((r) => r.started)),
          queriesInterrupted: median(xs.map((r) => r.interrupted)),
          queriesStale: median(xs.map((r) => r.stale)),
          queryMainMs: median(xs.flatMap((r) => r.perRequest.map((q) => q.mainMs))),
          queryToRowsMs: median(xs.flatMap((r) => r.perRequest.map((q) => q.toRowsMs))),
        }
      : {}),
    errors: xs.filter((r) => r.error).length,
  });
}
summaries.push({
  name: "launch: spawn → first row painted",
  n: allLaunches.length,
  readyMs: median(allLaunches.map((l) => l.launch.spawnToFirstRowMs)),
  rendererFirstRowMs: median(allLaunches.map((l) => l.launch.firstRow)),
  longTaskMs: median(allLaunches.map((l) => l.launch.longTaskMs)),
  rpc: allLaunches[0]?.launch.rpc,
});
const report = {
  label: values.label ?? "",
  scope: values.scope,
  db: values.db ?? values.home,
  summaries,
  launches: allLaunches,
};
if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2));
for (const s of summaries)
  process.stdout.write(
    `${s.name.padEnd(40)} ready ${String(Math.round(s.readyMs ?? -1)).padStart(6)}  settled ${String(Math.round(s.settledMs ?? -1)).padStart(6)}  long ${String(Math.round(s.longTaskMs ?? -1)).padStart(5)}  maxLT ${String(Math.round(s.maxLongTaskMs ?? -1)).padStart(5)}  mainBlk ${String(s.mainLoopMaxMs ?? "-").padStart(6)}  mainCpu ${String(s.mainCpuMs ?? "-").padStart(6)}  rows ${String(s.maxRowsInDom ?? "-").padStart(4)}  remount ${s.listRemounted ?? "-"}/${s.bodyRemounted ?? "-"}  ${JSON.stringify(s.rpcPerRun ?? s.rpc)}${s.queriesStarted === undefined ? "" : `  perKeyCpu ${s.mainCpuPerKeyMs} echoMax ${s.echoMaxMs} queries ${s.queriesStarted}/int ${s.queriesInterrupted}/stale ${s.queriesStale} queryMain ${s.queryMainMs} queryToRows ${s.queryToRowsMs}`}\n`,
  );
