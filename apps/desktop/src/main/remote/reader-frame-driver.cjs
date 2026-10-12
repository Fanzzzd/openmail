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

// The current find hit's box in the thread pane's coordinates, and the frame's own vertical scroll.
const HIT = `(() => {
  const pane = document.querySelector("[data-reader-text]");
  const frame = [...pane.querySelectorAll('iframe[title="Message"]')].at(-1);
  const doc = frame.contentDocument;
  const mark = [...doc.querySelectorAll("mark")].find((m) => m.style.background.includes("251, 146, 60"));
  if (!mark) return null;
  const f = frame.getBoundingClientRect(), m = mark.getBoundingClientRect(), p = pane.getBoundingClientRect();
  return { top: f.top + m.top - p.top, bottom: f.top + m.bottom - p.top, pane: pane.clientHeight,
    frameScroll: doc.scrollingElement.scrollTop };
})()`;

/** Opens find on the last message, as ⌘F does, and types `term`. */
const find = (term) => `(async () => {
  const pane = document.querySelector("[data-reader-text]");
  const message = [...pane.querySelectorAll("[data-message-id]")].at(-1) ?? pane;
  message.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, bubbles: true }));
  let input = null;
  for (let i = 0; i < 40 && !input; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    input = document.querySelector('input[aria-label="Find in message"]');
  }
  if (!input) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(term)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

/** Clicks a button without scrolling to it first, as a click on the sticky find bar does. */
const press = (text) => `(() => {
  const button = [...document.querySelectorAll("[data-reader-text] button")].find((b) => b.textContent === ${JSON.stringify(text)});
  if (!button || button.disabled) return false;
  button.click();
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
  find: (c) => find(c.find),
  findNext: press("Next match"),
  findPrevious: press("Previous match"),
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
    // Until no frame has been drawn at a new height for QUIET ms.
    const QUIET = 300;
    const settle = async (name) => {
      const start = Date.now();
      let count = -1;
      let since = start;
      for (;;) {
        const now = Date.now();
        const next = await js(`window.__heights.length`);
        if (next !== count) [count, since] = [next, now];
        else if (now - since >= QUIET) return;
        if (now - start > 10_000) throw new Error(`${name}: frame height never settled`);
        await wait(50);
      }
    };
    // Until the pane's width holds for two readings in a row.
    const settleWidth = async () => {
      let last = -1;
      for (let i = 0; i < 40; i++) {
        await wait(100);
        const width = await paneWidth(win);
        if (width === last) return width;
        last = width;
      }
      return last;
    };
    // Window widths that give each pane width, found by opening the first message.
    const widths = new Map();
    for (const pane of new Set(cases.map((c) => c.pane))) {
      let width = pane + 700;
      await open(others[0]);
      for (let k = 0; k < 6; k++) {
        win.setContentSize(width, 1600);
        const diff = pane - (await settleWidth());
        if (diff === 0) break;
        width += diff;
      }
      widths.set(pane, width);
    }
    for (const c of cases) {
      win.setContentSize(widths.get(c.pane), 1600);
      await settleWidth();
      // Another message first, so this one's frame is created under the recorder.
      await open(others.find((other) => other !== c.subject));
      await wait(200);
      await js(RECORDER);
      await open(c.subject);
      for (let i = 0; i < 40; i++) {
        const ready =
          await js(`(() => { const f = [...document.querySelectorAll('[data-reader-text] iframe[title="Message"]')].at(-1);
          return !!f && !!f.contentDocument?.body?.textContent.includes(${JSON.stringify(c.marker)}); })()`);
        if (ready) break;
        await wait(100);
      }
      await settle(c.name);
      const hits = [];
      for (const [index, step] of (c.steps ?? []).entries()) {
        await js(`window.__phase = ${index + 1}`);
        const script = typeof STEPS[step] === "function" ? STEPS[step](c) : STEPS[step];
        if (!(await js(script))) {
          const buttons = await js(
            `[...document.querySelectorAll("[data-reader-text] button")].map((b) => b.textContent).join("|")`,
          );
          throw new Error(`${c.name}: step ${step} failed; buttons: ${buttons}`);
        }
        await settle(`${c.name} ${step}`);
        if (c.find) hits.push({ step, ...(await js(HIT)) });
      }
      // Settled; anything drawn in the next 400 ms is flicker.
      const settled = await js(`performance.now()`);
      await wait(400);
      const measured = await js(MEASURE);
      const heights = (await js(`window.__heights`)).filter((h) => h.frame === measured.id);
      results.push({
        name: c.name,
        pane: await paneWidth(win),
        settled,
        heights,
        hits,
        ...measured,
      });
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
