import { showDatabaseUpgrade, isDatabaseUpgradeWindow } from "./app/database-upgrade";
import { nativeAuthorizePage, nativeRecoveryLabels, osLocale } from "./app/native-i18n";
import { registerSecuritySchemes, prepareSessionSecurity } from "./security/security-bootstrap";
import { openExternal } from "./security/external";
import { createShutdownHandler } from "./app/quit";
import { prepareUpdateQuit } from "./updates/update-install";
import { cleanupAttachmentTemps, cleanupPrintTemps } from "./files/attachment-temp";
import {
  NodeMailbox,
  DatabaseTooNewError,
  DatabaseUpgradeSpaceError,
  dataDir,
  NodeSystem,
  unavailableVision,
  type Vision,
} from "@openmail/core";
import { Cause, Deferred, Effect, Fiber, Layer, Logger } from "effect";
import { resolve } from "node:path";
import { nativeBinary } from "./app/native-binary";
import { builtInOAuthClients } from "./security/oauth-clients";
import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import { desktopVision } from "./app/vision";
import { desktopInferenceProcess } from "./app/inference";

import { UpdatesLive } from "./updates/updates";
import { RpcServerLive } from "./rpc/rpc-server";
import { RemoteAccessLive } from "./remote/remote-access-live";
import { DesktopLive, receiveAppUrl, receiveOpenFile, ready } from "./system/system";
import { focusMainWindow } from "./windows/windows";
import { prepareBackgroundWindows } from "./windows/reveal";
import { showAppIdentity } from "./app/app-identity";
import { mcpLaunchArgs, runMcpMode } from "./agents/mcp-mode";

import { prepareReliability, diagnosticsLogger, finishCleanly, localLog } from "./app/reliability";
import { registerProcessErrorHandlers } from "./app/process-errors";

// First, so MCP mode and early startup are covered; localLog writes once diagnostics exist.
registerProcessErrorHandlers(localLog);
registerSecuritySchemes();
prepareBackgroundWindows();

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

const mcp = mcpLaunchArgs(process.argv);
// `OpenMail --mcp` serves an AI app over stdio. It opens no window and takes no instance lock.
if (mcp) {
  runMcpMode(mcp);
} else if (app.isPackaged && !app.requestSingleInstanceLock()) {
  // The second process exits before constructing core (and before opening the DB).
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
          showAppIdentity();
          if (app.isPackaged) app.setAsDefaultProtocolClient("openmail");
        }),
      ),
    ),
  );
  const main = Effect.runFork(
    Layer.launch(
      Layer.merge(RpcServerLive, UpdatesLive).pipe(
        Layer.provide(RemoteAccessLive),
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
                oauthClients: builtInOAuthClients,
                oauthPage: nativeAuthorizePage,
                inboxPoll: "45 seconds",
                imapIdle: true,
                backgroundReady: Deferred.await(painted),
                pollOnBattery: () => powerMonitor.isOnBatteryPower(),
                canTriage: () =>
                  BrowserWindow.getFocusedWindow() !== null || !powerMonitor.isOnBatteryPower(),
                systemLocale: osLocale,
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
            // Native on purpose: startup failed, so no window or renderer exists to draw a React
            // message, and the process exits right after.
            dialog.showErrorBox(
              labels.upgradeSpaceTitle,
              labels.upgradeSpaceDetail(String(Math.ceil(error.requiredBytes / 1024 ** 2))),
            );
          }
          if (error instanceof DatabaseTooNewError) {
            const labels = await nativeRecoveryLabels();
            dialog.showErrorBox(labels.newerDatabaseTitle, labels.newerDatabaseDetail);
            // Exit 1 skips the quit handler's finish(); without it the next launches count
            // this refusal as a crash and reach safe mode.
            finishCleanly();
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
