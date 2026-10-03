import { useCallback, useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { deviceOnline, isForeground } from "./device";
import { Mailbox, type Language } from "@openmail/core/portable";
import { Effect, Fiber } from "effect";
import { useMailbox, useMailboxQuery, useMailboxRevision } from "./mailbox";
import { foregroundCoordinator } from "./workflows";
import * as Notifications from "expo-notifications";
import { router, usePathname, useGlobalSearchParams } from "expo-router";
import {
  setVisibleMailbox,
  attachBackgroundRuntime,
  notificationEvents,
  configureRefresh,
  backgroundPreferences,
  updateBadge,
  configureLocalChannel,
} from "./background";
import { migrateForegroundSecrets } from "./platform/secrets";
import { notificationRoute } from "./background-policy";
import { activateLanguage } from "./i18n";

export function useForeground() {
  const runtime = useMailbox();
  return useMemo(
    () =>
      foregroundCoordinator({
        active: isForeground,
        online: deviceOnline,
        prepare: async () => {
          const mailbox = await runtime.runPromise(Mailbox);
          const accounts = await runtime.runPromise(mailbox.accounts);
          await migrateForegroundSecrets(accounts.map((account) => account.id));
        },
        sync: () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.sync())),
        send: () =>
          runtime.runPromise(
            Effect.flatMap(Mailbox, (mailbox) => mailbox.flushQueuedSends(isForeground)),
          ),
      }),
    [runtime],
  );
}
export function ForegroundLifecycle() {
  const runtime = useMailbox();
  const revision = useMailboxRevision();
  useEffect(() => {
    attachBackgroundRuntime(runtime);
    const events = runtime.runFork(notificationEvents(runtime));
    void configureLocalChannel().catch(() => null);
    void backgroundPreferences(runtime)
      .then((preferences) => configureRefresh(preferences.refresh))
      .then(() => updateBadge(runtime))
      .catch(() => null);
    return () => {
      attachBackgroundRuntime(null);
      void runtime.runPromise(Fiber.interrupt(events)).catch(() => null);
    };
  }, [runtime]);
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ accountId?: string; label?: string }>();
  useEffect(() => {
    setVisibleMailbox(
      pathname === "/threads" && params.accountId && params.label
        ? { accountId: params.accountId, label: params.label }
        : null,
    );
    return () => setVisibleMailbox(null);
  }, [pathname, params.accountId, params.label]);
  useEffect(() => {
    let active = true;
    const open = (response: Notifications.NotificationResponse | null) => {
      const route = notificationRoute(response?.notification.request.content.data);
      if (active && route) {
        router.push(route);
        void Notifications.clearLastNotificationResponseAsync();
      }
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync()
      .then(open)
      .catch(() => null);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  const work = useForeground();
  const prefs = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.prefs)),
      [runtime],
    ),
  );
  const outbox = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.queuedSends)),
      [runtime],
    ),
  );
  useEffect(() => {
    if (prefs.kind === "ready") activateLanguage(prefs.value.language);
  }, [prefs]);
  useEffect(() => {
    const active = (foreground: boolean) =>
      foreground
        ? work(true).catch(() => null)
        : runtime
            .runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.closeSessions()))
            .catch(() => null);
    void active(isForeground());
    const subscription = AppState.addEventListener("change", (state) => {
      void active(state === "active");
    });
    return () => subscription.remove();
  }, [work, runtime]);
  useEffect(() => {
    if (revision >= 0) void work(false).catch(() => null);
  }, [revision, work]);
  useEffect(() => {
    const due =
      outbox.kind === "ready"
        ? outbox.value
            .filter((item) => item.status === "waiting" && item.due > Date.now())
            .map((item) => item.due)
        : [];
    const timer = due.length
      ? setTimeout(
          () => void work(false).catch(() => null),
          Math.max(0, Math.min(...due) - Date.now()),
        )
      : null;
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [outbox, work]);
  return null;
}
export const languageNames: Record<Language, string> = {
  system: "",
  en: "English",
  "zh-CN": "简体中文",
  cs: "Čeština",
  nl: "Nederlands",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  ja: "日本語",
  ru: "Русский",
  es: "Español",
};
