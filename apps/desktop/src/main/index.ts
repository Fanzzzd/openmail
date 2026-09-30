import { NodeMailbox } from "@openmail/core";
import { Cause, Effect, Fiber, Layer } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopVision } from "./vision";
import { app, BrowserWindow, powerMonitor, shell } from "electron";

import { RpcServerLive } from "./rpc-server";
import { createMainWindow, DEV_ICON } from "./windows";

const MAC = process.platform === "darwin";

/**
 * Waits for Electron's `ready`. An event, not a top-level `await
 * app.whenReady()`: Electron fires `ready` only after the ESM entry finishes
 * evaluating, so awaiting it at the top level would deadlock.
 */
const ready = Effect.callback<void>((resume) => {
  if (app.isReady()) resume(Effect.void);
  else app.once("ready", () => resume(Effect.void));
});

const onActivate = () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
};
const onAllClosed = () => {
  if (!MAC) app.quit();
};

/**
 * The window for as long as the app runs. macOS keeps the app alive with no
 * window and opens a new one on `activate`; other platforms quit.
 */
const WindowLive = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* ready;
    if (MAC && DEV_ICON) app.dock?.setIcon(DEV_ICON);
    yield* Effect.acquireRelease(Effect.sync(createMainWindow), (win) =>
      Effect.sync(() => {
        if (!win.isDestroyed()) win.destroy();
      }),
    );
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
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        yield* ready;
        const binary = app.isPackaged
          ? join(process.resourcesPath, "native/vision")
          : fileURLToPath(new URL("../native/vision", import.meta.url));
        const vision = yield* Effect.promise(() => desktopVision(binary));
        return NodeMailbox({
          openUrl: (url) => shell.openExternal(url),
          autoSync: "2 minutes",
          media: {
            vision,
            onBattery: () => powerMonitor.isOnBatteryPower(),
            idle: () => powerMonitor.getSystemIdleTime() >= 5,
          },
        });
      }),
    ),
  ),
);

// A failed start (the database locked by a process still quitting, say) would
// otherwise leave a process with no window and nothing logged.
const main = Effect.runFork(
  Layer.launch(MainLive).pipe(
    Effect.tapCause((cause) =>
      // Quitting interrupts the program; that is not a failure.
      Effect.sync(() => {
        if (Cause.hasInterruptsOnly(cause)) return;
        console.error(`OpenMail failed to start:\n${Cause.pretty(cause)}`);
        app.exit(1);
      }),
    ),
  ),
);

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
