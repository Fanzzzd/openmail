import { useCallback, useState } from "react";
import { Switch, Text, View, Platform } from "react-native";
import { useLingui } from "@lingui/react";
import type { Account, MobileBackgroundPreferences } from "@openmail/core/portable";
import { useMailbox, useMailboxQuery } from "./mailbox";
import {
  backgroundPreferences,
  requestLocalPermission,
  saveBackgroundPreferences,
} from "./background";
import { styles } from "./styles";

export function BackgroundSettings({ accounts }: { accounts: Account[] }) {
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const [saved, setSaved] = useState<MobileBackgroundPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const loaded = useMailboxQuery(useCallback(() => backgroundPreferences(runtime), [runtime]));
  const value = saved ?? (loaded.kind === "ready" ? loaded.value : null);
  const update = async (
    next: MobileBackgroundPreferences,
    permission: "alerts" | "badge" | null = null,
  ) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (permission) await requestLocalPermission(permission === "badge");
      await saveBackgroundPreferences(runtime, next);
      setSaved(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  if (!value) return null;
  const toggle = (label: string, enabled: boolean, change: (enabled: boolean) => void) => (
    <View style={styles.toolbar}>
      <Text style={styles.subject}>{label}</Text>
      <Switch accessibilityLabel={label} value={enabled} disabled={busy} onValueChange={change} />
    </View>
  );
  return (
    <View>
      <Text style={styles.title}>
        {i18n._({ id: "Background and notifications", message: "Background and notifications" })}
      </Text>
      {toggle(
        i18n._({ id: "Background refresh", message: "Background refresh" }),
        value.refresh,
        (refresh) => void update({ ...value, refresh }),
      )}
      <Text style={styles.detail}>
        {Platform.OS === "android"
          ? i18n._({
              id: "Android controls refresh timing. Updates are not real-time. Requires an unmetered network and enough battery. After reboot, open the app to resume.",
              message:
                "Android controls refresh timing. Updates are not real-time. Requires an unmetered network and enough battery. After reboot, open the app to resume.",
            })
          : i18n._({
              id: "iOS decides when to refresh. Updates are not real-time. Low power and restricted networks pause refresh.",
              message:
                "iOS decides when to refresh. Updates are not real-time. Low power and restricted networks pause refresh.",
            })}
      </Text>
      <Text style={styles.subject}>
        {i18n._({ id: "New Inbox mail notifications", message: "New Inbox mail notifications" })}
      </Text>
      <Text style={styles.detail}>
        {i18n._({
          id: "Local notifications only. Message text is never shown.",
          message: "Local notifications only. Message text is never shown.",
          comment: "Message text means the body of an email.",
        })}
      </Text>
      {accounts.map((account) => (
        <View key={account.id}>
          {toggle(
            account.email,
            value.accounts.includes(account.id),
            (enabled) =>
              void update(
                {
                  ...value,
                  accounts: enabled
                    ? [...value.accounts, account.id]
                    : value.accounts.filter((id) => id !== account.id),
                },
                enabled ? "alerts" : null,
              ),
          )}
        </View>
      ))}
      {toggle(
        i18n._({ id: "Hide content on lock screen", message: "Hide content on lock screen" }),
        value.hideContent,
        (hideContent) => void update({ ...value, hideContent }),
      )}
      <Text style={styles.detail}>
        {i18n._({
          id: "Show sender only when enabled. When disabled, show sender and subject.",
          message: "Show sender only when enabled. When disabled, show sender and subject.",
        })}
      </Text>
      {toggle(
        i18n._({ id: "Unread Inbox badge", message: "Unread Inbox badge" }),
        value.badge,
        (badge) => void update({ ...value, badge }, badge ? "badge" : null),
      )}
      {(failed || loaded.kind === "failed") && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not enable background or notification settings. Check system permissions and try again.",
            message:
              "Could not enable background or notification settings. Check system permissions and try again.",
          })}
        </Text>
      )}
    </View>
  );
}
