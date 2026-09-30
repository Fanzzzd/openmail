import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";

vi.mock("@openmail/core", () => import("../../../../packages/core/src/index.js"));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const windows: FakeWindow[] = [];
  const notifications: FakeNotification[] = [];
  let focusedId: number | null = null;
  let nextId = 0;
  const app = Object.assign(new EventEmitter(), {
    isReady: () => true,
    isPackaged: false,
    getPreferredSystemLanguages: () => ["en"],
    getLocale: () => "en",
    setBadgeCount: vi.fn<(count: number) => boolean>(() => true),
    quit: vi.fn(),
  });
  class FakeWindow extends EventEmitter {
    static getAllWindows = () => [...windows];
    static getFocusedWindow = () => windows.find((win) => win.webContents.id === focusedId) ?? null;
    webContents = Object.assign(new EventEmitter(), {
      id: ++nextId,
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
    });
    closed = false;
    query: Record<string, string> = {};
    constructor() {
      super();
      windows.push(this);
      app.emit("browser-window-created", {}, this);
    }
    loadFile(_path: string, options: { query: Record<string, string> }) {
      this.query = options.query;
      return Promise.resolve();
    }
    loadURL() {
      return Promise.resolve();
    }
    show() {
      this.focus();
    }
    focus() {
      focusedId = this.webContents.id;
      app.emit("browser-window-focus", {}, this);
    }
    isMinimized() {
      return false;
    }
    restore() {
      this.focus();
    }
    isDestroyed() {
      return this.closed;
    }
    destroy() {
      this.closed = true;
      this.emit("closed");
      windows.splice(windows.indexOf(this), 1);
    }
  }
  class FakeNotification extends EventEmitter {
    static isSupported = () => true;
    static getHistory = async () => [...notifications];
    get id() {
      return this.options.id ?? "";
    }
    show = vi.fn();
    close = vi.fn();
    constructor(readonly options: { id?: string; actions: { text: string }[]; title: string }) {
      super();
      notifications.push(this);
    }
  }
  class FakeTray {
    static instances: FakeTray[] = [];
    menu: unknown = [];
    destroyed = false;
    constructor() {
      FakeTray.instances.push(this);
    }
    setToolTip() {
      /* OS tooltip */
    }
    setContextMenu(menu: unknown) {
      this.menu = menu;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    app,
    BrowserWindow: FakeWindow,
    Notification: FakeNotification,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: vi.fn() },
    nativeImage: { createFromPath: () => ({ setTemplateImage: vi.fn() }) },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: vi.fn() },
    testState: {
      badge: app.setBadgeCount,
      setPackaged: (value: boolean) => {
        app.isPackaged = value;
      },
      restore: (id: string) => new FakeNotification({ id, title: "Restored", actions: [] }),
      windows,
      notifications,
      reset: () => {
        app.isPackaged = false;
        windows.length = 0;
        focusedId = null;
        FakeTray.instances.length = 0;
        notifications.length = 0;
      },
    },
  };
});

import { Mailbox, messageLink } from "@openmail/core";
import { fakeServer, TestMailbox } from "../../../../packages/core/src/testing.js";
import type { IncomingMessage } from "../../../../packages/core/src/domain.js";
import { Desktop, DesktopLive, receiveAppUrl } from "./system";
import { createMainWindow } from "./windows";

// Expose test-only observations without narrowing Electron's production API with a cast.
const observations = await vi.importMock<{
  testState: {
    badge: Mock<(count: number) => boolean>;
    setPackaged(value: boolean): void;
    restore(id: string): { emit(event: string, data?: unknown): void };
    windows: { webContents: { id: number }; query: Record<string, string>; focus(): void }[];
    notifications: {
      options: { actions: { text: string }[]; title: string };
      emit(event: string, data?: unknown): void;
    }[];
    reset(): void;
  };
}>("electron");
const incoming = (id: string): IncomingMessage => ({
  providerId: id,
  threadId: `t-${id}`,
  subject: id,
  from: { name: "Ann", address: "ann@x.com" },
  to: [],
  cc: [],
  date: Date.now() + 1000,
  snippet: "Hi",
  bodyText: "Hi",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD"],
  isUnread: true,
  isStarred: false,
  attachments: [],
});
const desktopLayer = (server: ReturnType<typeof fakeServer>) =>
  DesktopLive.pipe(Layer.provideMerge(TestMailbox({ gmail: server })));
const settle = Effect.sleep("20 millis");
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
afterEach(() => {
  if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");
});
beforeEach(() => {
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: "/tmp/openmail-test-resources",
  });
  observations.testState.reset();
  observations.testState.badge.mockClear();
});

it("buffers cold launch links, targets one main window, and keeps each window's space", async () => {
  const server = fakeServer("me@gmail.com", [incoming("one")]);
  receiveAppUrl(messageLink("gmail:me@gmail.com/one"));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const desktop = yield* Desktop;
        const m = yield* Mailbox;
        yield* m.connect({ provider: "gmail" });
        yield* m.sync();
        const first = observations.testState.windows[0];
        expect(first).toBeDefined();
        if (!first) return;
        const launch = yield* desktop
          .events(first.webContents.id)
          .pipe(Stream.take(1), Stream.runCollect);
        expect([...launch]).toEqual([{ _tag: "OpenThread", id: "gmail:me@gmail.com/one" }]);
        first.focus();
        yield* desktop.setSpace(first.webContents.id, "all");
        expect(observations.testState.badge).toHaveBeenLastCalledWith(1);
        const profile = yield* m.createProfile({ name: "Empty", color: "blue", icon: "briefcase" });
        const second = createMainWindow();
        second.focus();
        yield* desktop.setSpace(second.webContents.id, profile.id);
        expect(observations.testState.badge).toHaveBeenLastCalledWith(0);
        first.focus();
        yield* settle;
        expect(observations.testState.badge).toHaveBeenLastCalledWith(1);
        const events: unknown[] = [];
        yield* desktop.events(second.webContents.id).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        second.focus();
        receiveAppUrl("mailto:to+tag@example.com?cc=c%40example.com&subject=hello&body=body");
        yield* settle;
        expect(events).toEqual([
          {
            _tag: "Compose",
            draft: {
              to: "to+tag@example.com",
              cc: "c@example.com",
              bcc: "",
              subject: "hello",
              body: "body",
            },
          },
        ]);
        expect(first.query.thread).toBeUndefined();
      }),
    ).pipe(Effect.provide(desktopLayer(server))),
  );
  expect(observations.testState.badge).toHaveBeenLastCalledWith(0);
  expect(observations.testState.windows).toHaveLength(0);
});

it("notification clicks open threads; Archive and Delete are audited as the person at the app", async () => {
  const server = fakeServer("me@gmail.com", [incoming("initial")]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const m = yield* Mailbox;
        const desktop = yield* Desktop;
        yield* m.connect({ provider: "gmail" });
        yield* m.sync();
        yield* settle;
        expect(observations.testState.notifications).toHaveLength(0);
        server.messages.set("new", incoming("new"));
        yield* m.pollInbox();
        yield* settle;
        const notification = observations.testState.notifications[0];
        expect(notification?.options.actions).toEqual([
          { type: "button", text: "Archive" },
          { type: "button", text: "Delete" },
        ]);
        if (!notification) return;
        notification.emit("click");
        const mainWindow = observations.testState.windows[0];
        if (!mainWindow) return;
        const click = yield* desktop
          .events(mainWindow.webContents.id)
          .pipe(Stream.take(1), Stream.runCollect);
        expect([...click]).toEqual([{ _tag: "OpenThread", id: "gmail:me@gmail.com/new" }]);
        notification.emit("action", { actionIndex: 0 });
        yield* settle;
        expect(server.pushed.at(-1)).toEqual({ providerId: "new", op: { kind: "archive" } });
        expect((yield* m.audit(1))[0]?.actor).toBe("user:app");
        server.messages.set("delete", incoming("delete"));
        yield* m.pollInbox();
        yield* settle;
        observations.testState.notifications.at(-1)?.emit("action", { actionIndex: 1 });
        yield* settle;
        expect(server.pushed.at(-1)).toEqual({ providerId: "delete", op: { kind: "trash" } });
        expect((yield* m.audit(1))[0]?.actor).toBe("user:app");
        yield* m.sync();
        yield* settle;
        expect(observations.testState.notifications).toHaveLength(2);
        // Closing a subscriber releases it; the next event waits for a new renderer.
        const waiting = yield* desktop
          .events(mainWindow.webContents.id)
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
        receiveAppUrl(messageLink("gmail:me@gmail.com/delete"));
        const buffered = yield* desktop
          .events(mainWindow.webContents.id)
          .pipe(Stream.take(1), Stream.runCollect);
        expect([...buffered]).toEqual([{ _tag: "OpenThread", id: "gmail:me@gmail.com/delete" }]);
      }),
    ).pipe(Effect.provide(desktopLayer(server))),
  );
});

it.skipIf(process.platform !== "darwin")(
  "reattaches delivered notification actions after restarting the packaged app",
  async () => {
    const server = fakeServer("me@gmail.com", [incoming("one")]);
    observations.testState.setPackaged(true);
    const restored = observations.testState.restore(messageLink("gmail:me@gmail.com/one"));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const m = yield* Mailbox;
          const desktop = yield* Desktop;
          yield* m.connect({ provider: "gmail" });
          yield* m.sync();
          restored.emit("click");
          const mainWindow = observations.testState.windows[0];
          expect(mainWindow).toBeDefined();
          if (!mainWindow) return;
          const click = yield* desktop
            .events(mainWindow.webContents.id)
            .pipe(Stream.take(1), Stream.runCollect);
          expect([...click]).toEqual([{ _tag: "OpenThread", id: "gmail:me@gmail.com/one" }]);
          restored.emit("action", { actionIndex: 0 });
          yield* settle;
          expect(server.pushed.at(-1)).toEqual({ providerId: "one", op: { kind: "archive" } });
        }),
      ).pipe(Effect.provide(desktopLayer(server))),
    );
  },
);

it("commands without a subscribed renderer are dropped instead of replayed after a link", async () => {
  const electron = await import("electron");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const desktop = yield* Desktop;
        const template = vi.spyOn(electron.Menu, "setApplicationMenu").mock.calls.at(-1)?.[0];
        // The fake Menu returns the template itself; inspect it as an IO boundary.
        const menu = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({
              label: Schema.optionalKey(Schema.String),
              submenu: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({
                    label: Schema.optionalKey(Schema.String),
                    click: Schema.optionalKey(Schema.Unknown),
                  }),
                ),
              ),
            }),
          ),
        )(template);
        const click = menu
          .find((item) => item.label === "File")
          ?.submenu?.find((item) => item.label === "New message")?.click;
        expect(typeof click).toBe("function");
        if (typeof click === "function") click();
        receiveAppUrl("mailto:link@example.com");
        const window = observations.testState.windows[0];
        expect(window).toBeDefined();
        if (!window) return;
        const events = yield* desktop
          .events(window.webContents.id)
          .pipe(Stream.take(1), Stream.runCollect);
        expect(events[0]?._tag).toBe("Compose");
      }),
    ).pipe(Effect.provide(desktopLayer(fakeServer("me@gmail.com")))),
  );
});
it("a burst over five unread messages produces one summary notification", async () => {
  const server = fakeServer("me@gmail.com");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* m.connect({ provider: "gmail" });
        yield* m.sync();
        for (let n = 0; n < 6; n++)
          server.messages.set(String(n), { ...incoming(String(n)), date: Date.now() + 1000 });
        yield* m.pollInbox();
        yield* settle;
        expect(observations.testState.notifications).toHaveLength(1);
        expect(observations.testState.notifications[0]?.options.title).toContain("6");
      }),
    ).pipe(Effect.provide(desktopLayer(server))),
  );
});
