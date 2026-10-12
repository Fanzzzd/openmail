import { beginUpdateState, updateStateReporter } from "./update-state";
import { setUpdateQuitPlan } from "./update-install";
import { Mailbox, isSignedMacApp } from "@openmail/core";
import { Effect, Layer, Stream } from "effect";
import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";
import { nativeAsk } from "../system/native-fallback";
import { askWindow, listeningWindow } from "../windows/window-ui";

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

/** electron-updater and its GitHub provider load on first use, not with the main process. */
const loadUpdateClient = Effect.promise(() =>
  Promise.all([import("electron-updater"), import("./update-client")]),
).pipe(Effect.map(([updater, { updateClient }]) => updateClient(updater.default.autoUpdater)));

export const UpdatesLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* Effect.gen(function* () {
      yield* shown;
      // The updater is loaded only after the UI is shown.
      const client = yield* loadUpdateClient;
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
      const restart = (resetState: boolean) =>
        Effect.gen(function* () {
          stop?.();
          const prefs = yield* mailbox.prefs;
          const report = beginUpdateState({
            reset: resetState,
            downloadedVersion: client.downloadedVersion,
            channel: prefs.updateChannel,
          });
          stop = yield* mailbox.startUpdates(client, {
            packaged: app.isPackaged && process.platform === "darwin",
            bundle: resolve(process.execPath, "../../.."),
            onState: (state) =>
              report(
                state.status === "available" && state.version === client.downloadedVersion
                  ? { status: "downloaded", version: state.version }
                  : state,
              ),
          });
        });
      yield* restart(true);
      yield* mailbox.events.pipe(
        Stream.filter((event) => event._tag === "UpdateSettingsChanged"),
        Stream.runForEach((event) => restart(event.resetState)),
      );
    }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    );
  }),
);

/** Menu checks report a result in the focused window, without exposing updater errors or release credentials. */
export function manualUpdateCheck(
  mailbox: Mailbox["Service"],
  labels: import("../../shared/desktop-labels").DesktopLabels,
) {
  return Effect.gen(function* () {
    const result =
      app.isPackaged && process.platform === "darwin"
        ? yield* Effect.gen(function* () {
            return yield* mailbox.checkUpdates(yield* loadUpdateClient, {
              packaged: true,
              bundle: resolve(process.execPath, "../../.."),
              onState: updateStateReporter(),
            });
          }).pipe(Effect.catchCause(() => Effect.succeed({ status: "error" } as const)))
        : ({ status: "disabled" } as const);
    const message =
      result.status === "disabled"
        ? labels.updatesDisabled
        : result.status === "upToDate"
          ? labels.updatesCurrent
          : result.status === "available"
            ? `${labels.updatesAvailable} ${result.version}`
            : labels.updatesFailed;
    yield* Effect.promise(() =>
      askWindow(
        listeningWindow(),
        (id) => ({
          _tag: "UpdateResult",
          id,
          result:
            result.status === "available"
              ? { status: "available", version: result.version }
              : { status: result.status },
        }),
        () =>
          nativeAsk({
            type: result.status === "error" ? "error" : "info",
            message,
            buttons: [labels.ok],
          }).then(() => "accept" as const),
      ),
    );
  });
}

export function checkForUpdateState(mailbox: Mailbox["Service"], download: boolean) {
  const onState = updateStateReporter();
  return Effect.gen(function* () {
    if (!app.isPackaged || process.platform !== "darwin") return;
    yield* mailbox.checkUpdates(yield* loadUpdateClient, {
      packaged: true,
      bundle: resolve(process.execPath, "../../.."),
      ...(download ? { autoDownload: true } : {}),
      onState,
    });
  }).pipe(Effect.catchCause(() => Effect.sync(() => onState({ status: "error" }))));
}
