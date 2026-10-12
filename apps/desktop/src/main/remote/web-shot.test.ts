import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Mailbox } from "@openmail/core";
import type { IncomingMessage } from "@openmail/core/schema";
import { fakeServer, TemporaryTestMailbox } from "@openmail/core/testing/node";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { desktopRoot } from "../../renderer/src/test-support/paths";
import { createSessions, type GateConfig } from "./remote-auth";
import { createConnectionHub, remoteRpcServer } from "./remote-rpc-server";
import { startRemoteServer } from "./remote-server";

/** Electron as a plain browser: none of the test runner's Node options. */
const electronEnv = () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^(NODE_|VITEST|ELECTRON_RUN_AS_NODE)/.test(key)) env[key] = value;
  return env;
};

/**
 * Screenshots of the built web app at phone and laptop widths, served by the
 * real remote server behind a stand-in for Tailscale Serve, with fake mail.
 * Opt in after `pnpm build`: OPENMAIL_WEB_SHOT=<output directory>.
 * Uses Electron's Chromium as a hidden browser window; no OpenMail profile.
 */
const output = process.env.OPENMAIL_WEB_SHOT;
const webRoot = path.join(desktopRoot, "out/web");
const HOST = "mac.tail1234.ts.net";
const LOGIN = "owner@github";

const message = (id: string, subject: string, from: string, minutes: number, extra = {}) =>
  ({
    providerId: id,
    threadId: `t-${id}`,
    subject,
    from: { name: from, address: `${from.toLowerCase().replace(/\W+/g, ".")}@example.com` },
    to: [{ name: "Me", address: "me@gmail.com" }],
    cc: [],
    date: Date.now() - minutes * 60_000,
    snippet: `${subject}: a short preview of the message text.`,
    bodyText: `Hi,\n\n${subject}. This message came from the Mac over the tailnet.\n\nThanks`,
    bodyHtml: "",
    labels: ["INBOX", "UNREAD"],
    attachments: [],
    isUnread: minutes < 90,
    isStarred: minutes === 45,
    ...extra,
  }) satisfies IncomingMessage;

interface Measured {
  coarse: boolean;
  fields: { label: string; size: string }[];
  small: { label: string; h: number }[];
}
const measuredShot = (dir: string, name: string): Measured =>
  // IO boundary: JSON written by the screenshot script.
  JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")) as Measured;

it.skipIf(!output || !existsSync(path.join(webRoot, "web.html")))(
  "captures the web build at phone width",
  { timeout: 120_000 },
  async () => {
    const dir = output ?? "";
    const server = fakeServer("me@gmail.com", [
      message("1", "Quarterly report draft", "Dana Whitfield", 5),
      message("2", "Lunch on Friday?", "Sam Ortiz", 45),
      message("3", "Your flight to Lisbon", "TAP Air Portugal", 130),
      message("4", "Invoice #2041", "Northwind Billing", 600),
      message("5", "Design review notes", "Priya Natarajan", 1500),
      message("6", "Weekend hiking plan", "Alex Kim", 3000),
    ]);
    const runtime = ManagedRuntime.make(TemporaryTestMailbox({ gmail: server }));
    const m = await runtime.runPromise(Mailbox);
    await runtime.runPromise(m.connect({ provider: "gmail" }));
    await runtime.runPromise(
      m.setPrefs({ language: "en", defaultProfilesPrompted: true, remoteImages: "ask" }),
    );
    await runtime.runPromise(m.sync());

    const gate: GateConfig = { allowlist: [LOGIN], host: HOST, port: 8443 };
    const hub = createConnectionHub();
    const rpc = Effect.runFork(
      Layer.launch(remoteRpcServer(hub)).pipe(Effect.provideService(Mailbox, m)),
    );
    const local = await startRemoteServer({
      webRoot,
      port: 0,
      gate: () => gate,
      sessions: createSessions(),
      attachment: () => Promise.reject(new Error("none")),
      provider: async () => "gmail",
      onConnection: hub.onConnection,
    });

    // Stand-in for Tailscale Serve: adds the identity header and the tailnet
    // Host and Origin, the way a browser at https://HOST:8443 would arrive.
    const rewrite = (headers: Record<string, string | string[] | undefined>) => {
      const next: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(headers))
        if (value !== undefined && !key.startsWith("tailscale-")) next[key] = value;
      next.host = `${HOST}:8443`;
      if (next.origin) next.origin = `https://${HOST}:8443`;
      next["tailscale-user-login"] = LOGIN;
      next["tailscale-user-name"] = "Owner";
      return next;
    };
    const serve = createServer((req, res) => {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: local.port,
          path: req.url,
          method: req.method,
          headers: rewrite(req.headers),
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    serve.on("upgrade", (req, socket, head) => {
      const upstream = connect(local.port, "127.0.0.1", () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [key, value] of Object.entries(rewrite(req.headers)))
          for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => {
      serve.listen(0, "127.0.0.1", resolve);
    });
    const address = serve.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const work = mkdtempSync(path.join(tmpdir(), "openmail-web-shot-"));
    const script = path.join(work, "shot.cjs");
    writeFileSync(
      script,
      `const { app, BrowserWindow } = require("electron");
const [url, dir] = process.argv.slice(-2);
// Keep running between windows; quit only when done.
app.on("window-all-closed", () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require("fs");
const path = require("path");
// Steps: a string runs as page JS; { text } types; { key } presses a key; { wait } pauses.
async function run(win, steps) {
  for (const step of steps) {
    if (typeof step === "string") await win.webContents.executeJavaScript(step);
    else if (step.text) await win.webContents.insertText(step.text);
    else if (step.wait) await wait(step.wait);
    else if (step.key) for (const type of ["keyDown", "char", "keyUp"])
      win.webContents.sendInputEvent({ type, keyCode: step.key });
    await wait(400);
  }
}
const click = (selector, text) =>
  "(() => { const el = [...document.querySelectorAll(" + JSON.stringify(selector) + ")]" +
  ".find((e) => e.getClientRects().length && e.textContent.includes(" + JSON.stringify(text ?? "") + "));" +
  " if (!el) throw new Error(" + JSON.stringify("missing " + selector) + "); el.click(); })()";
const focus = (selector) =>
  "document.querySelector(" + JSON.stringify(selector) + ").focus()";
// What a phone sees: text sizes of the fields and the smallest touch targets.
const MEASURE = \`(() => {
  const visible = (e) => e.getClientRects().length > 0;
  const fields = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]")]
    .filter(visible).map((e) => ({ label: e.getAttribute("aria-label") ?? e.tagName, size: getComputedStyle(e).fontSize }));
  const small = [...document.querySelectorAll("button, [role=menuitem], [role=option], [role=tab]")]
    .filter(visible).map((e) => ({ label: e.getAttribute("aria-label") || e.textContent.trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height) }))
    .filter((e) => e.h < 40);
  return { coarse: matchMedia("(pointer: coarse)").matches, fields, small };
})()\`;
async function shot(width, height, mobile, name, steps = []) {
  const win = new BrowserWindow({ width, height, show: false, useContentSize: true,
    webPreferences: { partition: "shot-" + name } });
  for (let attempt = 0; ; attempt++) {
    try { await win.loadURL(url); break; } catch (error) { if (attempt > 3) throw error; await wait(500); }
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
  for (let i = 0; i < 60; i++) {
    const ready = await win.webContents.executeJavaScript('document.body.innerText.includes("Quarterly report draft")');
    if (ready) break;
    await wait(250);
  }
  await run(win, steps);
  await wait(1200);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, name + ".png"), image.toPNG());
  const measured = await win.webContents.executeJavaScript(MEASURE);
  fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify(measured, null, 2));
  win.destroy();
}
const openSidebar = click('button[aria-label="Show sidebar"]');
app.whenReady().then(async () => {
  try {
    await shot(390, 844, true, "web-390-inbox");
    await shot(390, 844, true, "web-390-thread",
      [click("[data-id]", "Quarterly report draft")]);
    await shot(390, 844, true, "web-390-compose", [
      openSidebar,
      click('button[aria-label="New message"]'),
      focus('input[aria-label="To"]'),
      { text: "dana.whitfield@example.com" }, { key: "Enter" },
      { text: "sam.ortiz@example.com" }, { key: "Enter" },
      { text: "pr" },
    ]);
    await shot(390, 844, true, "web-390-search", [
      'localStorage.setItem("openmail.recentSearches", JSON.stringify(["invoice", "from:dana", "lisbon flight"])); location.reload()',
      { wait: 3000 },
      focus('input[aria-label="Search mail"]'),
      { key: "Down" },
    ]);
    await shot(390, 844, true, "web-390-settings", [
      openSidebar,
      click('button[aria-label="Settings"]'),
    ]);
    await shot(1280, 800, false, "web-1280-inbox");
  } catch (error) { console.error(error); process.exitCode = 1; }
  app.quit();
});`,
    );
    // The electron package resolves to the path of its binary.
    const electron = String(createRequire(import.meta.url)("electron"));
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(
        electron,
        [`--user-data-dir=${path.join(work, "profile")}`, script, `http://127.0.0.1:${port}/`, dir],
        { stdio: ["ignore", "inherit", "inherit"], env: electronEnv() },
      );
      child.once("exit", (exit, signal) => {
        if (signal) process.stderr.write(`electron exited with ${signal}\n`);
        resolve(exit);
      });
    });

    serve.close();
    await local.close();
    await Effect.runPromise(Fiber.interrupt(rpc));
    await runtime.dispose();
    rmSync(work, { recursive: true, force: true });
    expect(code).toBe(0);
    for (const name of [
      "web-390-inbox",
      "web-390-thread",
      "web-390-compose",
      "web-390-search",
      "web-390-settings",
      "web-1280-inbox",
    ])
      expect(existsSync(path.join(dir, `${name}.png`)), name).toBe(true);
    // On a phone: no field under 16 px (iOS would zoom), and the toolbar,
    // header, menu and chip controls are at least 40 px tall.
    for (const name of ["web-390-inbox", "web-390-thread", "web-390-search", "web-390-settings"]) {
      const measured = measuredShot(dir, name);
      expect(measured.coarse, name).toBe(true);
      expect(
        measured.fields.filter((field) => field.size !== "16px"),
        name,
      ).toEqual([]);
      expect(
        measured.small.filter((control) => control.label !== "Dana Whitfield"),
        name,
      ).toEqual([]);
    }
    expect(
      measuredShot(dir, "web-390-compose").fields.filter((field) => field.size !== "16px"),
    ).toEqual([]);
    expect(measuredShot(dir, "web-1280-inbox").coarse).toBe(false);
  },
);
