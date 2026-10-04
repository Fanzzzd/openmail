import { recipientLabel, Mailbox, shouldLoadRemote, type Message } from "@openmail/core/portable";
import { Effect } from "effect";
import { useLingui } from "@lingui/react";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { useMailbox, useMailboxQuery } from "../src/mailbox";
import { ThreadAi } from "../src/ai-controls";
import { handleReaderNavigation, readerDocument, type ReaderLink } from "../src/reader-html";
import { useMessageInlineImages } from "../src/inline-images";
import { shareReceivedAttachment } from "../src/received-attachments";
import { Button, Sheet } from "../src/controls";
import { ThreadMenu } from "../src/thread-actions";
import { styles } from "../src/styles";

function ReaderMessage({ message, remoteImages }: { message: Message; remoteImages: boolean }) {
  const { i18n } = useLingui();
  const [pendingLink, setPendingLink] = useState<ReaderLink | null>(null);
  const [html, setHtml] = useState(false);
  const [loadedRemote, setLoadedRemote] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentFailed, setAttachmentFailed] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const runtime = useMailbox();
  const fetchInline = useCallback(
    (id: string) =>
      runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.inlineImages(id))),
    [runtime],
  );
  const inline = useMessageInlineImages(message.id, message.bodyHtml, html, fetchInline);
  const source = useMemo(
    () => ({
      html: readerDocument(message.bodyHtml, remoteImages || loadedRemote, inline.value),
      baseUrl: "about:blank",
    }),
    [message.bodyHtml, remoteImages, loadedRemote, inline.value],
  );
  const openLink = async (target: string) => {
    setLinkFailed(false);
    try {
      await Linking.openURL(target);
    } catch {
      setLinkFailed(true);
    }
  };
  const openAttachment = async (index: number) => {
    if (attachmentBusy) return;
    setAttachmentBusy(true);
    setAttachmentFailed(false);
    try {
      const content = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.attachment(message.id, index)),
      );
      await shareReceivedAttachment(content);
    } catch {
      setAttachmentFailed(true);
    } finally {
      setAttachmentBusy(false);
    }
  };
  return (
    <View style={styles.message}>
      <Text style={styles.subject}>
        {message.subject || i18n._({ id: "(No subject)", message: "(No subject)" })}
      </Text>
      <Text style={styles.detail}>{recipientLabel(message.from, false)}</Text>
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
      {html && !remoteImages && !loadedRemote && (
        <Button
          label={i18n._({ id: "Load remote images", message: "Load remote images" })}
          onPress={() => setLoadedRemote(true)}
        />
      )}
      {html ? (
        <WebView
          style={styles.webview}
          incognito={true}
          source={source}
          // Let the callback handle every scheme; unmatched originWhitelist entries
          // would otherwise be handed to an external app by WebView automatically.
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={(request) =>
            handleReaderNavigation(
              request,
              Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other",
              openLink,
              setPendingLink,
            )
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
      {pendingLink && (
        <Sheet
          title={i18n._({ id: "Open external link?", message: "Open external link?" })}
          close={() => setPendingLink(null)}
          cancel={i18n._({ id: "Cancel", message: "Cancel" })}
        >
          <Text selectable style={styles.body}>
            {pendingLink.destination}
          </Text>
          <Text selectable style={styles.detail}>
            {pendingLink.url}
          </Text>
          <Button
            label={i18n._({ id: "Open link", message: "Open link" })}
            onPress={() => {
              const target = pendingLink.url;
              setPendingLink(null);
              void openLink(target);
            }}
          />
        </Sheet>
      )}
      {message.attachments.map((attachment, index) => (
        <Button
          key={`${index}:${attachment.filename}`}
          disabled={attachmentBusy}
          label={i18n._({
            id: "Open or share {filename}",
            message: "Open or share {filename}",
            values: { filename: attachment.filename },
          })}
          onPress={() => void openAttachment(index)}
        />
      ))}
      {linkFailed && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not open the link. Try again.",
            message: "Could not open the link. Try again.",
          })}
        </Text>
      )}
      {(attachmentFailed || (html && inline.kind === "failed")) && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not load attachments. Try again.",
            message: "Could not load attachments. Try again.",
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
  const imagePolicy = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) =>
            Effect.all({ prefs: mailbox.prefs, imageSenders: mailbox.imageSenders }),
          ),
        ),
      [runtime],
    ),
    { keepPrevious: true },
  );
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const messages = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) =>
            Effect.flatMap(mailbox.readerThread(messageId), (thread) =>
              Effect.map(
                mailbox.knownSenders(
                  accountId,
                  thread.map((m) => m.from.address),
                ),
                (known) => ({ thread, known }),
              ),
            ),
          ),
        ),
      [runtime, messageId, accountId],
    ),
    { keepPrevious: true },
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
      {messages.kind === "ready" && (
        <ThreadAi key={messageId} accountId={accountId} messageId={messageId} />
      )}
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
        messages.value.thread.map((message) => (
          <ReaderMessage
            key={message.id}
            message={message}
            remoteImages={
              imagePolicy.kind === "ready" &&
              shouldLoadRemote(message, {
                remoteImages: imagePolicy.value.prefs.remoteImages,
                imageSenders: imagePolicy.value.imageSenders,
                knownSender: messages.value.known.includes(
                  message.from.address.trim().toLowerCase(),
                ),
              })
            }
          />
        ))}
    </ScrollView>
  );
}
