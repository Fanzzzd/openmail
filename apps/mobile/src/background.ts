import {
  Mailbox,
  MobileBackgroundStorage,
  type MailboxEvent,
  type MobileBackgroundPreferences,
} from "@openmail/core/portable";
import { Effect, Fiber, ManagedRuntime, Stream } from "effect";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import { isLowPowerModeEnabledAsync } from "expo-battery";
import { requireNativeModule } from "expo";
import { AppState, Platform } from "react-native";
import { deviceOnline, isForeground } from "./device";
import { mailNotification, shouldNotify, type VisibleMailbox } from "./background-policy";

export type BackgroundRuntime = Awaited<ReturnType<typeof createMobileRuntime>>;
export const createMobileRuntime = async () => {
  const { mobileMailboxLayer } = await import("./platform");
  return ManagedRuntime.make(mobileMailboxLayer());
};
export const INBOX_CHANNEL = "openmail-inbox-private-v2";
export const REFRESH_TASK = "openmail-background-refresh";
let liveRuntime: BackgroundRuntime | null = null;
let visible: VisibleMailbox = null;
export const setVisibleMailbox = (value: VisibleMailbox) => {
  visible = value;
};
export const attachBackgroundRuntime = (runtime: BackgroundRuntime | null) => {
  liveRuntime = runtime;
};
export const backgroundPreferences = (runtime: BackgroundRuntime) =>
  runtime.runPromise(Effect.flatMap(MobileBackgroundStorage, (storage) => storage.preferences));

export async function configureRefresh(enabled: boolean) {
  if (enabled) {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available)
      throw new Error("Background refresh is unavailable");
    await BackgroundTask.registerTaskAsync(REFRESH_TASK, { minimumInterval: 15 });
  } else await BackgroundTask.unregisterTaskAsync(REFRESH_TASK);
}
export async function configureLocalChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(INBOX_CHANNEL, {
    name: "openmail",
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: null,
    enableVibrate: false,
    showBadge: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
  await Notifications.deleteNotificationChannelAsync("openmail-inbox");
}
export async function requestLocalPermission(badgeOnly = false) {
  await configureLocalChannel();
  const result = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: !badgeOnly,
      allowBadge: true,
      allowSound: false,
    },
  });
  if (
    !result.granted ||
    (badgeOnly ? result.ios?.allowsBadge === false : result.ios?.allowsAlert === false)
  )
    throw new Error("Notification permission denied");
}
export async function saveBackgroundPreferences(
  runtime: BackgroundRuntime,
  value: MobileBackgroundPreferences,
) {
  const previous = await backgroundPreferences(runtime);
  if (value.refresh !== previous.refresh) await configureRefresh(value.refresh);
  try {
    await runtime.runPromise(
      Effect.flatMap(MobileBackgroundStorage, (storage) => storage.save(value)),
    );
  } catch (error) {
    if (value.refresh !== previous.refresh) await configureRefresh(previous.refresh);
    throw error;
  }
  await updateBadge(runtime).catch(() => null);
}
export async function updateBadge(runtime: BackgroundRuntime) {
  const preferences = await backgroundPreferences(runtime);
  const count = preferences.badge
    ? await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.unreadCounts).pipe(
          Effect.map((counts) => Object.values(counts).reduce((sum, n) => sum + n, 0)),
        ),
      )
    : 0;
  await Notifications.setBadgeCountAsync(count);
}
export const deliverNewMail = (event: Extract<MailboxEvent, { _tag: "NewMail" }>) =>
  Effect.gen(function* () {
    const storage = yield* MobileBackgroundStorage;
    const mailbox = yield* Mailbox;
    const preferences = yield* storage.preferences;
    if (!preferences.accounts.includes(event.accountId)) return;
    if (!(yield* Effect.promise(() => Notifications.getPermissionsAsync())).granted) return;
    const { i18n, activateLanguage } = yield* Effect.promise(() => import("./i18n"));
    activateLanguage((yield* mailbox.prefs).language);
    const newMail = i18n._({ id: "New mail", message: "New mail" });
    yield* Effect.promise(configureLocalChannel);
    for (const id of event.ids) {
      const messages = yield* mailbox.thread(id).pipe(Effect.catch(() => Effect.succeed([])));
      const message = messages.find((item) => item.id === id);
      if (!message) continue;
      const claimed = yield* storage.claim({ id, accountId: message.accountId });
      if (!claimed || !shouldNotify({ message, preferences, foreground: isForeground(), visible }))
        continue;
      const request = mailNotification(message, preferences.hideContent, newMail);
      yield* Effect.promise(() =>
        Notifications.scheduleNotificationAsync({
          ...request,
          trigger: Platform.OS === "android" ? { channelId: INBOX_CHANNEL } : null,
        }),
      );
    }
  });
export function notificationEvents(runtime: BackgroundRuntime) {
  return Effect.flatMap(Mailbox, (mailbox) =>
    Stream.runForEach(mailbox.events, (event) => {
      const action =
        event._tag === "NewMail"
          ? deliverNewMail(event)
          : event._tag === "Changed"
            ? Effect.promise(() => updateBadge(runtime))
            : Effect.void;
      const pruned =
        event._tag === "Changed"
          ? Effect.flatMap(MobileBackgroundStorage, (storage) => storage.prune)
          : Effect.void;
      return pruned.pipe(
        Effect.andThen(action),
        Effect.catchCause(() => Effect.void),
      );
    }),
  );
}
async function networkAllowed() {
  if (!(await deviceOnline()) || (await isLowPowerModeEnabledAsync())) return false;
  // Android WorkManager is patched to require an unmetered network and battery-not-low.
  return (
    Platform.OS !== "ios" ||
    (await requireNativeModule<{ backgroundNetworkAllowed(): Promise<boolean> }>(
      "OpenmailStorage",
    ).backgroundNetworkAllowed())
  );
}
/** One interrupted Effect, including notifications, owns the entire ~25-second execution budget. */
export async function runBackgroundRefresh() {
  const owned = liveRuntime === null;
  const runtime = liveRuntime ?? (await createMobileRuntime());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const expiration =
    Platform.OS === "ios" ? BackgroundTask.addExpirationListener(() => controller.abort()) : null;
  const foreground = AppState.addEventListener("change", (state) => {
    if (state === "active") controller.abort();
  });
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* MobileBackgroundStorage;
        if (!(yield* storage.preferences).refresh || isForeground()) return;
        if (!(yield* Effect.promise(networkAllowed))) return;
        const mailbox = yield* Mailbox;
        const pending: Extract<MailboxEvent, { _tag: "NewMail" }>[] = [];
        const events = yield* Stream.runForEach(mailbox.events, (event) =>
          Effect.sync(() => {
            if (event._tag === "NewMail") pending.push(event);
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const accounts = (yield* mailbox.accounts).filter(
          (account) =>
            account.enabled !== false && account.lastSyncedAt !== null && !account.needsReauth,
        );
        // Give every account a turn; one slow server cannot consume the whole budget.
        const slice = Math.max(1, Math.floor(20_000 / Math.max(1, accounts.length)));
        for (const account of accounts) {
          if (
            isForeground() ||
            !(yield* storage.preferences).refresh ||
            !(yield* Effect.promise(networkAllowed))
          )
            break;
          yield* mailbox.pollInbox([account.id], true).pipe(
            Effect.timeout(`${slice} millis`),
            Effect.catchCause(() => Effect.void),
          );
        }
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(events);
        for (const event of pending)
          yield* deliverNewMail(event).pipe(Effect.catchCause(() => Effect.void));
        yield* Effect.promise(() => updateBadge(runtime));
      }).pipe(Effect.scoped),
      { signal: controller.signal },
    );
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    clearTimeout(timer);
    expiration?.remove();
    foreground.remove();
    if (owned) await runtime.dispose();
  }
}
TaskManager.defineTask(REFRESH_TASK, runBackgroundRefresh);
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const quiet =
      isForeground() &&
      visible?.label === "INBOX" &&
      visible.accountId === notification.request.content.data?.openmailAccount;
    return {
      shouldShowBanner: !quiet,
      shouldShowList: !quiet,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});
