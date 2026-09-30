import {
  Mailbox,
  messageLink,
  parseAppLink,
  shouldNotify,
  spaceAccountIds,
  type AppLink,
} from "@openmail/core";
import { Context, Effect, FiberSet, Layer, Queue, Semaphore, Stream } from "effect";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from "electron";

import type { DesktopEvent } from "../shared/desktop";
import type { DesktopLabels } from "../shared/desktop-labels";
import { shortcutAccelerator } from "../shared/shortcuts";
import { createMainWindow, focusMainWindow, isMainWindow } from "./windows";

const activate = () => focusMainWindow();
const allClosed = () => {
  if (process.platform !== "darwin") app.quit();
};

const startupLinks: AppLink[] = [];
let linkHandler: ((link: AppLink) => void) | undefined;
/** Installed before ready so a cold-launch open-url is retained until the renderer subscribes. */
export function receiveAppUrl(raw: string) {
  const link = parseAppLink(raw);
  if (!link) return;
  if (linkHandler) linkHandler(link);
  else startupLinks.push(link);
}

export class Desktop extends Context.Service<
  Desktop,
  {
    events(clientId: number): Stream.Stream<DesktopEvent>;
    setSpace(clientId: number, space: string): Effect.Effect<void>;
    setLabels(labels: DesktopLabels): Effect.Effect<void>;
    search(query: string): Effect.Effect<void>;
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
    let activeSpace = "all";
    let labels: DesktopLabels = {
      settings: "Settings…",
      newWindow: "New Window",
      compose: "New message",
      help: "Keyboard shortcuts",
      archive: "Archive",
      trash: "Delete",
      noUnread: "No unread mail",
      showInbox: "Show Inbox",
      allAccounts: "All accounts",
      file: "File",
      edit: "Edit",
      undo: "Undo",
      selectAll: "Select all",
      window: "Window",
      newMessages: "new messages",
    };
    const deliver = (event: DesktopEvent, target = focusMainWindow()) => {
      const id = target.webContents.id;
      const listener = listeners.get(id);
      if (listener) listener(event);
      else if (event._tag !== "Command" && event._tag !== "Edit")
        pending.set(id, [...(pending.get(id) ?? []), event]);
    };
    const command = (name: "settings" | "help" | "compose" | "inbox") =>
      deliver({ _tag: "Command", command: name });
    const openThread = (id: string) => deliver({ _tag: "OpenThread", id });
    const edit = (action: "undo" | "selectAll") => {
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused) return;
      if (isMainWindow(focused)) deliver({ _tag: "Edit", action }, focused);
      else if (action === "undo") focused.webContents.undo();
      else focused.webContents.selectAll();
    };
    linkHandler = (link) =>
      link.kind === "message"
        ? openThread(link.id)
        : deliver({ _tag: "Compose", draft: link.draft });

    // Template image adapts to the menu bar's light/dark appearance.
    const trayIcon = nativeImage.createFromPath(
      app.isPackaged
        ? path.join(process.resourcesPath, "trayTemplate.png")
        : fileURLToPath(new URL("../../build/trayTemplate.png", import.meta.url)),
    );
    trayIcon.setTemplateImage(true);
    const tray = new Tray(trayIcon);
    tray.setToolTip("OpenMail");
    yield* Effect.addFinalizer(() => Effect.sync(() => tray.destroy()));

    let menuKey = "";
    const refreshLock = yield* Semaphore.make(1);
    const refresh = refreshLock.withPermits(1)(
      Effect.gen(function* () {
        const accounts = yield* mailbox.accounts;
        const profiles = yield* mailbox.profiles;
        if (
          activeSpace !== "all" &&
          activeSpace !== "overview" &&
          !profiles.some((p) => p.id === activeSpace)
        )
          activeSpace = "all";
        const accountIds = spaceAccountIds(activeSpace, accounts);
        const counts = yield* mailbox.unreadCounts;
        const unread = accountIds.reduce((total, id) => total + (counts[id] ?? 0), 0);
        const recent = yield* mailbox.threads({
          mailbox: "inbox",
          unreadOnly: true,
          accountIds,
          limit: 10,
        });
        const prefs = yield* mailbox.prefs;
        const title = profiles.find((p) => p.id === activeSpace)?.name ?? labels.allAccounts;
        app.setBadgeCount(unread);
        tray.setToolTip(`OpenMail · ${title} (${unread})`);
        tray.setContextMenu(
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
        const nextMenuKey = JSON.stringify([labels, prefs.shortcutSet]);
        if (menuKey !== nextMenuKey) {
          menuKey = nextMenuKey;
          Menu.setApplicationMenu(
            Menu.buildFromTemplate([
              ...(process.platform === "darwin"
                ? [
                    {
                      role: "appMenu" as const,
                      submenu: [
                        { role: "about" as const },
                        { type: "separator" as const },
                        {
                          label: labels.settings,
                          accelerator: shortcutAccelerator(prefs.shortcutSet, "settings"),
                          click: () => command("settings"),
                        },
                        { type: "separator" as const },
                        { role: "hide" as const },
                        { role: "hideOthers" as const },
                        { role: "unhide" as const },
                        { type: "separator" as const },
                        { role: "quit" as const },
                      ],
                    },
                  ]
                : []),
              {
                label: labels.file,
                submenu: [
                  {
                    label: labels.compose,
                    accelerator: shortcutAccelerator(prefs.shortcutSet, "compose"),
                    click: () => command("compose"),
                  },
                  {
                    label: labels.newWindow,
                    accelerator: shortcutAccelerator(prefs.shortcutSet, "newWindow"),
                    click: () => createMainWindow(),
                  },
                  ...(process.platform !== "darwin"
                    ? [
                        {
                          label: labels.settings,
                          accelerator: shortcutAccelerator(prefs.shortcutSet, "settings"),
                          click: () => command("settings"),
                        },
                      ]
                    : []),
                  { type: "separator" },
                  { role: "close" },
                ],
              },
              {
                label: labels.edit,
                submenu: [
                  {
                    label: labels.undo,
                    accelerator: "CommandOrControl+Z",
                    click: () => edit("undo"),
                  },
                  { role: "redo" },
                  { type: "separator" },
                  { role: "cut" },
                  { role: "copy" },
                  { role: "paste" },
                  {
                    label: labels.selectAll,
                    accelerator: "CommandOrControl+A",
                    click: () => edit("selectAll"),
                  },
                ],
              },
              {
                label: labels.window,
                submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
              },
              {
                label: labels.help,
                submenu: [{ label: labels.help, click: () => command("help") }],
              },
            ]),
          );
        }
      }),
    );

    const notifications = new Set<Notification>();
    const wireNotification = (notification: Notification, id: string) => {
      notifications.add(notification);
      notification.on("click", () => openThread(id));
      // Electron 44 supplies actionIndex on the event; the positional argument is deprecated.
      notification.on("action", (event) => {
        const op =
          event.actionIndex === 0
            ? { kind: "archive" as const }
            : event.actionIndex === 1
              ? { kind: "trash" as const }
              : null;
        if (!op) return;
        notification.close();
        run(
          mailbox
            .perform({ kind: "modify", threads: [id], op }, { kind: "user", surface: "app" })
            .pipe(
              Effect.catchCause((cause) => Effect.logError("notification action failed", cause)),
            ),
        );
      });
      notification.on("close", () => notifications.delete(notification));
      notification.on("failed", () => notifications.delete(notification));
    };
    const notify = (ids: readonly string[], accountId: string) =>
      Effect.gen(function* () {
        if (!Notification.isSupported()) return;
        const accounts = yield* mailbox.accounts;
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return;
        const prefs = yield* mailbox.prefs;
        const messages = [];
        for (const id of ids) {
          const thread = yield* mailbox.thread(id).pipe(Effect.orElseSucceed(() => []));
          const message = thread.find((m) => m.id === id);
          if (message && shouldNotify(account, message, prefs, new Date())) messages.push(message);
        }
        if (messages.length > 5) {
          const first = messages[0];
          if (!first) return;
          const notification = new Notification({
            id: messageLink(first.id),
            groupId: account.profileId ?? account.id,
            title: `${messages.length} ${labels.newMessages}`,
            body: account.email,
          });
          notifications.add(notification);
          notification.on("click", () => openThread(first.id));
          notification.on("close", () => notifications.delete(notification));
          notification.on("failed", () => notifications.delete(notification));
          notification.show();
          return;
        }
        for (const message of messages) {
          const id = message.id;
          const notification = new Notification({
            id: messageLink(id),
            groupId: account.profileId ?? account.id,
            title: message.from.name || message.from.address,
            subtitle: message.subject,
            body: message.snippet,
            actions: [
              { type: "button", text: labels.archive },
              { type: "button", text: labels.trash },
            ],
          });
          wireNotification(notification, id);
          notification.show();
        }
      });

    yield* mailbox.events.pipe(
      Stream.runForEach((event) =>
        event._tag === "NewMail"
          ? notify(event.ids, event.accountId)
          : event._tag === "Changed"
            ? refresh
            : Effect.void,
      ),
      Effect.forkScoped,
    );
    const onFocus = (_event: Electron.Event, win: BrowserWindow) => {
      if (!isMainWindow(win)) return;
      activeSpace = spaces.get(win.webContents.id) ?? "all";
      run(refresh);
    };
    const onCreated = (_event: Electron.Event, win: BrowserWindow) => {
      const id = win.webContents.id;
      win.once("closed", () => {
        pending.delete(id);
        listeners.delete(id);
        spaces.delete(id);
      });
    };
    app.on("browser-window-focus", onFocus);
    app.on("browser-window-created", onCreated);
    app.on("activate", activate);
    app.on("window-all-closed", allClosed);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        linkHandler = undefined;
        app.off("browser-window-focus", onFocus);
        app.off("browser-window-created", onCreated);
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
        if (link?.kind === "message") wireNotification(notification, link.id);
      }
    }
    createMainWindow();
    for (const link of startupLinks.splice(0)) linkHandler(link);
    yield* refresh;
    return Desktop.of({
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
        }).pipe(Effect.andThen(refresh)),
    });
  }),
);
