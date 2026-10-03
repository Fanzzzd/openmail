import { useCallback, useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { deviceOnline, isForeground } from "./device";
import { Mailbox, type Language } from "@openmail/core/portable";
import { Effect } from "effect";
import { useMailbox, useMailboxQuery, useMailboxRevision } from "./mailbox";
import { foregroundCoordinator } from "./workflows";
import { activateLanguage } from "./i18n";

export function useForeground() {
  const runtime = useMailbox();
  return useMemo(
    () =>
      foregroundCoordinator({
        active: isForeground,
        online: deviceOnline,
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
    void work(true).catch(() => null);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void work(true).catch(() => null);
    });
    return () => subscription.remove();
  }, [work]);
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
