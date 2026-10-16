import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { desktopRoot } from "../../renderer/src/test-support/paths";
import {
  fakeMessage as message,
  runElectron,
  serveWebApp,
  webRoot,
} from "./test-support/web-app-harness";
import { scaledMs } from "../../../../../packages/core/test-support/test-time.js";

/**
 * Screenshots of the built web app at phone and laptop widths, served by the
 * real remote server behind a stand-in for Tailscale Serve, with fake mail.
 * Opt in after `pnpm build`: OPENMAIL_WEB_SHOT=<output directory>.
 * Uses Electron's Chromium as a hidden browser window; no OpenMail profile.
 */
const output = process.env.OPENMAIL_WEB_SHOT;

interface Measured {
  coarse: boolean;
  fields: { label: string; size: string }[];
  small: { label: string; h: number }[];
  /** Keyboard shortcut text on screen: glyphs in visible text and in placeholders, such as "Search  ⌥⌘F" or "Search  /". */
  shortcuts: string[];
  /** Composer footer buttons, the writing mode select and recipient chips whose text is cut off. */
  clipped: string[];
  /** The composer footer is wider than the sheet. */
  footerOverflow: boolean;
  /** Items of the open menu. */
  menu: string[];
  /** Labels of the open dialogs and popovers. */
  popups: string[];
}
const measuredShot = (dir: string, name: string): Measured =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IO boundary: JSON written by the screenshot script.
  JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")) as Measured;

/** Russian has the longest Send and Send and archive of the shipped languages. */
const LONGEST = "ru";
/** The labels the script clicks and checks, in English and in {@link LONGEST}. */
function labels(locale: string) {
  const po = readFileSync(
    path.join(desktopRoot, `src/renderer/src/locales/${locale}/messages.po`),
    "utf8",
  );
  const translate = (id: string) => {
    const match = new RegExp(`#[^\\n]*\\nmsgid "${id}"\\nmsgstr "([^"]+)"`).exec(po);
    if (!match?.[1]) throw new Error(`no ${locale} translation of ${id}`);
    return match[1];
  };
  return {
    "New message": translate("New message"),
    "More options": translate("More options"),
    Templates: translate("Templates"),
    "Send and archive": translate("Send and archive"),
  };
}

it.skipIf(!output || !existsSync(path.join(webRoot, "web.html")))(
  "captures the web build at phone width",
  { timeout: scaledMs(120_000) },
  async () => {
    const dir = output ?? "";
    const mail = [
      message("1", "Quarterly report draft", "Dana Whitfield", 5),
      message("2", "Lunch on Friday?", "Sam Ortiz", 45),
      message("3", "Your flight to Lisbon", "TAP Air Portugal", 130),
      message("4", "Invoice #2041", "Northwind Billing", 600),
      message("5", "Design review notes", "Priya Natarajan", 1500),
      message("6", "Weekend hiking plan", "Alex Kim", 3000),
    ];
    const app = await serveWebApp(mail);
    const longest = await serveWebApp(mail, { language: LONGEST });
    const work = mkdtempSync(path.join(tmpdir(), "openmail-web-shot-"));
    const script = path.join(work, "shot.cjs");
    writeFileSync(
      script,
      `const { app, BrowserWindow } = require("electron");
const [url, longestUrl, dir, labelsJson, timingJson] = process.argv.slice(-5);
const labels = JSON.parse(labelsJson);
// limit: how long a step waits for its element; settle: the pause before a screenshot.
const timing = JSON.parse(timingJson);
// Keep running between windows; quit only when done.
app.on("window-all-closed", () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require("fs");
const path = require("path");
// Runs page JS until it returns true. A loaded machine renders late, and a page that is still
// loading rejects the script, so both retry until timing.limit.
async function until(win, js, what) {
  const deadline = Date.now() + timing.limit;
  let last;
  for (;;) {
    try {
      if (await win.webContents.executeJavaScript(js)) return;
    } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(what + (last ? ": " + last.message : ""));
    await wait(100);
  }
}
// Steps: a string runs as page JS; { poll, what } waits for page JS to return true, see until;
// { text } types; { key } presses a key. Input events run in order, and the next poll waits
// for whatever they render.
async function run(win, steps) {
  for (const step of steps) {
    if (typeof step === "string") await win.webContents.executeJavaScript(step);
    else if (step.poll) await until(win, step.poll, step.what);
    else if (step.text) await win.webContents.insertText(step.text);
    else if (step.key) for (const type of ["keyDown", "char", "keyUp"])
      win.webContents.sendInputEvent({ type, keyCode: step.key });
  }
}
// A reload step sets window.reloading, so the page it leaves does not count as loaded.
const READY = { poll: '!window.reloading && document.body.innerText.includes("Quarterly report draft")', what: "the app did not load" };
const click = (selector, text) => ({
  poll: "(() => { const el = [...document.querySelectorAll(" + JSON.stringify(selector) + ")]" +
    ".find((e) => e.getClientRects().length && e.textContent.includes(" + JSON.stringify(text ?? "") + "));" +
    " if (!el) return false; el.click(); return true; })()",
  what: "missing " + selector + (text ? " with " + text : ""),
});
const focus = (selector) => ({
  poll: "(() => { const el = document.querySelector(" + JSON.stringify(selector) + ");" +
    " el?.focus(); return !!el && document.activeElement === el; })()",
  what: "could not focus " + selector,
});
// What a phone sees: text sizes of the fields and the smallest touch targets.
const MEASURE = \`(() => {
  const visible = (e) => e.getClientRects().length > 0;
  const fields = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]")]
    .filter(visible).map((e) => ({ label: e.getAttribute("aria-label") ?? e.tagName, size: getComputedStyle(e).fontSize }));
  const small = [...document.querySelectorAll("button, [role=menuitem], [role=option], [role=tab]")]
    .filter(visible).map((e) => ({ label: e.getAttribute("aria-label") || e.textContent.trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height) }))
    // A visually hidden control, such as a popover's Close for screen readers, is 1 px.
    .filter((e) => e.h > 1 && e.h < 44);
  const placeholders = [...document.querySelectorAll("input[placeholder]")].filter(visible)
    .map((e) => e.getAttribute("placeholder")).filter((p) => /[⌘⇧⌥⌃]/.test(p) || p.endsWith(" /"));
  const shortcuts = [...(document.body.innerText.match(/[⌘⇧⌥⌃][^ ]*/g) ?? []), ...placeholders];
  const footer = document.querySelector("[data-compose] footer");
  // Recipient chips too: a name cut to "Dana …" next to Cc/Bcc on a phone.
  const clipped = [...document.querySelectorAll('[data-compose] footer button, [data-compose] [role=toolbar] button *, [data-compose] [draggable=true] *')]
    .filter(visible).filter((e) => e.scrollWidth > e.clientWidth)
    .map((e) => e.getAttribute("aria-label") || e.textContent.trim());
  const footerOverflow = footer ? footer.scrollWidth > footer.clientWidth : false;
  const menu = [...document.querySelectorAll("[role=menuitem], [role=menuitemcheckbox]")].filter(visible)
    .map((e) => e.textContent.trim());
  const popups = [...document.querySelectorAll("[role=dialog][aria-label]")].filter(visible)
    .map((e) => e.getAttribute("aria-label"));
  return { coarse: matchMedia("(pointer: coarse)").matches, fields, small, shortcuts, clipped, footerOverflow, menu, popups };
})()\`;
async function shot(width, height, mobile, name, steps = [], target = url) {
  const win = new BrowserWindow({ width, height, show: false, useContentSize: true,
    webPreferences: { partition: "shot-" + name } });
  for (let attempt = 0; ; attempt++) {
    try { await win.loadURL(target); break; } catch (error) { if (attempt > 3) throw error; await wait(500); }
  }
  // Emulating before the first load crashes Electron 44.
  if (mobile) {
    win.webContents.enableDeviceEmulation({ screenPosition: "mobile",
      screenSize: { width, height }, viewSize: { width, height }, deviceScaleFactor: 3,
      viewPosition: { x: 0, y: 0 }, scale: 1 });
    // A finger, not a mouse: (pointer: coarse) matches, as on a phone.
    win.webContents.debugger.attach();
    await win.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await win.webContents.debugger.sendCommand("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  }
  await run(win, [READY, ...steps]);
  await wait(timing.settle);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, name + ".png"), image.toPNG());
  const measured = await win.webContents.executeJavaScript(MEASURE);
  fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(measured, null, 2));
  win.destroy();
}
const openSidebar = click('button[aria-label="Show sidebar"]');
const compose = (label) => click('[data-mail-pane="list"] header button[aria-label="' + label + '"]');
const reply = [click("[data-id]", "Quarterly report draft"), click('[data-mail-pane="reader"] fieldset button')];
const more = (label) => click('[data-compose] footer button[aria-label="' + label + '"]');
app.whenReady().then(async () => {
  try {
    await shot(390, 844, true, "web-390-inbox");
    await shot(390, 844, true, "web-390-thread",
      [click("[data-id]", "Quarterly report draft")]);
    await shot(390, 844, true, "web-390-compose", [
      // The list header's New message button: a phone needs no drawer to compose.
      compose(labels.en["New message"]),
      focus('input[aria-label="To"]'),
      { text: "dana.whitfield@example.com" }, { key: "Enter" },
      { text: "sam.ortiz@example.com" }, { key: "Enter" },
      { text: "pr" },
    ]);
    await shot(390, 844, true, "web-390-search", [
      'localStorage.setItem("openmail.recentSearches", JSON.stringify(["invoice", "from:dana", "lisbon flight"])); window.reloading = true; location.reload()',
      READY,
      focus('input[aria-label="Search mail"]'),
      { key: "Down" },
    ]);
    await shot(390, 844, true, "web-390-settings", [
      openSidebar,
      click('button[aria-label="Settings"]'),
    ]);
    // The narrowest phones, and the longest translation of Send and archive.
    // A reply moves Send and archive into More; Templates opens from there.
    await shot(360, 780, true, "web-360-compose", [compose(labels.en["New message"])]);
    const ru = labels.longest;
    for (const width of [360, 390]) {
      await shot(width, 780, true, "web-" + width + "-reply-longest", reply, longestUrl);
      await shot(width, 780, true, "web-" + width + "-reply-more-longest",
        [...reply, more(ru["More options"])], longestUrl);
    }
    await shot(360, 780, true, "web-360-templates", [
      ...reply, more(labels.en["More options"]),
      click("[role=menuitem]", labels.en.Templates),
    ]);
    await shot(1280, 800, false, "web-1280-inbox");
  } catch (error) { console.error(error); process.exitCode = 1; }
  app.quit();
});`,
    );
    const code = await runElectron(
      script,
      [
        app.url,
        longest.url,
        dir,
        JSON.stringify({ en: labels("en"), longest: labels(LONGEST) }),
        // The app used to get 15 s to load; every step now gets that, scaled.
        JSON.stringify({ limit: scaledMs(15_000), settle: scaledMs(1200) }),
      ],
      work,
    );
    await app.close();
    await longest.close();
    rmSync(work, { recursive: true, force: true });
    expect(code).toBe(0);
    const phone = [
      "web-390-inbox",
      "web-390-thread",
      "web-390-compose",
      "web-390-search",
      "web-390-settings",
      "web-360-compose",
      "web-360-reply-longest",
      "web-390-reply-longest",
      "web-360-reply-more-longest",
      "web-390-reply-more-longest",
      "web-360-templates",
    ];
    for (const name of [...phone, "web-1280-inbox"])
      expect(existsSync(path.join(dir, `${name}.png`)), name).toBe(true);
    // On a phone: no field under 16 px (iOS would zoom), and the toolbar,
    // header, menu, chip and compose controls are at least 44 px tall. No
    // keyboard shortcut text either: a phone has no keyboard to press it on.
    // The composer's footer fits, and Send keeps its whole name.
    for (const name of phone) {
      const measured = measuredShot(dir, name);
      expect(measured.coarse, name).toBe(true);
      expect(
        measured.fields.filter((field) => field.size !== "16px"),
        name,
      ).toEqual([]);
      expect(measured.small, name).toEqual([]);
      expect(measured.shortcuts, name).toEqual([]);
      expect(measured.clipped, name).toEqual([]);
      expect(measured.footerOverflow, name).toBe(false);
    }
    // A narrow reply keeps Send and archive in More.
    const ru = labels(LONGEST);
    for (const name of ["web-360-reply-more-longest", "web-390-reply-more-longest"])
      expect(measuredShot(dir, name).menu, name).toContain(ru["Send and archive"]);
    expect(measuredShot(dir, "web-360-templates").popups).toContain("Templates");
    // A laptop browser has a keyboard: its hints stay, such as ⌥⌘F in the search field.
    const laptop = measuredShot(dir, "web-1280-inbox");
    expect(laptop.coarse).toBe(false);
    expect(laptop.shortcuts).not.toEqual([]);
  },
);
