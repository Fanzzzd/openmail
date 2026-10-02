import { createShutdownHandler } from "./quit";
import { prepareUpdateQuit } from "./update-install";
import { cleanupAttachmentTemps } from "./attachment-temp";
import { NodeMailbox, dataDir, NodeSystem } from "@openmail/core";
import { Cause, Effect, Fiber, Layer, Logger } from "effect";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, powerMonitor, shell } from "electron";
import { desktopVision } from "./vision";
import { desktopInferenceProcess } from "./inference";

import { UpdatesLive } from "./updates";
import { RpcServerLive } from "./rpc-server";
import { DesktopLive, receiveAppUrl, ready } from "./system";
import { DEV_ICON, focusMainWindow } from "./windows";

import { prepareReliability, diagnosticsLogger, localLog } from "./reliability";

const isolatedData = app.commandLine.getSwitchValue("user-data-dir");
if (isolatedData) app.setPath("userData", resolve(isolatedData));

// Register before ready: macOS delivers a launch URL during startup.
app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveAppUrl(url);
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
        Effect.tryPromise(() => cleanupAttachmentTemps(app.getPath("temp"))).pipe(
          Effect.catch((error) => Effect.logWarning("Attachment temp cleanup failed", error)),
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
              const directory = isolatedData
                ? resolve(isolatedData)
                : yield* dataDir.pipe(Effect.provide(NodeSystem));
              if (!(yield* Effect.promise(() => prepareReliability(directory))))
                yield* Effect.never;
              const binary = app.isPackaged
                ? join(process.resourcesPath, "native/vision")
                : fileURLToPath(new URL("../native/vision", import.meta.url));
              const vision = yield* Effect.promise(() => desktopVision(binary));
              return NodeMailbox({
                openUrl: (url) => shell.openExternal(url),
                autoSync: "2 minutes",
                inferenceProcess: desktopInferenceProcess,
                dataDir: directory,
                inboxPoll: "45 seconds",
                pollOnBattery: () => powerMonitor.isOnBatteryPower(),
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
      Effect.provide(Logger.layer([diagnosticsLogger], { mergeWithExisting: true })),
      // A failed start (the database locked by a process still quitting, say)
      // would otherwise leave a process with no window and nothing logged.
      // Quitting interrupts the program; that is not a failure.
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) return;
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
