import { finishDatabaseUpgradeStartup } from "../app/database-upgrade";
import { validOpenFile } from "../security/security-policy";
import { nativeTabMenu } from "../windows/window-keys";
import { readDockFiles, dockFileReason } from "../files/dock-files";
import { NO_MENU_SELECTION, type NativeMenuState } from "../../shared/native-actions";
import {
  applicationMenuTemplate,
  closeWindowTarget,
  goActionHref,
  goesToMainWindow,
  unfocusedMenuState,
} from "./app-menu";
import { OPENMAIL_DOCS_URL } from "../../shared/docs";
import { configureSpelling, installSpellingMenu } from "../windows/spellcheck";
import { approveUpdateQuit } from "../updates/update-install";
import { setRecoveryRelaunch } from "../app/recovery-actions";
import {
  logError,
  logWarning,
  Mailbox,
  parseAppLink,
  dockUnreadCount,
  MENU_BAR_MAIL_LIMIT,
  menuBarCountTitle,
  spaceAccountIds,
  type AppLink,
} from "@openmail/core";
import { Context, Effect, FiberSet, Layer, Queue, Schedule, Semaphore, Stream } from "effect";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, Menu, nativeImage, net, Notification, powerMonitor } from "electron";

import { menuEdit } from "../windows/menu-edit";
import { createTray } from "../windows/reveal";
import { watchOnline } from "../app/online";
import { manualUpdateCheck } from "../updates/updates";
import { nativeAsk } from "./native-fallback";
import { askWindow, listeningWindow } from "../windows/window-ui";
import { notificationPermission } from "./notification-permission";
import { makeNotifications } from "./notifications";
import { DEFAULT_DESKTOP_LABELS } from "./default-labels";
import { createQuitGuard, createSendState } from "../app/quit";
import { shouldBufferDesktopEvent, type DesktopEvent } from "../../shared/desktop";
import { mailHref } from "../../shared/routes";
import { openExternal } from "../security/external";
import type { DesktopLabels } from "../../shared/desktop-labels";
import {
  createMainWindow,
  focusMainWindow,
  openMessageWindow,
  isMainWindow,
  isComposeWindow,
  restoreWindows,
  setComposeCloseHandler,
  approveComposeClose,
  setRendererReloadGuard,
  setInlinePopOutHandler,
} from "../windows/windows";
import { APP_TITLE } from "../app/app-identity";

const activate = () => focusMainWindow();
const allClosed = () => {
  if (process.platform !== "darwin") app.quit();
};

const startupFiles: string[] = [];
let fileHandler: ((file: string) => void) | undefined;
export function receiveOpenFile(file: string) {
  if (!validOpenFile(file)) return;
  if (fileHandler) fileHandler(file);
  else if (startupFiles.length < 257) startupFiles.push(file);
}

const startupLinks: AppLink[] = [];
let linkHandler: ((link: AppLink) => void) | undefined;
/** Installed before ready so a cold-launch open-url is retained until the renderer subscribes. */
export function receiveAppUrl(raw: string) {
  const link = parseAppLink(raw);
  if (!link) return;
  if (linkHandler) linkHandler(link);
  else if (startupLinks.length < 256) startupLinks.push(link);
}

export class Desktop extends Context.Service<
  Desktop,
  {
    events(clientId: number): Stream.Stream<DesktopEvent>;
    setSendState(
      clientId: number,
      state: { pending: number; undoAvailable: boolean },
    ): Effect.Effect<void>;
    setMenuState(clientId: number, state: NativeMenuState): Effect.Effect<void>;
    setSpace(clientId: number, space: string): Effect.Effect<void>;
    setLabels(labels: DesktopLabels): Effect.Effect<void>;
    search(query: string): Effect.Effect<void>;
    compose(): Effect.Effect<void>;
    composeMessage(input: Extract<DesktopEvent, { _tag: "ComposeMessage" }>): Effect.Effect<void>;
    showUndo(input: Extract<DesktopEvent, { _tag: "ShowUndo" }>): Effect.Effect<void>;
    openSettings(): Effect.Effect<void>;
  }
>()("openmail/Desktop") {}

export const ready = Effect.callback<void>((resume) => {
  if (app.isReady()) resume(Effect.void);
  else app.once("ready", () => resume(Effect.void));
});

export const DesktopLive = Layer.effect(
  Desktop,
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* ready;
    const run = yield* FiberSet.makeRuntime();
    const pending = new Map<number, DesktopEvent[]>();
    const listeners = new Map<number, (event: DesktopEvent) => void>();
    const spaces = new Map<number, string>();
    const menuStates = new Map<number, NativeMenuState>();
    const sendStates = createSendState();
    let activeSpace = "all";
    let labelsReady = false;
    let labels: DesktopLabels = DEFAULT_DESKTOP_LABELS;
    /** The spaces in the order of their Go menu keys, as the last refresh read them. */
    let profileIds: readonly string[] = [];
    const deliver = (event: DesktopEvent, target = focusMainWindow()) => {
      const id = target.webContents.id;
      const listener = listeners.get(id);
      if (listener) return listener(event);
      // A Go menu item can create the window it acts on. Its renderer gets the screen as a link.
      const href =
        event._tag === "NativeAction" && goesToMainWindow(event.action)
          ? goActionHref(event.action, profileIds)
          : undefined;
      const kept: DesktopEvent | undefined = href
        ? { _tag: "Navigate", href }
        : shouldBufferDesktopEvent(event)
          ? event
          : undefined;
      if (kept) pending.set(id, [...(pending.get(id) ?? []), kept]);
    };
    let fileTimer: ReturnType<typeof setTimeout> | undefined;
    const files: string[] = [];
    fileHandler = (file) => {
      // Retain one overflow sentinel so readDockFiles reports tooMany without unbounded storage.
      if (files.length <= 256) files.push(file);
      clearTimeout(fileTimer);
      fileTimer = setTimeout(() => {
        const batch = files.splice(0);
        void readDockFiles(batch).then(
          (attachments) => deliver({ _tag: "ComposeFiles", attachments }),
          (error: unknown) =>
            deliver({
              _tag: "FileError",
              reason: dockFileReason(error),
            }),
        );
      }, 100);
    };
    for (const file of startupFiles.splice(0)) fileHandler(file);
    const spellingCleanup = installSpellingMenu((patch) => run(mailbox.app.setPrefs(patch)));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        fileHandler = undefined;
        clearTimeout(fileTimer);
        spellingCleanup();
      }),
    );
    setComposeCloseHandler((win) => {
      if (listeners.has(win.webContents.id) && !win.webContents.isCrashed())
        deliver({ _tag: "ComposeClose" }, win);
      else approveComposeClose(win);
    });
    setInlinePopOutHandler((win, id) => deliver({ _tag: "PopOutDraft", id }, win));
    const command = (name: "settings" | "help" | "compose" | "inbox") =>
      deliver({ _tag: "Command", command: name });
    const navigate = (href: string) => deliver({ _tag: "Navigate", href });
    const linkError = (reason: "missing" | "failed") => deliver({ _tag: "LinkError", reason });
    /**
     * Opens a thread in the main window, in its account's All Mail, so any
     * folder finds it. A message no longer stored here opens on the web.
     */
    const showThread = (id: string) =>
      mailbox.reading.thread(id).pipe(
        Effect.flatMap((messages) =>
          Effect.map(mailbox.accounts.accounts, (accounts) => {
            const owner = accounts.find((account) => account.id === messages[0]?.accountId);
            navigate(
              mailHref(
                {
                  space: owner?.profileId ?? "all",
                  mailbox: "all",
                  ...(owner ? { accountId: owner.id } : {}),
                },
                { thread: id },
              ),
            );
          }),
        ),
        Effect.catchTag("NotFound", () =>
          Effect.gen(function* () {
            const prefs = yield* mailbox.app.prefs;
            const url = yield* mailbox.reading.messageWebUrl(id);
            yield* Effect.promise(() => openExternal(url, prefs.cleanLinks !== false));
          }).pipe(Effect.catch(() => Effect.sync(() => linkError("missing")))),
        ),
        Effect.catchCause((cause) =>
          logWarning("thread-link-open-failed", "could not open the linked thread", cause).pipe(
            Effect.andThen(Effect.sync(() => linkError("failed"))),
          ),
        ),
      );
    const openThread = (id: string) => run(showThread(id));
    const edit = (action: "undo" | "selectAll") => {
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused) return;
      if (isMainWindow(focused))
        void menuEdit(focused.webContents, action, () =>
          deliver({ _tag: "Edit", action }, focused),
        );
      else if (action === "undo") focused.webContents.undo();
      else focused.webContents.selectAll();
    };
    linkHandler = (link) => {
      if (link.kind === "compose") deliver({ _tag: "Compose", draft: link.draft });
      else
        run(
          Effect.gen(function* () {
            const accounts = yield* mailbox.accounts.accounts;
            const owner = accounts.find((account) => link.id.startsWith(`${account.id}/`));
            if (owner?.enabled === false) return;
            // Legacy uncached links retain their launch behavior. New single links resolve and validate ownership.
            const id =
              link.id.startsWith("rfc:") || link.single !== undefined
                ? yield* mailbox.reading.resolveMailLink(link.id)
                : link.id;
            if (link.single) openMessageWindow(id);
            else yield* showThread(id);
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => linkError(error._tag === "NotFound" ? "missing" : "failed")),
            ),
            Effect.catchCause((cause) =>
              logWarning("link-open-failed", "could not open the link", cause).pipe(
                Effect.andThen(Effect.sync(() => linkError("failed"))),
              ),
            ),
          ),
        );
    };

    // Template image adapts to the menu bar's light/dark appearance. A hidden run has no tray.
    const tray = createTray(() => {
      const icon = nativeImage.createFromPath(
        app.isPackaged
          ? path.join(process.resourcesPath, "trayTemplate.png")
          : fileURLToPath(new URL("../../build/trayTemplate.png", import.meta.url)),
      );
      icon.setTemplateImage(true);
      return icon;
    });
    tray?.setToolTip(APP_TITLE);
    yield* Effect.addFinalizer(() => Effect.sync(() => tray?.destroy()));

    let checkingUpdates = false;
    const checkUpdates = () => {
      if (checkingUpdates) return;
      checkingUpdates = true;
      run(
        manualUpdateCheck(mailbox, labels).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              checkingUpdates = false;
            }),
          ),
        ),
      );
    };
    let menuKey = "";
    /** The window focused last, which Close window acts on while the app is in the background. */
    let lastUsedWindow: BrowserWindow | undefined;
    /** The spaces the Go menu listed last, kept while no main window reports them. */
    let lastMenuSpaces: readonly string[] | undefined;
    const refreshLock = yield* Semaphore.make(1);
    const menuLock = yield* Semaphore.make(1);
    /**
     * The unread counts and recent unread mail: the dock badge and menu and the menu-bar icon. It
     * reads the database (a count per account and an unread inbox page), so it runs on mail
     * changes, focus and the periodic tick, not on every selection change.
     */
    const refreshCounts = Effect.gen(function* () {
      const accounts = yield* mailbox.accounts.accounts;
      for (const [notification, ids] of notificationAccounts) {
        if (ids.some((id) => accounts.find((a) => a.id === id)?.enabled === false)) {
          notification.close();
          notifications.delete(notification);
          notificationAccounts.delete(notification);
        }
      }
      const profiles = yield* mailbox.accounts.profiles;
      profileIds = profiles.map((profile) => profile.id);
      if (
        activeSpace !== "all" &&
        activeSpace !== "overview" &&
        !profiles.some((p) => p.id === activeSpace)
      )
        activeSpace = "all";
      const accountIds = spaceAccountIds(activeSpace, accounts);
      const prefs = yield* mailbox.app.prefs;
      configureSpelling(prefs);
      const folderCounts = yield* mailbox.reading.unreadCounts;
      const counts = prefs.threadGrouping
        ? Object.fromEntries(
            yield* Effect.forEach(accounts, (account) =>
              mailbox.reading
                .threadCount({
                  mailbox: "inbox",
                  accountIds: [account.id],
                  unreadOnly: true,
                  flat: true,
                })
                .pipe(
                  Effect.orDie,
                  Effect.map((count) => [account.id, count]),
                ),
            ),
          )
        : folderCounts;
      app.dock?.setMenu(
        Menu.buildFromTemplate([
          { label: labels.compose, click: () => command("compose") },
          { type: "separator" },
          ...accounts
            .filter((a) => a.enabled !== false)
            .map((a) => ({
              label: `${a.description?.trim() || a.email} (${counts[a.id] ?? 0})`,
              click: () => navigate(mailHref({ space: "all", mailbox: "inbox", accountId: a.id })),
            })),
        ]),
      );
      const unread = accountIds.reduce((total, id) => total + (counts[id] ?? 0), 0);
      const recent = yield* mailbox.reading
        .threads({
          mailbox: "inbox",
          unreadOnly: true,
          accountIds,
          limit: MENU_BAR_MAIL_LIMIT,
          flat: true,
        })
        .pipe(Effect.orDie);
      const title = profiles.find((p) => p.id === activeSpace)?.name ?? labels.allAccounts;
      app.setBadgeCount(dockUnreadCount(activeSpace, accounts, counts, prefs, new Date()));
      if (process.platform === "darwin")
        tray?.setTitle(menuBarCountTitle(prefs.menuBarUnreadCount, unread));
      tray?.setToolTip(`${APP_TITLE} · ${title} (${unread})`);
      tray?.setContextMenu(
        Menu.buildFromTemplate([
          { label: `${title} (${unread})`, enabled: false },
          { type: "separator" },
          ...recent.map((thread) => ({
            label: `${thread.from.name || thread.from.address}: ${thread.subject || "…"}`.slice(
              0,
              100,
            ),
            click: () => openThread(thread.id),
          })),
          ...(recent.length ? [] : [{ label: labels.noUnread, enabled: false }]),
          { type: "separator" },
          { label: labels.showInbox, click: () => command("inbox") },
          { label: labels.compose, click: () => command("compose") },
          { label: labels.settings, click: () => command("settings") },
        ]),
      );
    });
    /**
     * The application menu, from the focused window's selection and send state. It reads only the
     * prefs, so a selection change rebuilds the menu without the count queries above, which held
     * the main process for over a second on a 20k-message database.
     */
    const refreshMenu = menuLock.withPermits(1)(
      Effect.gen(function* () {
        const prefs = yield* mailbox.app.prefs;
        const focused = BrowserWindow.getFocusedWindow();
        const undoAvailable = focused
          ? (sendStates.get(focused.webContents.id)?.undoAvailable ?? false)
          : false;
        const lastUsed =
          lastUsedWindow && !lastUsedWindow.isDestroyed() && isMainWindow(lastUsedWindow)
            ? [lastUsedWindow]
            : [];
        const menuState = focused
          ? (menuStates.get(focused.webContents.id) ?? NO_MENU_SELECTION)
          : unfocusedMenuState(
              [...lastUsed, ...BrowserWindow.getAllWindows().filter(isMainWindow)].map((win) =>
                menuStates.get(win.webContents.id),
              ),
              lastMenuSpaces,
            );
        if (menuState.spaces) lastMenuSpaces = menuState.spaces;
        const nextMenuKey = JSON.stringify([labels, prefs.shortcutSet, undoAvailable, menuState]);
        if (menuKey !== nextMenuKey) {
          menuKey = nextMenuKey;
          Menu.setApplicationMenu(
            Menu.buildFromTemplate(
              applicationMenuTemplate({
                platform: process.platform,
                labels,
                shortcutSet: prefs.shortcutSet,
                undoAvailable,
                menuState,
                tabMenu: nativeTabMenu(prefs.shortcutSet),
                checkUpdates,
                command,
                feedback: () => deliver({ _tag: "Command", command: "feedback" }),
                closeWindow: () => {
                  const target = closeWindowTarget({
                    platform: process.platform,
                    focused: BrowserWindow.getFocusedWindow(),
                    lastUsed:
                      lastUsedWindow && !lastUsedWindow.isDestroyed() ? lastUsedWindow : null,
                    appActive: process.platform === "darwin" && app.isActive(),
                    sheetOpen: (win) => menuStates.get(win.webContents.id)?.sheet === true,
                  });
                  if (target._tag === "Sheet") deliver({ _tag: "CloseSheet" }, target.window);
                  else if (target._tag === "Window") target.window.close();
                  else if (target._tag === "FirstResponder")
                    Menu.sendActionToFirstResponder("performClose:");
                },
                openHelp: () =>
                  run(
                    Effect.tryPromise(() => openExternal(OPENMAIL_DOCS_URL)).pipe(
                      Effect.catchCause((cause) =>
                        logWarning("link-open-failed", "could not open the help site", cause),
                      ),
                    ),
                  ),
                attachFiles: () => {
                  const attachTarget = BrowserWindow.getFocusedWindow();
                  deliver(
                    { _tag: "AttachFiles" },
                    attachTarget && (isMainWindow(attachTarget) || isComposeWindow(attachTarget))
                      ? attachTarget
                      : focusMainWindow(),
                  );
                },
                newWindow: () => createMainWindow(),
                edit,
                undoSend: () => {
                  const target = BrowserWindow.getFocusedWindow();
                  if (target && (isMainWindow(target) || isComposeWindow(target)))
                    deliver({ _tag: "UndoSend" }, target);
                },
                nativeAction: (action, triggeredByAccelerator) => {
                  // With no window focused the Go menu shows the state of the window used last.
                  const target =
                    BrowserWindow.getFocusedWindow() ??
                    (goesToMainWindow(action)
                      ? focusMainWindow(
                          lastUsedWindow && !lastUsedWindow.isDestroyed()
                            ? lastUsedWindow
                            : undefined,
                        )
                      : null);
                  if (target)
                    deliver({ _tag: "NativeAction", action, triggeredByAccelerator }, target);
                },
              }),
            ),
          );
        }
      }),
    );
    const refresh = refreshLock.withPermits(1)(
      Effect.gen(function* () {
        yield* refreshCounts;
        yield* refreshMenu;
        yield* notify;
      }),
    );

    const { notifications, notificationAccounts, wireNotification, notify } = makeNotifications({
      mailbox,
      run,
      openThread,
      labels: () => labels,
      ready: () => labelsReady,
    });
    yield* Effect.promise(async () => {
      if ((await notificationPermission()) === "notDetermined") await notificationPermission(true);
    }).pipe(Effect.forkScoped);

    // Each batch is every event waiting since the last one ran, so a burst of changes (a local
    // write and its push, or a sync) runs one refresh rather than one refresh per change.
    yield* mailbox.app.events.pipe(
      Stream.runForEachArray((events) =>
        (events.some((event) => event._tag === "Changed")
          ? refresh
          : events.some((event) => event._tag === "NewMail")
            ? notify
            : events.some((event) => event._tag === "PrefsChanged")
              ? refreshMenu
              : Effect.void
        ).pipe(
          Effect.catchCause((cause) =>
            logError("system-refresh-failed", "system event refresh failed", cause),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    // Re-evaluate wall time without mail traffic, also immediately after sleep.
    yield* refresh.pipe(
      Effect.catchCause((cause) =>
        logError("system-refresh-failed", "periodic system refresh failed", cause),
      ),
      Effect.repeat(Schedule.spaced("15 seconds")),
      Effect.forkScoped,
    );
    const onSuspend = () => run(mailbox.sync.setSyncPaused(true));
    const onResume = () =>
      run(
        mailbox.sync
          .setSyncPaused(false)
          .pipe(Effect.andThen(mailbox.sync.pollInbox()), Effect.andThen(refresh)),
      );
    powerMonitor.on("suspend", onSuspend);
    powerMonitor.on("resume", onResume);
    yield* watchOnline(
      () => net.isOnline(),
      mailbox.sync.resetConnectivity().pipe(Effect.andThen(mailbox.sync.sync()), Effect.asVoid),
    );
    const onFocus = (_event: Electron.Event, win: BrowserWindow) => {
      lastUsedWindow = win;
      if (isMainWindow(win)) activeSpace = spaces.get(win.webContents.id) ?? "all";
      run(refresh);
    };
    let quittingApproved = false;
    approveUpdateQuit(false);
    /** Asks in the given window, the focused one or any window whose renderer listens. */
    const confirmPendingSend = (win?: BrowserWindow) =>
      askWindow(
        listeningWindow(win),
        (id) => ({ _tag: "QuitPrompt", id }),
        () =>
          nativeAsk({
            type: "warning",
            message: labels.quitPending,
            detail: labels.quitPendingDetail,
            buttons: [labels.cancel, labels.quit],
          }).then((index) => (index === 1 ? "accept" : "cancel")),
      ).then((answer) => answer === "accept");
    const cancelWaitingDesktopSends = (owner?: string) =>
      new Promise<void>((resolve, reject) => {
        run(
          mailbox.outbox
            .cancelDesktopUndoSends(owner)
            .pipe(Effect.matchCause({ onSuccess: resolve, onFailure: reject })),
        );
      });
    setRendererReloadGuard(async (win) => {
      const id = win.webContents.id;
      if (sendStates.get(id)?.pending && !(await confirmPendingSend(win))) return false;
      await cancelWaitingDesktopSends(String(id));
      sendStates.remove(id);
      return true;
    });
    let relaunchPending = false;
    const onCreated = (_event: Electron.Event, win: BrowserWindow) => {
      const id = win.webContents.id;
      const closeGuard = createQuitGuard({
        pending: async () => sendStates.get(id)?.pending ?? 0,
        fallbackPending: () => sendStates.get(id)?.pending ?? 0,
        confirm: () => confirmPendingSend(win),
        beforeQuit: () => cancelWaitingDesktopSends(String(id)),
        quit: () => {
          if (!win.isDestroyed()) {
            if (isComposeWindow(win)) approveComposeClose(win);
            else win.close();
          }
        },
      });
      win.on("close", (event) => {
        if (
          quittingApproved ||
          (!isMainWindow(win) && !isComposeWindow(win)) ||
          !sendStates.get(id)?.pending
        )
          return;
        void closeGuard(event);
      });
      win.once("closed", () => {
        run(mailbox.outbox.cancelDesktopUndoSends(String(id)));
        pending.delete(id);
        listeners.delete(id);
        spaces.delete(id);
        menuStates.delete(id);
        sendStates.remove(id);
      });
    };
    const onRendererGone = (
      _event: Electron.Event,
      contents: Electron.WebContents,
      details: Electron.RenderProcessGoneDetails,
    ) => {
      if (details.reason === "clean-exit") return;
      listeners.delete(contents.id);
      sendStates.rendererGone(contents.id);
    };
    const onBeforeQuit = createQuitGuard({
      pending: () =>
        new Promise<number>((resolve) => {
          run(
            Effect.gen(function* () {
              const held = yield* Effect.promise(() =>
                sendStates.snapshot(
                  [...listeners].map(([id, listener]) => ({
                    id,
                    request: () => listener({ _tag: "QuitCheck" }),
                  })),
                ),
              );
              const outbox = yield* mailbox.outbox.pendingSendCount;
              resolve(held + outbox);
            }).pipe(Effect.catchCause(() => Effect.sync(() => resolve(sendStates.total())))),
          );
        }),
      fallbackPending: () => sendStates.total(),
      confirm: () => confirmPendingSend(),
      beforeQuit: cancelWaitingDesktopSends,
      quit: () => {
        quittingApproved = true;
        approveUpdateQuit(!relaunchPending);
        if (relaunchPending) app.relaunch();
        app.quit();
      },
    });
    const removeRelaunch = setRecoveryRelaunch(async () => {
      relaunchPending = true;
      const approved = await onBeforeQuit({
        preventDefault: () => {
          /* No native quit event yet. */
        },
      });
      if (!approved) relaunchPending = false;
      return approved;
    });
    app.on("before-quit", onBeforeQuit);
    app.on("render-process-gone", onRendererGone);
    app.on("browser-window-focus", onFocus);
    app.on("browser-window-created", onCreated);
    app.on("activate", activate);
    app.on("window-all-closed", allClosed);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        linkHandler = undefined;
        removeRelaunch();
        app.off("before-quit", onBeforeQuit);
        app.off("render-process-gone", onRendererGone);
        app.off("browser-window-focus", onFocus);
        app.off("browser-window-created", onCreated);
        powerMonitor.off("resume", onResume);
        powerMonitor.off("suspend", onSuspend);
        app.off("activate", activate);
        app.off("window-all-closed", allClosed);
        for (const notification of notifications) {
          notification.removeAllListeners();
          if (process.platform !== "darwin") notification.close();
        }
        app.setBadgeCount(0);
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
      }),
    );
    // Delivered macOS notifications keep their message identity across an app restart.
    if (process.platform === "darwin" && app.isPackaged) {
      const history = yield* Effect.tryPromise(() => Notification.getHistory()).pipe(
        Effect.orElseSucceed(() => []),
      );
      for (const notification of history) {
        const link = parseAppLink(notification.id);
        if (link?.kind === "message") {
          const messages = yield* mailbox.reading
            .thread(link.id)
            .pipe(Effect.orElseSucceed(() => []));
          const accounts = yield* mailbox.accounts.accounts;
          const ids = messages.map((m) => m.accountId);
          if (ids.some((id) => accounts.find((a) => a.id === id)?.enabled === false)) {
            notification.close();
            continue;
          }
          notificationAccounts.set(notification, ids);
          wireNotification(notification, link.id, yield* mailbox.app.notificationActions(link.id));
        }
      }
    }
    restoreWindows();
    finishDatabaseUpgradeStartup();
    for (const link of startupLinks.splice(0)) linkHandler(link);
    yield* refresh;
    return Desktop.of({
      composeMessage: (input) => Effect.sync(() => deliver(input)),
      showUndo: (input) => Effect.sync(() => deliver(input)),
      compose: () =>
        Effect.sync(() =>
          deliver({ _tag: "Compose", draft: { to: "", cc: "", bcc: "", subject: "", body: "" } }),
        ),
      openSettings: () => Effect.sync(() => command("settings")),
      search: (query) => Effect.sync(() => deliver({ _tag: "Search", query })),
      events: (id) =>
        Stream.callback((queue) => {
          const listener = (event: DesktopEvent) => {
            Queue.offerUnsafe(queue, event);
          };
          return Effect.gen(function* () {
            listeners.set(id, listener);
            for (const event of pending.get(id) ?? []) Queue.offerUnsafe(queue, event);
            pending.delete(id);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (listeners.get(id) === listener) listeners.delete(id);
              }),
            );
            yield* Effect.never;
          });
        }),
      setMenuState: (id, state) =>
        Effect.sync(() => menuStates.set(id, state)).pipe(
          Effect.andThen(refreshMenu),
          Effect.asVoid,
        ),
      setSendState: (id, state) =>
        Effect.sync(() => sendStates.update(id, state)).pipe(Effect.andThen(refreshMenu)),
      setSpace: (id, space) =>
        Effect.gen(function* () {
          spaces.set(id, space);
          const focused = BrowserWindow.getFocusedWindow();
          if (!focused || focused.webContents.id === id || activeSpace === space) {
            activeSpace = space;
            yield* refresh;
          }
        }),
      setLabels: (next) =>
        Effect.sync(() => {
          labels = next;
          labelsReady = true;
        }).pipe(Effect.andThen(refresh)),
    });
  }),
);
