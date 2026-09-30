import { NodeMailbox } from "@openmail/core";
import { Cause, Effect, Fiber, Layer } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, powerMonitor, shell } from "electron";
import { desktopVision } from "./vision";

import { RpcServerLive } from "./rpc-server";
import { DesktopLive, receiveAppUrl, ready } from "./system";
import { DEV_ICON, focusMainWindow } from "./windows";

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
        Effect.sync(() => {
          if (process.platform === "darwin" && DEV_ICON) app.dock?.setIcon(DEV_ICON);
          if (app.isPackaged) app.setAsDefaultProtocolClient("openmail");
        }),
      ),
    ),
  );
  const main = Effect.runFork(
    Layer.launch(
      RpcServerLive.pipe(
        Layer.provideMerge(DesktopLive),
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
      // A failed start (the database locked by a process still quitting, say)
      // would otherwise leave a process with no window and nothing logged.
      // Quitting interrupts the program; that is not a failure.
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) return;
          console.error(`OpenMail failed to start:\n${Cause.pretty(cause)}`);
          app.exit(1);
        }),
      ),
    ),
  );

  // Interrupt scoped timers/RPC and close core before exiting.
  let stopping = false;
  app.on("will-quit", (event) => {
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    Effect.runFork(Fiber.interrupt(main).pipe(Effect.ensuring(Effect.sync(() => app.exit(0)))));
  });
}
