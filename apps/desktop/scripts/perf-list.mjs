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
        rowsAtReady: readyRows,
        maxRowsInDom: maxRows,
        listRemounted: !!before && (!after || after.__perfToken !== token),
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
  });
  const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0] ?? {});
  const patch = (target) => {
    const send = target.send;
    target.send = function (channel, ...args) {
      if (channel === "openmail:rpc" && typeof args[0] === "string")
        for (const m of parse(args[0])) if (m && m._tag === "Exit") {
          const key = this.id + ":" + m.requestId;
          const r = L.req.get(key);
          if (r) { L.req.delete(key); L.log.push({ tag: r.tag, start: r.start, end: Date.now(), ms: performance.now() - r.hr, bytes: args[0].length, payload: r.payload }); }
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

async function launch(home, size) {
  const port = await freePort();
  const inspectPort = await freePort();
  const env = smokeEnvironment(process.env, home, false, "hidden");
  const spawnedAt = Date.now();
  const child = spawn(
    join(fileURLToPath(new URL("..", import.meta.url)), "node_modules/.bin/electron"),
    [
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
  return { child, cdp, main, browser, spawnedAt, stderr: () => stderr };
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
  await until(`!!window.__perf`, "instrumentation");
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
    const result = await evaluate(
      `window.__perfApi.measure(${JSON.stringify(name)}, () => { ${act} }, () => (${ready}), ${JSON.stringify(options)})`,
    );
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
      await evaluate(
        `document.querySelector('[data-mail-pane="sidebar"] button[aria-label="Settings"]').click()`,
      );
      await until(`!!document.querySelector('[role="dialog"][aria-label="Settings"]')`, "settings");
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
    const result = await run(app, l === 0);
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
    bodyRemounted: xs.filter((r) => r.bodyRemounted).length,
    rpcPerRun: rpcCounts,
    rpcMaxMs: median(xs.map((r) => Math.max(0, ...(r.rpc ?? []).map(([, ms]) => ms)))),
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
  db: values.db ?? values.home,
  summaries,
  launches: allLaunches,
};
if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2));
for (const s of summaries)
  process.stdout.write(
    `${s.name.padEnd(40)} ready ${String(Math.round(s.readyMs ?? -1)).padStart(6)}  settled ${String(Math.round(s.settledMs ?? -1)).padStart(6)}  long ${String(Math.round(s.longTaskMs ?? -1)).padStart(5)}  maxLT ${String(Math.round(s.maxLongTaskMs ?? -1)).padStart(5)}  mainBlk ${String(s.mainLoopMaxMs ?? "-").padStart(6)}  mainCpu ${String(s.mainCpuMs ?? "-").padStart(6)}  rows ${String(s.maxRowsInDom ?? "-").padStart(4)}  remount ${s.listRemounted ?? "-"}/${s.bodyRemounted ?? "-"}  ${JSON.stringify(s.rpcPerRun ?? s.rpc)}\n`,
  );
