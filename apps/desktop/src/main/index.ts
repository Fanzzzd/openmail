import { showDatabaseUpgrade, isDatabaseUpgradeWindow } from "./database-upgrade";
import { nativeRecoveryLabels } from "./native-i18n";
import { registerSecuritySchemes, prepareSessionSecurity } from "./security-bootstrap";
import { openExternal } from "./external";
import { createShutdownHandler } from "./quit";
import { prepareUpdateQuit } from "./update-install";
import { cleanupAttachmentTemps, cleanupPrintTemps } from "./attachment-temp";
import {
  NodeMailbox,
  DatabaseUpgradeSpaceError,
  dataDir,
  NodeSystem,
  unavailableVision,
  type Vision,
} from "@openmail/core";
import { Cause, Deferred, Effect, Fiber, Layer, Logger } from "effect";
import { resolve } from "node:path";
import { nativeBinary } from "./native-binary";
import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { desktopVision } from "./vision";
import { desktopInferenceProcess } from "./inference";

import { UpdatesLive } from "./updates";
import { RpcServerLive } from "./rpc-server";
import { DesktopLive, receiveAppUrl, receiveOpenFile, ready } from "./system";
import { DEV_ICON, focusMainWindow } from "./windows";

import { prepareReliability, diagnosticsLogger, localLog } from "./reliability";

registerSecuritySchemes();

const isolatedData = app.commandLine.getSwitchValue("user-data-dir");
if (isolatedData) app.setPath("userData", resolve(isolatedData));

// Register before ready: macOS delivers a launch URL during startup.
app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveAppUrl(url);
});

app.on("open-file", (event, file) => {
  event.preventDefault();
  receiveOpenFile(file);
});

// The second process exits before constructing core (and before opening the DB).
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    const urls = argv.filter((arg) => /^(openmail|mailto):/i.test(arg));
    for (const url of urls) receiveAppUrl(url);
    if (!urls.length && app.isReady()) focusMainWindow();
  });
  for (const arg of process.argv) {
    if (/^(openmail|mailto):/i.test(arg)) receiveAppUrl(arg);
  }

  const setup = Layer.effectDiscard(
    ready.pipe(
      Effect.andThen(
        Effect.all(
          [cleanupAttachmentTemps, cleanupPrintTemps].map((cleanup) =>
            Effect.tryPromise(() => cleanup(app.getPath("temp"))).pipe(
              Effect.catch((error) => Effect.logWarning("Attachment temp cleanup failed", error)),
            ),
          ),
          { discard: true },
        ),
      ),
      Effect.andThen(
        Effect.sync(() => {
          if (process.platform === "darwin" && DEV_ICON) app.dock?.setIcon(DEV_ICON);
          if (app.isPackaged) app.setAsDefaultProtocolClient("openmail");
        }),
      ),
    ),
  );
  const main = Effect.runFork(
    Layer.launch(
      Layer.merge(RpcServerLive, UpdatesLive).pipe(
        Layer.provideMerge(DesktopLive),
        Layer.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              yield* ready;
              prepareSessionSecurity();
              const directory = isolatedData
                ? resolve(isolatedData)
                : yield* dataDir.pipe(Effect.provide(NodeSystem));
              if (!(yield* Effect.promise(() => prepareReliability(directory))))
                yield* Effect.never;
              const binary = nativeBinary("vision");
              const painted = yield* Deferred.make<void>();
              const windows = new Map<BrowserWindow, () => void>();
              let released = false;
              const cleanup = () => {
                app.off("browser-window-created", created);
                for (const remove of windows.values()) remove();
                windows.clear();
              };
              const shown = () => {
                if (released) return;
                released = true;
                cleanup();
                Deferred.doneUnsafe(painted, Effect.void);
              };
              const watch = (win: BrowserWindow) => {
                if (released || windows.has(win)) return;
                const readyToShow = () => {
                  if (!isDatabaseUpgradeWindow(win)) shown();
                };
                const remove = () => {
                  win.off("ready-to-show", readyToShow);
                  win.off("closed", remove);
                  windows.delete(win);
                };
                windows.set(win, remove);
                win.once("ready-to-show", readyToShow);
                win.once("closed", remove);
              };
              const created = (_event: Electron.Event, win: BrowserWindow) => watch(win);
              // Subscribe synchronously before DesktopLive creates windows.
              yield* Effect.sync(() => {
                app.on("browser-window-created", created);
                for (const win of BrowserWindow.getAllWindows()) {
                  if (win.isVisible()) shown();
                  else watch(win);
                }
              });
              yield* Effect.addFinalizer(() => Effect.sync(cleanup));
              let current = unavailableVision;
              const vision: Vision = {
                get available() {
                  return current.available;
                },
                get version() {
                  return current.version;
                },
                recognize: (data) => current.recognize(data),
              };
              yield* Deferred.await(painted).pipe(
                Effect.andThen(Effect.promise(() => desktopVision(binary))),
                Effect.tap((loaded) =>
                  Effect.sync(() => {
                    current = loaded;
                  }),
                ),
                Effect.forkScoped,
              );
              return NodeMailbox({
                onDatabaseUpgrade: showDatabaseUpgrade,
                openUrl: openExternal,
                autoSync: "2 minutes",
                resumeDesktopSends: true,
                inferenceProcess: desktopInferenceProcess,
                dataDir: directory,
                inboxPoll: "45 seconds",
                imapIdle: true,
                backgroundReady: Deferred.await(painted),
                pollOnBattery: () => powerMonitor.isOnBatteryPower(),
                canTriage: () =>
                  BrowserWindow.getFocusedWindow() !== null || !powerMonitor.isOnBatteryPower(),
                media: {
                  vision,
                  onBattery: () => powerMonitor.isOnBatteryPower(),
                  idle: () => powerMonitor.getSystemIdleTime() >= 5,
                },
              });
            }),
          ),
        ),
        Layer.merge(setup),
      ),
    ).pipe(
      Effect.provide(Logger.layer([diagnosticsLogger])),
      // A failed start (the database locked by a process still quitting, say)
      // would otherwise leave a process with no window and nothing logged.
      // Quitting interrupts the program; that is not a failure.
      Effect.tapCause((cause) =>
        Effect.promise(async () => {
          if (Cause.hasInterruptsOnly(cause)) return;
          const error = Cause.squash(cause);
          if (error instanceof DatabaseUpgradeSpaceError) {
            const labels = await nativeRecoveryLabels();
            dialog.showErrorBox(
              labels.upgradeSpaceTitle,
              labels.upgradeSpaceDetail(String(Math.ceil(error.requiredBytes / 1024 ** 2))),
            );
          }
          localLog("startup-failed");
          console.error(Cause.pretty(cause));
          app.exit(1);
        }),
      ),
    ),
  );

  // Interrupt scoped timers/RPC and close core before exiting.
  const shutdown = createShutdownHandler({
    prepareInstall: prepareUpdateQuit,
    stop: () => Effect.runPromise(Fiber.interrupt(main).pipe(Effect.asVoid)),
    exit: () => app.exit(0),
  });
  app.on("will-quit", (event) => {
    void shutdown(event);
  });
}
