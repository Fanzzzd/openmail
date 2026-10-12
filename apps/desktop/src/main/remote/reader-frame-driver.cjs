// Electron script for reader-frame.test.ts: opens each case's message in the
// built web app, records every height the message frame is drawn at, and
// measures the page inside it. Usage: electron reader-frame-driver.cjs <config.json> <out.json>
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");

const [configPath, outPath] = process.argv.slice(-2);
const { url, dark, cases, others } = JSON.parse(fs.readFileSync(configPath, "utf8"));
// Keep running between windows; quit only when done.
app.on("window-all-closed", () => null);
const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// In the reader page: draw-time heights of every message frame, by phase.
const RECORDER = `(() => {
  window.__heights = [];
  window.__phase = 0;
  window.__frames = window.__frames ?? 0;
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries)
      window.__heights.push({ frame: entry.target.__id, phase: window.__phase, t: performance.now(),
        h: Math.round(entry.target.getBoundingClientRect().height * 10) / 10 });
  });
  const watch = () => {
    for (const frame of document.querySelectorAll('iframe[title="Message"]'))
      if (!frame.__id) { frame.__id = ++window.__frames; observer.observe(frame); }
  };
  watch();
  new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
})()`;

// The page's full extent and sideways reach, measured independently of the reader's code.
const MEASURE = `(() => {
  const frames = [...document.querySelectorAll('[data-reader-text] iframe[title="Message"]')];
  const frame = frames.at(-1);
  const doc = frame.contentDocument, root = doc.documentElement, view = doc.defaultView;
  // Every box and line of text the page can scroll to: what an overflow:hidden box clips is out.
  const boxes = [root.getBoundingClientRect()];
  const range = doc.createRange();
  const visit = (parent) => {
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) {
        range.selectNode(node);
        boxes.push(range.getBoundingClientRect());
      } else if (node.nodeType === 1) {
        const style = view.getComputedStyle(node);
        if (style.display === "none" || style.position === "fixed") continue;
        boxes.push(node.getBoundingClientRect());
        if (style.overflowX === "visible" && style.overflowY === "visible") visit(node);
      }
    }
  };
  visit(doc.body);
  const drawn = boxes.filter((r) => r.width || r.height);
  const scroller = doc.scrollingElement;
  const left = scroller.scrollLeft;
  scroller.scrollLeft = 1e6;
  const reach = scroller.scrollLeft;
  scroller.scrollLeft = left;
  const pane = document.querySelector("[data-reader-text]");
  const paneLeft = pane.scrollLeft;
  pane.scrollLeft = 1e6;
  const paneReach = pane.scrollLeft;
  pane.scrollLeft = paneLeft;
  return {
    id: frame.__id,
    frame: frame.getBoundingClientRect().height,
    extent: Math.max(...drawn.map((r) => r.bottom)) + view.scrollY,
    right: Math.max(...drawn.map((r) => r.right)) + left,
    clientWidth: root.clientWidth,
    bar: view.innerHeight - root.clientHeight,
    reach,
    paneReach,
    zoom: root.style.zoom,
    wideButton: [...pane.querySelectorAll("button")].some((b) => /View at 100%|Fit to width/.test(b.textContent)),
  };
})()`;

const clickText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((e) => e.getClientRects().length && e.textContent.includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
})()`;

/** Steps run inside the last message frame's document, as the user or a late image would. */
const STEPS = {
  viewAt100: clickText("button", "View at 100%"),
  showQuotes: clickText("button", "Show quoted text"),
  growImage: `(() => {
    const doc = [...document.querySelectorAll('[data-reader-text] iframe[title="Message"]')].at(-1).contentDocument;
    const canvas = document.createElement("canvas");
    canvas.width = 100; canvas.height = 400;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#3a6"; ctx.fillRect(0, 0, 100, 400);
    doc.getElementById("grow").src = canvas.toDataURL("image/png");
    return true;
  })()`,
};

async function paneWidth(win) {
  return win.webContents.executeJavaScript(
    `document.querySelector("[data-reader-text]")?.clientWidth ?? 0`,
  );
}

async function main() {
  const results = [];
  try {
    if (dark) nativeTheme.themeSource = "dark";
    const win = new BrowserWindow({ width: 1300, height: 1600, show: false });
    for (let attempt = 0; ; attempt++) {
      try {
        await win.loadURL(url);
        break;
      } catch (error) {
        if (attempt > 3) throw error;
        await wait(500);
      }
    }
    const js = (code) => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 80 && !(await js(`!!document.querySelector("[data-id]")`)); i++)
      await wait(250);
    const open = async (subject) => {
      for (let i = 0; i < 40; i++) {
        if (await js(clickText("[data-id]", subject))) return;
        await wait(250);
      }
      throw new Error(`no row for ${subject}`);
    };
    // Window widths that give each pane width, found by opening the first message.
    const widths = new Map();
    for (const pane of new Set(cases.map((c) => c.pane))) {
      let width = pane + 700;
      await open(others[0]);
      for (let k = 0; k < 6; k++) {
        win.setContentSize(width, 1600);
        await wait(600);
        const diff = pane - (await paneWidth(win));
        if (diff === 0) break;
        width += diff;
      }
      widths.set(pane, width);
    }
    for (const c of cases) {
      win.setContentSize(widths.get(c.pane), 1600);
      // Another message first, so this one's frame is created under the recorder.
      await open(others.find((other) => other !== c.subject));
      await wait(400);
      await js(RECORDER);
      await open(c.subject);
      for (let i = 0; i < 40; i++) {
        const ready =
          await js(`(() => { const f = [...document.querySelectorAll('[data-reader-text] iframe[title="Message"]')].at(-1);
          return !!f && !!f.contentDocument?.body?.textContent.includes(${JSON.stringify(c.marker)}); })()`);
        if (ready) break;
        await wait(100);
      }
      await wait(1500);
      for (const [index, step] of (c.steps ?? []).entries()) {
        await js(`window.__phase = ${index + 1}`);
        if (!(await js(STEPS[step]))) {
          const buttons = await js(
            `[...document.querySelectorAll("[data-reader-text] button")].map((b) => b.textContent).join("|")`,
          );
          throw new Error(`${c.name}: step ${step} failed; buttons: ${buttons}`);
        }
        await wait(1500);
      }
      const settled = await js(`performance.now()`);
      await wait(1000);
      const measured = await js(MEASURE);
      const heights = (await js(`window.__heights`)).filter((h) => h.frame === measured.id);
      results.push({ name: c.name, pane: await paneWidth(win), settled, heights, ...measured });
    }
    win.destroy();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
  app.quit();
}
app.on("ready", () => void main());
