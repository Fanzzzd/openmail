// Electron script for phone-web.test.ts: the built web app at phone size with
// touch, through the test stand-in for Tailscale Serve. Records what a phone
// would see in a JSON file. Usage: electron phone-web-driver.cjs <url> <out.json>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const [url, outPath] = process.argv.slice(-2);
app.on("window-all-closed", () => null);
const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function phone(name, target = url) {
  const win = new BrowserWindow({
    width: 390,
    height: 844,
    show: false,
    useContentSize: true,
    webPreferences: { partition: `phone-${name}` },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await win.loadURL(target);
      break;
    } catch (error) {
      if (attempt > 3) throw error;
      await wait(500);
    }
  }
  // Emulating before the first load crashes Electron 44.
  win.webContents.enableDeviceEmulation({
    screenPosition: "mobile",
    screenSize: { width: 390, height: 844 },
    viewSize: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    viewPosition: { x: 0, y: 0 },
    scale: 1,
  });
  const cdp = win.webContents.debugger;
  cdp.attach();
  await cdp.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.sendCommand("Emulation.setEmitTouchEventsForMouse", {
    enabled: true,
    configuration: "mobile",
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 15_000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await js(code)) return true;
      await wait(100);
    }
    return false;
  };
  return { win, cdp, js, until };
}

const click = (selector, text = "") =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})]` +
  `.find((e) => e.getClientRects().length && e.textContent.includes(${JSON.stringify(text)}));` +
  ` if (!el) throw new Error(${JSON.stringify(`missing ${selector}`)}); el.click(); })()`;
const shown = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.getClientRects().length > 0; })()`;
const hasText = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const LOST = "Can't reach OpenMail on your Mac";

async function main() {
  const out = {};
  const { win, cdp, js, until } = await phone("app");
  out.loaded = await until(hasText("Quarterly report draft"));

  // The home screen and browser chrome: manifest, icons, colours.
  out.head = await js(`(async () => {
    const meta = (name) => [...document.querySelectorAll('meta[name="' + name + '"]')].map((m) => m.content);
    const manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute("href");
    const touchIcon = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href");
    const manifest = await fetch(manifestHref).then((r) => r.json());
    const icons = [];
    for (const href of [touchIcon, ...manifest.icons.map((i) => i.src)]) {
      const r = await fetch(href);
      icons.push({ href, status: r.status, type: r.headers.get("content-type") });
    }
    return { colorScheme: meta("color-scheme"), themeColors: meta("theme-color").length, manifest, icons };
  })()`);

  // Safe areas: an iPhone's notch and home indicator, where Chromium can pretend to have them.
  try {
    await cdp.sendCommand("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 47, bottom: 34, left: 0, right: 0 },
    });
    out.safeAreaEmulated = true;
  } catch {
    out.safeAreaEmulated = false;
  }
  await wait(300);
  out.safeArea = await js(`(() => {
    const first = document.querySelector('[data-mail-pane="list"] section > :first-child');
    const header = document.querySelector('[data-mail-pane="list"] header');
    const rules = [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules].map((r) => r.cssText); } catch { return []; } }).join("\\n");
    return {
      firstRowTop: Math.round(first.getBoundingClientRect().top),
      firstRowPadTop: getComputedStyle(first).paddingTop,
      secondRowPadTop: first === header ? null : getComputedStyle(header).paddingTop,
      cssInsets: ["top", "bottom", "left", "right"].filter((side) => rules.includes("safe-area-inset-" + side)),
    };
  })()`);

  // The drawer clears the notch and the home indicator; its New message button is a 44 px target.
  await js(click('button[aria-label="Show sidebar"]'));
  await until(shown('[role="dialog"][aria-label="Sidebar"]'));
  await wait(400);
  out.drawer = await js(`(() => {
    const drawer = document.querySelector('[role="dialog"][aria-label="Sidebar"]');
    const compose = drawer.querySelector('button[aria-label="New message"]').getBoundingClientRect();
    return {
      padBottom: getComputedStyle(drawer).paddingBottom,
      firstRowPadTop: getComputedStyle(drawer.querySelector("aside > :first-child")).paddingTop,
      compose: { w: Math.round(compose.width), h: Math.round(compose.height) },
    };
  })()`);
  await js(
    `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
  );
  out.drawerClosed = await until(`!${shown('[role="dialog"][aria-label="Sidebar"]')}`);

  // Back from the reader returns to the list, inside the app.
  await js(click("[data-id]", "Quarterly report draft"));
  out.readerOpened = await until(
    `${shown('[data-mail-pane="reader"]')} && !${shown('[data-mail-pane="list"]')}`,
  );
  out.readerPadTop = await js(
    `getComputedStyle(document.querySelector("[data-reader-toolbar]")).paddingTop`,
  );
  await js("history.back()");
  out.backToList = await until(
    `${shown('[data-mail-pane="list"]')} && !${shown('[data-mail-pane="reader"]')}`,
  );
  out.afterBack = await js("location.pathname");

  // The socket drops while a reply is being typed, and the Mac is unreachable for a while.
  await js("window.__samePage = true");
  await js(click('[data-mail-pane="list"] header button[aria-label="New message"]'));
  out.composerOpened = await until(shown('input[aria-label="Subject"]'));
  await wait(400);
  // The full-screen composer: inside the safe area, and with the on-screen keyboard
  // up (lib/keyboard-inset.ts sets the variable on a phone) Send sits above it.
  const SEND = `[...document.querySelectorAll('[data-compose] button[type="submit"]')].find((b) => b.getClientRects().length)`;
  out.composer = await js(`(() => {
    const sheet = getComputedStyle(document.querySelector("[data-compose]"));
    return { borderTop: sheet.borderTopWidth, borderBottom: sheet.borderBottomWidth,
      sendBottom: Math.round(${SEND}.getBoundingClientRect().bottom) };
  })()`);
  await js(`document.documentElement.style.setProperty("--keyboard-inset", "300px")`);
  await wait(300);
  out.composerKeyboard = await js(`(() => {
    const sheet = document.querySelector("[data-compose]");
    return { sheetBottom: Math.round(sheet.getBoundingClientRect().bottom),
      borderBottom: getComputedStyle(sheet).borderBottomWidth,
      sendBottom: Math.round(${SEND}.getBoundingClientRect().bottom) };
  })()`);
  await js(`document.documentElement.style.setProperty("--keyboard-inset", "0px")`);
  await js(`document.querySelector('input[aria-label="Subject"]').focus()`);
  await win.webContents.insertText("Typed before the drop");
  await js("fetch('/__test/block')");
  await js("fetch('/__test/drop')");
  out.lostShown = await until(hasText(LOST));
  // Hiding the page saves the draft now; the save waits for the connection.
  await js("window.dispatchEvent(new Event('pagehide'))");
  // The old notice reloaded after 3 s; wait past that.
  await wait(4500);
  out.whileDown = await js(`({
    samePage: window.__samePage === true,
    subject: document.querySelector('input[aria-label="Subject"]')?.value ?? null,
  })`);
  await js("fetch('/__test/unblock')");
  // Back online: reconnect at once rather than after the backoff.
  await js("window.dispatchEvent(new Event('online'))");
  out.reconnected = await until(`!${hasText(LOST)}`);
  out.saved = await until(
    `[...document.querySelectorAll('[data-compose] span')].some((s) => s.textContent.startsWith("Saved"))`,
  );
  out.afterReconnect = await js(`({
    samePage: window.__samePage === true,
    subject: document.querySelector('input[aria-label="Subject"]')?.value ?? null,
  })`);
  win.destroy();

  // A tailnet login the Mac doesn't list.
  const intruder = await phone("intruder", new URL("/__intruder/", url).href);
  out.forbidden = await intruder.js(`({
    title: document.title,
    text: document.body.innerText,
    scripts: document.scripts.length,
  })`);
  intruder.win.destroy();

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
