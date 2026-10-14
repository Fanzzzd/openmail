import { Mailbox } from "@openmail/core/portable";
import { Effect } from "effect";
import { useLingui } from "@lingui/react";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useMailbox, useMailboxQuery } from "../src/mailbox";
import { Button } from "../src/controls";
import { styles } from "../src/styles";
import { mailboxTree } from "../src/mailbox-tree";
import { mailboxName } from "../src/mailbox-name";

export default function Mailboxes() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const labels = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) => mailbox.reading.labels([accountId])),
        ),
      [runtime, accountId],
    ),
  );
  const counts = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) => mailbox.reading.unreadByLabel([accountId])),
        ),
      [runtime, accountId],
    ),
  );
  const refresh = async () => {
    setRefreshing(true);
    setFailed(false);
    try {
      const result = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.sync.sync(accountId)),
      );
      setFailed(result.some((item) => Boolean(item.error)));
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <View style={styles.screen}>
      <Button
        label={i18n._({ id: "Compose", message: "Compose" })}
        onPress={() => router.push({ pathname: "/compose", params: { accountId, mode: "new" } })}
      />
      <Button
        label={i18n._({ id: "Drafts", message: "Drafts" })}
        onPress={() =>
          router.push({ pathname: "/threads", params: { accountId, label: "drafts" } })
        }
      />
      <FlatList
        ListHeaderComponent={
          <Button
            label={i18n._({ id: "Snoozed", message: "Snoozed" })}
            onPress={() =>
              router.push({ pathname: "/threads", params: { accountId, label: "snoozed" } })
            }
          />
        }
        data={
          labels.kind === "ready"
            ? mailboxTree(labels.value.filter((item) => item.id !== "DRAFT"))
            : []
        }
        keyExtractor={(item) => item.label.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            style={[styles.row, { paddingLeft: 20 + item.depth * 20 }]}
            onPress={() =>
              router.push({ pathname: "/threads", params: { accountId, label: item.label.id } })
            }
          >
            <Text style={styles.subject}>
              {mailboxName(i18n, { ...item.label, name: item.name })}
            </Text>
            {counts.kind === "ready" && (counts.value[item.label.id] ?? 0) > 0 && (
              <Text style={styles.detail}>
                {i18n._({
                  id: "{count} unread",
                  message: "{count} unread",
                  values: { count: counts.value[item.label.id] },
                })}
              </Text>
            )}
          </Pressable>
        )}
        ListEmptyComponent={
          labels.kind === "loading" ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.empty}>
              {i18n._({
                id: "No mailboxes yet. Pull to refresh.",
                message: "No mailboxes yet. Pull to refresh.",
              })}
            </Text>
          )
        }
      />
      {(failed || labels.kind === "failed" || counts.kind === "failed") && (
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
