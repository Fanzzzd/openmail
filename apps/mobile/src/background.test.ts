import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import {
  Mailbox,
  MobileBackgroundStorageLive,
  DEFAULT_MOBILE_BACKGROUND,
  type Message,
} from "@openmail/core/portable";
import { Store, TestMailbox, fakeServer } from "@openmail/core/testing/node";
import { MemoryPlatform } from "../../../packages/core/src/platform/node/platform-memory";

const native = vi.hoisted(() => ({
  state: "background",
  os: "ios",
  online: true,
  lowPower: false,
  networkAllowed: true,
  granted: true,
  schedule: vi.fn(async () => "local"),
  badge: vi.fn(async () => true),
  request: vi.fn(async () => ({ granted: true })),
  channel: vi.fn(),
  deleteChannel: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  expiration: null as (() => void) | null,
  stateListener: null as ((state: string) => void) | null,
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  AppState: {
    get currentState() {
      return native.state;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.stateListener = listener;
      return {
        remove: () => {
          native.stateListener = null;
        },
      };
    },
  },
}));
vi.mock("expo", () => ({
  requireNativeModule: () => ({ backgroundNetworkAllowed: async () => native.networkAllowed }),
}));
vi.mock("expo-network", () => ({
  getNetworkStateAsync: async () => ({
    isConnected: native.online,
    isInternetReachable: native.online,
  }),
}));
vi.mock("expo-battery", () => ({ isLowPowerModeEnabledAsync: async () => native.lowPower }));
vi.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Available: 1, Restricted: 2 },
  getStatusAsync: async () => 1,
  registerTaskAsync: native.register,
  unregisterTaskAsync: native.unregister,
  addExpirationListener: (listener: () => void) => {
    native.expiration = listener;
    return {
      remove: () => {
        native.expiration = null;
      },
    };
  },
}));
vi.mock("expo-task-manager", () => ({ defineTask: vi.fn() }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  scheduleNotificationAsync: native.schedule,
  setBadgeCountAsync: native.badge,
  getPermissionsAsync: async () => ({ granted: native.granted }),
  requestPermissionsAsync: native.request,
  setNotificationChannelAsync: native.channel,
  deleteNotificationChannelAsync: native.deleteChannel,
  AndroidImportance: { DEFAULT: 3 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
}));
vi.mock("./i18n", () => ({ i18n: { _: () => "New mail" }, activateLanguage: vi.fn() }));
vi.mock("./platform", () => ({
  mobileMailboxLayer: () =>
    Layer.mergeAll(
      TestMailbox(
        { gmail: fakeServer("me@example.test") },
        { backgroundFlush: false, imapIdle: false, localDraftQueue: true },
      ),
      MobileBackgroundStorageLive.pipe(Layer.provide(MemoryPlatform())),
    ),
}));
import {
  attachBackgroundRuntime,
  deliverNewMail,
  notificationEvents,
  runBackgroundRefresh,
  requestLocalPermission,
  setVisibleMailbox,
  saveBackgroundPreferences,
} from "./background";
import { mailNotification, notificationRoute } from "./background-policy";
const createTestRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(
      TestMailbox(
        { gmail: fakeServer("me@example.test") },
        { backgroundFlush: false, imapIdle: false, localDraftQueue: true },
      ),
      MobileBackgroundStorageLive.pipe(Layer.provide(MemoryPlatform())),
    ),
  );
let runtime = createTestRuntime();
const source = (id: string, accountId: string): Message => ({
  id: `${accountId}/${id}`,
  accountId,
  threadId: "thread",
  subject: "private subject",
  from: { name: "Alice", address: "alice@example.test" },
  to: [],
  cc: [],
  date: Date.now(),
  snippet: "private body",
  bodyText: "private body",
  bodyHtml: "<p>private body</p>",
  labels: ["INBOX", "UNREAD"],
  isUnread: true,
  isStarred: false,
  attachments: [],
  hasAttachments: false,
});
beforeEach(() => {
  native.state = "background";
  native.os = "ios";
  native.online = true;
  native.lowPower = false;
  native.networkAllowed = true;
  native.granted = true;
  vi.clearAllMocks();
  runtime = createTestRuntime();
  attachBackgroundRuntime(runtime);
  setVisibleMailbox(null);
});
afterEach(async () => {
  attachBackgroundRuntime(null);
  await runtime.dispose();
  vi.useRealTimers();
});
const seed = async () => {
  const mailbox = await runtime.runPromise(Mailbox);
  const account = await runtime.runPromise(mailbox.connect({ provider: "gmail" }));
  await runtime.runPromise(mailbox.sync());
  const message = source("new", account.id);
  await runtime.runPromise(
    Effect.flatMap(Store, (store) =>
      store.upsertMessage(account.id, { ...message, providerId: "new" }),
    ),
  );
  return { mailbox, account, message };
};
it("default notification excludes subject and all message text; reader tap safely round-trips opaque IDs", () => {
  const message = source("folder:报价/1", "imap:me@example.test");
  const notification = mailNotification(message, true, "New mail");
  expect(notification.content).not.toHaveProperty("body");
  expect(JSON.stringify(notification)).not.toContain("private");
  expect(notificationRoute(notification.content.data)?.params.messageId).toBe(message.id);
  expect(notificationRoute({ url: "https://evil.test/reader" })).toBe(null);
  expect(notificationRoute({ url: "openmail:///reader?accountId=a&messageId=b/1" })).toBe(null);
  expect(mailNotification(message, false, "New mail").content.body).toBe("private subject");
  expect(
    mailNotification({ ...message, id: "different-message" }, true, "New mail").identifier,
  ).toBe(notification.identifier);
});
it("opt-in is per account, claims persistently dedupe, and visible foreground Inbox is silent", async () => {
  const { message } = await seed();
  const event = { _tag: "NewMail", accountId: message.accountId, ids: [message.id] } as const;
  await runtime.runPromise(deliverNewMail({ ...event, ids: [...event.ids] }));
  expect(native.schedule).not.toHaveBeenCalled();
  await saveBackgroundPreferences(runtime, {
    ...DEFAULT_MOBILE_BACKGROUND,
    accounts: [message.accountId],
  });
  native.state = "active";
  setVisibleMailbox({ accountId: message.accountId, label: "INBOX" });
  await runtime.runPromise(deliverNewMail({ ...event, ids: [...event.ids] }));
  native.state = "background";
  setVisibleMailbox(null);
  await runtime.runPromise(deliverNewMail({ ...event, ids: [...event.ids] }));
  expect(native.schedule).not.toHaveBeenCalled();
  const next = { ...message, id: `${message.accountId}/next` };
  await runtime.runPromise(
    Effect.flatMap(Store, (store) =>
      store.upsertMessage(message.accountId, { ...next, providerId: "next" }),
    ),
  );
  await runtime.runPromise(deliverNewMail({ ...event, ids: [next.id] }));
  await runtime.runPromise(deliverNewMail({ ...event, ids: [next.id] }));
  expect(native.schedule).toHaveBeenCalledTimes(1);
  expect(native.request).not.toHaveBeenCalled();
});
it("background is off by default, skips restricted networks and power saving, then uses scoped incremental polling", async () => {
  const { mailbox, account } = await seed();
  const poll = vi.spyOn(mailbox, "pollInbox").mockReturnValue(Effect.succeed([]));
  await runBackgroundRefresh();
  expect(poll).not.toHaveBeenCalled();
  await saveBackgroundPreferences(runtime, { ...DEFAULT_MOBILE_BACKGROUND, refresh: true });
  for (const restriction of ["online", "lowPower", "networkAllowed"] as const) {
    native[restriction] = restriction === "lowPower";
    await runBackgroundRefresh();
    expect(poll).not.toHaveBeenCalled();
    native[restriction] = restriction !== "lowPower";
  }
  await runBackgroundRefresh();
  expect(poll).toHaveBeenCalledWith([account.id], true);
  expect(native.request).not.toHaveBeenCalled();
});
it("OS expiration interrupts the actual core Effect and releases the task", async () => {
  const { mailbox } = await seed();
  await saveBackgroundPreferences(runtime, { ...DEFAULT_MOBILE_BACKGROUND, refresh: true });
  let interrupted = false;
  const { promise: ready, resolve: started } = Promise.withResolvers<void>();
  vi.spyOn(mailbox, "pollInbox").mockReturnValue(
    Effect.sync(started).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true;
        }),
      ),
    ),
  );
  const task = runBackgroundRefresh();
  await ready;
  native.expiration?.();
  expect(await task).toBe(2);
  expect(interrupted).toBe(true);
  expect(native.expiration).toBe(null);
});
it("permissions are requested only at opt-in and badge is cleared when disabled", async () => {
  await saveBackgroundPreferences(runtime, DEFAULT_MOBILE_BACKGROUND);
  expect(native.request).not.toHaveBeenCalled();
  expect(native.badge).toHaveBeenLastCalledWith(0);
  native.os = "android";
  await requestLocalPermission();
  expect(native.channel).toHaveBeenCalled();
  expect(native.request).toHaveBeenCalledTimes(1);
  await requestLocalPermission(true);
  expect(native.request).toHaveBeenLastCalledWith({
    ios: { allowAlert: false, allowBadge: true, allowSound: false },
  });
});

it("a slow account is interrupted at its share of the budget and the next account still refreshes", async () => {
  const { mailbox, account } = await seed();
  const other = await runtime.runPromise(mailbox.connect({ provider: "outlook" }));
  await runtime.runPromise(mailbox.sync());
  await saveBackgroundPreferences(runtime, { ...DEFAULT_MOBILE_BACKGROUND, refresh: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let interrupted = false;
  const { promise: ready, resolve: started } = Promise.withResolvers<void>();
  const poll = vi.spyOn(mailbox, "pollInbox").mockImplementation((ids) =>
    ids?.includes(account.id)
      ? Effect.sync(started).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        )
      : Effect.succeed([]),
  );
  const task = runBackgroundRefresh();
  await ready;
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await task).toBe(1);
  expect(interrupted).toBe(true);
  expect(poll).toHaveBeenCalledWith([other.id], true);
});
it("badge opt-in uses local unread Inbox counts and notification permission loss blocks delivery", async () => {
  const { message } = await seed();
  await saveBackgroundPreferences(runtime, {
    ...DEFAULT_MOBILE_BACKGROUND,
    accounts: [message.accountId],
    badge: true,
  });
  expect(native.badge).toHaveBeenLastCalledWith(1);
  native.granted = false;
  await runtime.runPromise(
    deliverNewMail({ _tag: "NewMail", accountId: message.accountId, ids: [message.id] }),
  );
  expect(native.schedule).not.toHaveBeenCalled();
  await saveBackgroundPreferences(runtime, DEFAULT_MOBILE_BACKGROUND);
  expect(native.badge).toHaveBeenLastCalledWith(0);
});

it("replaces the old PUBLIC Android channel with a PRIVATE channel before local delivery", async () => {
  native.os = "android";
  await requestLocalPermission();
  expect(native.channel).toHaveBeenCalledWith(
    "openmail-inbox-private-v2",
    expect.objectContaining({ lockscreenVisibility: 0 }),
  );
  expect(native.deleteChannel).toHaveBeenCalledWith("openmail-inbox");
  const { message } = await seed();
  await saveBackgroundPreferences(runtime, {
    ...DEFAULT_MOBILE_BACKGROUND,
    accounts: [message.accountId],
    hideContent: false,
  });
  await runtime.runPromise(
    deliverNewMail({ _tag: "NewMail", accountId: message.accountId, ids: [message.id] }),
  );
  expect(native.schedule).toHaveBeenCalledWith(
    expect.objectContaining({
      trigger: { channelId: "openmail-inbox-private-v2" },
      content: expect.objectContaining({
        data: expect.objectContaining({ openmailPublicTitle: "New mail" }),
      }),
    }),
  );
});
it("sanitizes untrusted sender and subject text, limits code points and uses localized fallbacks", () => {
  const message = source("dirty", "a");
  const dirty = {
    ...message,
    from: { name: "\u202e\u0000 Alice\r\n\t\u0085  Bob\u2069", address: "address@example.test" },
    subject: "\u202aSubject\u0001\u009f\u200f   text\u202c",
  };
  const request = mailNotification(dirty, false, "新邮件");
  expect(request.content.title).toBe("Alice Bob");
  expect(request.content.body).toBe("Subject text");
  const long = mailNotification(
    { ...dirty, from: { ...dirty.from, name: "😀".repeat(90) }, subject: "😀".repeat(130) },
    false,
    "新邮件",
  );
  expect(Array.from(long.content.title)).toHaveLength(80);
  expect(Array.from(long.content.body ?? "")).toHaveLength(120);
  expect(
    mailNotification(
      { ...message, from: { name: "\u202e", address: " fallback@example.test\t" } },
      true,
      "新邮件",
    ).content.title,
  ).toBe("fallback@example.test");
  expect(
    mailNotification({ ...message, from: { name: "\u0000", address: "\u2066" } }, true, "新邮件")
      .content.title,
  ).toBe("新邮件");
});
it("a badge failure cannot undo successfully saved settings", async () => {
  const { message } = await seed();
  native.badge.mockRejectedValueOnce(new Error("launcher unavailable"));
  const prefs = {
    ...DEFAULT_MOBILE_BACKGROUND,
    refresh: true,
    badge: true,
    accounts: [message.accountId],
  };
  await expect(saveBackgroundPreferences(runtime, prefs)).resolves.toBeUndefined();
  const { backgroundPreferences } = await import("./background");
  expect(await backgroundPreferences(runtime)).toEqual(prefs);
  expect(native.unregister).not.toHaveBeenCalled();
});

it("background wakes reminders locally while offline, respects account notification opt-in and never flushes provider writes", async () => {
  const { mailbox, message } = await seed();
  await runtime.runPromise(
    Effect.flatMap(Store, (store) => store.snooze(message.id, Date.now() - 1000)),
  );
  expect((await runtime.runPromise(mailbox.thread(message.id)))[0]?.labels).toContain("SNOOZED");
  await runBackgroundRefresh();
  expect((await runtime.runPromise(mailbox.thread(message.id)))[0]?.labels).toContain("SNOOZED");
  await saveBackgroundPreferences(runtime, {
    ...DEFAULT_MOBILE_BACKGROUND,
    refresh: true,
    accounts: [message.accountId],
  });
  native.online = false;
  const poll = vi.spyOn(mailbox, "pollInbox");
  await runBackgroundRefresh();
  const woken = (await runtime.runPromise(mailbox.thread(message.id)))[0];
  expect(woken?.labels).toContain("INBOX");
  expect(woken?.labels).not.toContain("SNOOZED");
  expect(poll).not.toHaveBeenCalled();
  expect(native.schedule).toHaveBeenCalledTimes(1);
  expect(native.schedule).toHaveBeenLastCalledWith(
    expect.objectContaining({ content: expect.not.objectContaining({ body: expect.any(String) }) }),
  );
  await runBackgroundRefresh();
  expect(native.schedule).toHaveBeenCalledTimes(1);
});
it("each snooze wake has its own durable claim, distinct from new-mail claims", async () => {
  const { message } = await seed();
  await saveBackgroundPreferences(runtime, {
    ...DEFAULT_MOBILE_BACKGROUND,
    accounts: [message.accountId],
  });
  await runtime.runPromise(
    deliverNewMail({ _tag: "NewMail", accountId: message.accountId, ids: [message.id] }),
  );
  const wake = {
    _tag: "SnoozeDue",
    accountId: message.accountId,
    ids: [message.id],
    wokenAt: Date.now(),
  } as const;
  await runtime.runPromise(deliverNewMail({ ...wake, ids: [...wake.ids] }));
  await runtime.runPromise(deliverNewMail({ ...wake, ids: [...wake.ids] }));
  expect(native.schedule).toHaveBeenCalledTimes(2);
  await runtime.runPromise(
    deliverNewMail({ ...wake, ids: [...wake.ids], wokenAt: wake.wokenAt + 1 }),
  );
  expect(native.schedule).toHaveBeenCalledTimes(3);
  await saveBackgroundPreferences(runtime, DEFAULT_MOBILE_BACKGROUND);
  await runtime.runPromise(
    deliverNewMail({ ...wake, ids: [...wake.ids], wokenAt: wake.wokenAt + 2 }),
  );
  expect(native.schedule).toHaveBeenCalledTimes(3);
});

it("an open offline app wakes an actual snoozed thread on the foreground timer and notifies once", async () => {
  const { foregroundReminderTimer } = await import("./workflows");
  const { mailbox, message } = await seed();
  native.state = "active";
  native.online = false;
  await saveBackgroundPreferences(runtime, {
    ...DEFAULT_MOBILE_BACKGROUND,
    accounts: [message.accountId],
  });
  await runtime.runPromise(
    Effect.flatMap(Store, (store) => store.snooze(message.id, Date.now() - 1000)),
  );
  const listener = runtime.runFork(notificationEvents(runtime));
  await runtime.runPromise(Effect.yieldNow);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const stop = foregroundReminderTimer(
    () => native.state === "active",
    () => runtime.runPromise(mailbox.wakeSnoozed()),
  );
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(native.schedule).toHaveBeenCalledTimes(1));
    expect((await runtime.runPromise(mailbox.thread(message.id)))[0]?.labels).toContain("INBOX");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.schedule).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    await runtime.runPromise(Fiber.interrupt(listener));
    vi.useRealTimers();
  }
});
