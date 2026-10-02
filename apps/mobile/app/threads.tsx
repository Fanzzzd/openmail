import { Mailbox, type ThreadSummary } from "@openmail/core/portable";
import { Effect } from "effect";
import { useLingui } from "@lingui/react";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useMailbox, useMailboxRevision } from "../src/mailbox";
import { PAGE_SIZE, appendPage, pageQuery } from "../src/paging";
import { styles } from "../src/styles";

export default function Threads() {
  const { accountId, label } = useLocalSearchParams<{ accountId: string; label: string }>();
  const runtime = useMailbox();
  const revision = useMailboxRevision();
  const { i18n } = useLingui();
  const [rows, setRows] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = useRef<{
    revision: number;
    epoch: number;
    rows: ThreadSummary[];
    more: boolean;
    loading: boolean;
  }>({ revision: 0, epoch: 0, rows: [], more: true, loading: false });
  const loadPage = useCallback(
    async (reset: boolean) => {
      const state = current.current;
      if (!reset && (state.loading || !state.more)) return;
      if (reset) {
        state.epoch++;
        state.revision = revision;
        state.rows = [];
        state.more = true;
      }
      const epoch = state.epoch;
      state.loading = true;
      setLoading(true);
      setFailed(false);
      try {
        const last = state.rows.at(-1);
        const page = await runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) => mailbox.threads(pageQuery(accountId, label, last))),
        );
        if (state.epoch !== epoch || state.revision !== revision) return;
        state.rows = appendPage(state.rows, page);
        state.more = page.length === PAGE_SIZE;
        setRows(state.rows);
      } catch {
        if (state.epoch === epoch) setFailed(true);
      } finally {
        if (state.epoch === epoch) {
          state.loading = false;
          setLoading(false);
        }
      }
    },
    [runtime, accountId, label, revision],
  );
  useEffect(() => {
    void loadPage(true);
    const state = current.current;
    return () => {
      state.epoch++;
    };
  }, [loadPage]);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.sync(accountId)),
      );
      await loadPage(true);
      setFailed(result.some((item) => Boolean(item.error)));
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <View style={styles.screen}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        onEndReached={() => void loadPage(false)}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            style={styles.row}
            onPress={() =>
              router.push({ pathname: "/reader", params: { messageId: item.id, accountId } })
            }
          >
            <Text style={styles.subject} numberOfLines={1}>
              {item.subject || i18n._({ id: "(No subject)", message: "(No subject)" })}
            </Text>
            <Text style={styles.detail}>{item.from.name || item.from.address}</Text>
            <Text style={styles.detail} numberOfLines={2}>
              {item.snippet}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          !loading ? (
            <Text style={styles.empty}>
              {i18n._({ id: "No messages", message: "No messages" })}
            </Text>
          ) : null
        }
        ListFooterComponent={
          loading ? (
            <ActivityIndicator />
          ) : failed ? (
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => void loadPage(rows.length === 0)}
            >
              <Text style={styles.action}>{i18n._({ id: "Try again", message: "Try again" })}</Text>
            </Pressable>
          ) : null
        }
      />
      {failed && (
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
