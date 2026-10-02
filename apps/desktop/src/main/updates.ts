import { setUpdateQuitPlan } from "./update-install";
import { updateClient } from "./update-client";
import { Mailbox, isSignedMacApp } from "@openmail/core";
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
      const client = updateClient(updater.default.autoUpdater);
      const removePlan = setUpdateQuitPlan(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const version = client.downloadedVersion;
            if (!version || !app.isPackaged || process.platform !== "darwin") return null;
            if (!(yield* mailbox.updateTokenConfigured)) return null;
            if (
              !(yield* Effect.promise(() => isSignedMacApp(resolve(process.execPath, "../../.."))))
            )
              return null;
            const prefs = yield* mailbox.prefs;
            return client.reserveInstall(prefs.updateChannel, version);
          }),
        ).catch(() => null),
      );
      yield* Effect.addFinalizer(() => Effect.sync(removePlan));
      let stop: (() => void) | undefined;
      yield* Effect.addFinalizer(() => Effect.sync(() => stop?.()));
      const restart = Effect.gen(function* () {
        stop?.();
        stop = yield* mailbox.startUpdates(client, {
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

/** Menu checks report a result without exposing updater errors or release credentials. */
export function manualUpdateCheck(
  mailbox: Mailbox["Service"],
  labels: import("../shared/desktop-labels").DesktopLabels,
) {
  return Effect.gen(function* () {
    const result =
      app.isPackaged && process.platform === "darwin"
        ? yield* Effect.gen(function* () {
            const updater = yield* Effect.promise(() => import("electron-updater"));
            return yield* mailbox.checkUpdates(updateClient(updater.default.autoUpdater), {
              packaged: true,
              bundle: resolve(process.execPath, "../../.."),
            });
          }).pipe(Effect.catchCause(() => Effect.succeed({ status: "error" } as const)))
        : ({ status: "disabled" } as const);
    const { dialog } = yield* Effect.promise(() => import("electron"));
    const message =
      result.status === "disabled"
        ? labels.updatesDisabled
        : result.status === "upToDate"
          ? labels.updatesCurrent
          : result.status === "available"
            ? `${labels.updatesAvailable} ${result.version}`
            : labels.updatesFailed;
    yield* Effect.promise(() =>
      dialog.showMessageBox({
        type: result.status === "error" ? "error" : "info",
        message,
        buttons: [labels.ok],
      }),
    );
  });
}
