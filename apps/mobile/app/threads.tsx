import { Mailbox, DEFAULT_PREFS, type ThreadSummary } from "@openmail/core/portable";
import { Effect } from "effect";
import { useLingui } from "@lingui/react";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMailbox, useMailboxRevision, useMailboxQuery } from "../src/mailbox";
import { ThreadRow } from "../src/thread-row";
import { ThreadMenu, useThreadActions } from "../src/thread-actions";
import { Button } from "../src/controls";
import { toggleSelection, swipeOperation, searchQuery } from "../src/workflows";
import { PAGE_SIZE, appendPage, pageQuery } from "../src/paging";
import { styles } from "../src/styles";

export default function Threads() {
  const { accountId, label } = useLocalSearchParams<{ accountId: string; label: string }>();
  const runtime = useMailbox();
  const revision = useMailboxRevision();
  const { i18n } = useLingui();
  const [selected, setSelected] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [menu, setMenu] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [searchSource, setSearchSource] = useState<"local" | "server">("local");
  const [serverNotice, setServerNotice] = useState(false);
  const [serverProblems, setServerProblems] = useState(false);
  const actions = useThreadActions();
  const prefs = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.prefs)),
      [runtime],
    ),
  );
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
      await Promise.resolve();
      const state = current.current;
      if (!reset && (search || state.loading || !state.more)) return;
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
          Effect.flatMap(Mailbox, (mailbox) =>
            search
              ? searchSource === "server"
                ? Effect.succeed([])
                : mailbox.threads(searchQuery(accountId, search))
              : mailbox.threads(pageQuery(accountId, label, last)),
          ),
        );
        if (search && page.length === 0) {
          const result = await runtime.runPromise(
            Effect.flatMap(Mailbox, (mailbox) =>
              mailbox.searchServer(searchQuery(accountId, search)),
            ),
          );
          if (state.epoch !== epoch) return;
          setServerNotice(true);
          setServerProblems(
            Boolean(result.errors.length || result.ignored?.length || result.truncated),
          );
          page.push(...result.threads);
        }
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
    [runtime, accountId, label, revision, search, searchSource],
  );
  useEffect(() => {
    void Promise.resolve().then(() => loadPage(true));
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
      <TextInput
        accessibilityLabel={i18n._({ id: "Search mail", message: "Search mail" })}
        placeholder={i18n._({ id: "Search mail", message: "Search mail" })}
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => {
          setServerNotice(false);
          setServerProblems(false);
          setSearchSource("local");
          setSearch(query.trim());
        }}
        returnKeyType="search"
      />
      <View style={styles.toolbar}>
        <Button
          label={i18n._({ id: "Compose", message: "Compose" })}
          onPress={() => router.push({ pathname: "/compose", params: { accountId, mode: "new" } })}
        />
        <Button
          label={
            selecting
              ? i18n._({ id: "Cancel", message: "Cancel" })
              : i18n._({ id: "Select", message: "Select" })
          }
          onPress={() => {
            setSelecting(!selecting);
            setSelected([]);
          }}
        />
        {selecting && (
          <Button
            disabled={!selected.length}
            label={i18n._({ id: "Actions", message: "Actions" })}
            onPress={() => setMenu(selected)}
          />
        )}
      </View>
      {search && (
        <Button
          label={i18n._({ id: "Search server", message: "Search server" })}
          onPress={() => setSearchSource("server")}
        />
      )}
      {serverNotice && (
        <Text style={styles.detail}>
          {i18n._({
            id: "Showing server search results.",
            message: "Showing server search results.",
          })}
        </Text>
      )}
      {serverProblems && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Server search may be incomplete or omit unsupported operators.",
            message: "Server search may be incomplete or omit unsupported operators.",
          })}
        </Text>
      )}
      {menu && (
        <ThreadMenu ids={menu} accountId={accountId} label={label} close={() => setMenu(null)} />
      )}
      {actions.failed && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not apply action. Try again.",
            message: "Could not apply action. Try again.",
          })}
        </Text>
      )}
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        onEndReached={() => void loadPage(false)}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <ThreadRow
            row={item}
            prefs={prefs.kind === "ready" ? prefs.value.swipeActions : DEFAULT_PREFS.swipeActions}
            selecting={selecting}
            selected={selected.includes(item.id)}
            select={() => {
              setSelecting(true);
              setSelected((ids) => toggleSelection(ids, item.id));
            }}
            menu={() => setMenu([item.id])}
            open={() =>
              router.push({
                pathname: item.labels.includes("DRAFT") ? "/compose" : "/reader",
                params: { messageId: item.id, draftId: item.id, accountId },
              })
            }
            accessibleAction={(op) => void actions.apply([item.id], op)}
            action={(action) => {
              if (action === "none" || actions.busy) return;
              if (action === "snooze") setMenu([item.id]);
              else void actions.apply([item.id], swipeOperation(action, item));
            }}
          />
        )}
        ListEmptyComponent={
          !loading ? (
            <Text style={styles.empty}>
              {i18n._({ id: "No messages", message: "No messages" })}
            </Text>
          ) : undefined
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
          ) : undefined
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
