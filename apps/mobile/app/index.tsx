import { Mailbox } from "@openmail/core/portable";
import { Effect } from "effect";
import { useLingui } from "@lingui/react";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useMailbox, useMailboxQuery } from "../src/mailbox";
import { styles } from "../src/styles";

export default function Accounts() {
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = useCallback(
    () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts)),
    [runtime],
  );
  const accounts = useMailboxQuery(load);
  const setup = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.clientSetup)),
      [runtime],
    ),
  );
  const configured = (provider: "gmail" | "outlook") =>
    setup.kind === "ready" &&
    (provider === "gmail" ? setup.value.googleConfigured : setup.value.microsoftConfigured);
  const connect = async (provider: "gmail" | "outlook") => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const account = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.connect({ provider })),
      );
      router.push({ pathname: "/mailboxes", params: { accountId: account.id } });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    setError(false);
    try {
      const result = await runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.sync()));
      setError(result.some((item) => Boolean(item.error)));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.screen}>
      <FlatList
        data={accounts.kind === "ready" ? accounts.value : []}
        keyExtractor={(account) => account.id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void refresh()} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            style={styles.row}
            onPress={() => router.push({ pathname: "/mailboxes", params: { accountId: item.id } })}
          >
            <Text style={styles.subject}>{item.email}</Text>
            <Text style={styles.detail}>{item.provider}</Text>
            {item.needsReauth && (
              <Text style={styles.error}>
                {i18n._({ id: "Sign in again", message: "Sign in again" })}
              </Text>
            )}
          </Pressable>
        )}
        ListEmptyComponent={
          accounts.kind === "loading" ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.empty}>
              {i18n._({ id: "No accounts yet", message: "No accounts yet" })}
            </Text>
          )
        }
        ListFooterComponent={
          <View>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !configured("gmail")}
              style={[styles.button, !configured("gmail") && styles.muted]}
              onPress={() => void connect("gmail")}
            >
              <Text style={styles.action}>
                {i18n._({ id: "Add Gmail account", message: "Add Gmail account" })}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !configured("outlook")}
              style={[styles.button, !configured("outlook") && styles.muted]}
              onPress={() => void connect("outlook")}
            >
              <Text style={styles.action}>
                {i18n._({ id: "Add Outlook account", message: "Add Outlook account" })}
              </Text>
            </Pressable>
            {setup.kind === "ready" &&
              (!setup.value.googleConfigured || !setup.value.microsoftConfigured) && (
                <Text style={styles.empty}>
                  {i18n._({
                    id: "Register mobile OAuth clients in app config to add accounts.",
                    message: "Register mobile OAuth clients in app config to add accounts.",
                  })}
                </Text>
              )}
          </View>
        }
      />
      {(error || accounts.kind === "failed" || setup.kind === "failed") && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not load mail. Try again.",
            message: "Could not load mail. Try again.",
          })}
        </Text>
      )}
    </View>
  );
}
