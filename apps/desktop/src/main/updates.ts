import { Mailbox } from "@openmail/core";
import { Effect, Layer, Stream } from "effect";
import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";

/** Neither keychain access nor codesign delay the first window. */
export const shown = Effect.callback<void>((resume) => {
  const listeners = new Map<BrowserWindow, () => void>();
  const cleanup = () => {
    app.off("browser-window-created", listen);
    for (const [win, listener] of listeners) win.off("show", listener);
    listeners.clear();
  };
  const finish = () => {
    cleanup();
    resume(Effect.void);
  };
  const listen = (_event: Electron.Event | undefined, win: BrowserWindow) => {
    listeners.set(win, finish);
    win.once("show", finish);
  };
  if (BrowserWindow.getAllWindows().some((win) => win.isVisible())) finish();
  else {
    app.on("browser-window-created", listen);
    for (const win of BrowserWindow.getAllWindows()) listen(undefined, win);
  }
  return Effect.sync(cleanup);
});

export const UpdatesLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* Effect.gen(function* () {
      yield* shown;
      // The updater is loaded only after the UI is shown.
      const updater = yield* Effect.promise(() => import("electron-updater"));
      let stop: (() => void) | undefined;
      yield* Effect.addFinalizer(() => Effect.sync(() => stop?.()));
      const restart = Effect.gen(function* () {
        stop?.();
        stop = yield* mailbox.startUpdates(updater.default.autoUpdater, {
          packaged: app.isPackaged && process.platform === "darwin",
          bundle: resolve(process.execPath, "../../.."),
        });
      });
      yield* restart;
      yield* mailbox.events.pipe(
        Stream.filter((event) => event._tag === "UpdateSettingsChanged"),
        Stream.runForEach(() => restart),
      );
    }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    );
  }),
);
