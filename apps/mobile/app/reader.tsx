import { Mailbox, type Message } from "@openmail/core/portable";
import { Effect } from "effect";
import { useLingui } from "@lingui/react";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { useMailbox, useMailboxQuery } from "../src/mailbox";
import { handleReaderNavigation, readerDocument } from "../src/reader-html";
import { Button } from "../src/controls";
import { ThreadMenu } from "../src/thread-actions";
import { styles } from "../src/styles";

function ReaderMessage({ message, remoteImages }: { message: Message; remoteImages: boolean }) {
  const { i18n } = useLingui();
  const [html, setHtml] = useState(false);
  return (
    <View style={styles.message}>
      <Text style={styles.subject}>
        {message.subject || i18n._({ id: "(No subject)", message: "(No subject)" })}
      </Text>
      <Text style={styles.detail}>{message.from.name || message.from.address}</Text>
      <Text style={styles.detail}>{i18n.date(new Date(message.date))}</Text>
      {message.bodyHtml && (
        <Pressable accessibilityRole="button" onPress={() => setHtml((value) => !value)}>
          <Text style={styles.action}>
            {html
              ? i18n._({
                  id: "Show message text",
                  message: "Show message text",
                  comment: "Button label for the plain message body text.",
                })
              : i18n._({ id: "Show HTML", message: "Show HTML" })}
          </Text>
        </Pressable>
      )}
      {html ? (
        <WebView
          style={styles.webview}
          incognito={true}
          source={{ html: readerDocument(message.bodyHtml, remoteImages), baseUrl: "about:blank" }}
          // Let the callback handle every scheme; unmatched originWhitelist entries
          // would otherwise be handed to an external app by WebView automatically.
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={({ url, isTopFrame }) =>
            isTopFrame ? handleReaderNavigation(url, (target) => Linking.openURL(target)) : false
          }
          javaScriptEnabled={false}
          javaScriptCanOpenWindowsAutomatically={false}
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          setSupportMultipleWindows={false}
        />
      ) : (
        <Text selectable style={styles.body}>
          {message.bodyText ||
            i18n._({
              id: "No message text",
              message: "No message text",
              comment: "Empty plain message body text.",
            })}
        </Text>
      )}
    </View>
  );
}
export default function Reader() {
  const { messageId, accountId } = useLocalSearchParams<{ messageId: string; accountId: string }>();
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const [menu, setMenu] = useState(false);
  const prefs = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.prefs)),
      [runtime],
    ),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const messages = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.readerThread(messageId))),
      [runtime, messageId],
    ),
  );
  const refresh = async () => {
    setRefreshing(true);
    setFailed(false);
    try {
      const results = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.sync(accountId)),
      );
      setFailed(results.some((item) => Boolean(item.error)));
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <ScrollView
      style={styles.screen}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <View style={styles.toolbar}>
        <Button
          label={i18n._({ id: "Actions", message: "Actions" })}
          onPress={() => setMenu(true)}
        />
        {[
          { mode: "reply", label: i18n._({ id: "Reply", message: "Reply" }) },
          { mode: "replyAll", label: i18n._({ id: "Reply all", message: "Reply all" }) },
          { mode: "forward", label: i18n._({ id: "Forward", message: "Forward" }) },
        ].map((item) => (
          <Button
            key={item.mode}
            label={item.label}
            onPress={() =>
              router.push({
                pathname: "/compose",
                params: { accountId, messageId, mode: item.mode },
              })
            }
          />
        ))}
      </View>
      {menu && <ThreadMenu ids={[messageId]} accountId={accountId} close={() => setMenu(false)} />}
      {messages.kind === "loading" && <ActivityIndicator />}
      {(failed || messages.kind === "failed") && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not load mail. Try again.",
            message: "Could not load mail. Try again.",
          })}
        </Text>
      )}
      {messages.kind === "ready" &&
        messages.value.map((message) => (
          <ReaderMessage
            key={message.id}
            message={message}
            remoteImages={prefs.kind === "ready" && prefs.value.remoteImages === true}
          />
        ))}
    </ScrollView>
  );
}
