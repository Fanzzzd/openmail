import path from "node:path";
import { fileURLToPath } from "node:url";

import { NodeMailbox } from "@openmail/core";
import { Effect, Fiber, Layer } from "effect";
import { app, BrowserWindow, nativeTheme, shell } from "electron";

import { RpcServerLive } from "./rpc-server";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAC = process.platform === "darwin";
// build/ is not packaged: the bundle icon comes from build/icon.icns. In dev the
// dock and window would otherwise show Electron's icon.
const DEV_ICON = app.isPackaged ? undefined : path.join(here, "../../build/icon.png");

/**
 * Waits for Electron's `ready`. An event, not a top-level `await
 * app.whenReady()`: Electron fires `ready` only after the ESM entry finishes
 * evaluating, so awaiting it at the top level would deadlock.
 */
const ready = Effect.callback<void>((resume) => {
  if (app.isReady()) resume(Effect.void);
  else app.once("ready", () => resume(Effect.void));
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "OpenMail",
    ...(MAC
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 18 },
          // The sidebar is transparent and shows this material through.
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
        }
      : {
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#171717" : "#ffffff",
          ...(DEV_ICON ? { icon: DEV_ICON } : {}),
        }),
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });

  // Mail links open in the system browser. The message iframe is sandboxed with
  // `allow-popups` and a `_blank` base target, so every link click lands here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "warning" || level === "error") console.log(`[renderer ${level}] ${message}`);
    });
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(here, "../renderer/index.html"));
  }
  win.once("ready-to-show", () => win.show());
  return win;
}

/**
 * The window for as long as the app runs. macOS keeps the app alive with no
 * window and opens a new one on `activate`; other platforms quit.
 */
const WindowLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* ready;
    if (MAC && DEV_ICON) app.dock?.setIcon(DEV_ICON);
    yield* Effect.acquireRelease(Effect.sync(createWindow), (win) =>
      Effect.sync(() => {
        if (!win.isDestroyed()) win.destroy();
      }),
    );
    const onActivate = () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    };
    const onAllClosed = () => {
      if (!MAC) app.quit();
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        app.on("activate", onActivate);
        app.on("window-all-closed", onAllClosed);
      }),
      () =>
        Effect.sync(() => {
          app.off("activate", onActivate);
          app.off("window-all-closed", onAllClosed);
        }),
    );
  }),
);

const MainLive = Layer.mergeAll(WindowLive, RpcServerLive).pipe(
  Layer.provide(NodeMailbox({ openUrl: (url) => shell.openExternal(url), autoSync: "2 minutes" })),
);

const main = Effect.runFork(Layer.launch(MainLive));

// Quitting interrupts the program first, so the sync loop stops and the
// database closes. Electron ignores a second app.quit() after will-quit was
// prevented, so the process exits directly once everything is released.
let stopping = false;
app.on("will-quit", (event) => {
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  Effect.runFork(Fiber.interrupt(main).pipe(Effect.ensuring(Effect.sync(() => app.exit(0)))));
});
