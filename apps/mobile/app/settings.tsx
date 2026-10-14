import { useCallback, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { useLingui } from "@lingui/react";
import { router } from "expo-router";
import {
  Mailbox,
  SWIPE_ACTIONS,
  UNDO_SEND_SECONDS,
  LANGUAGES,
  REMOTE_IMAGE_MODES,
  type Prefs,
  type PrefsPatch,
  providerCapabilities,
} from "@openmail/core/portable";
import { Effect } from "effect";
import { useMailbox, useMailboxQuery } from "../src/mailbox";
import { Button } from "../src/controls";
import { actionLabels } from "../src/labels";
import { languageNames } from "../src/lifecycle";
import { BackgroundSettings } from "../src/background-settings";
import { AiSettings, MobileSignatures } from "../src/ai-settings";
import { styles } from "../src/styles";
export default function Settings() {
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const names = actionLabels(i18n);
  const [failed, setFailed] = useState(false);
  const prefs = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.app.prefs)),
      [runtime],
    ),
  );
  const accounts = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts.accounts)),
      [runtime],
    ),
  );
  const queued = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.outbox.queuedSends)),
      [runtime],
    ),
  );
  const update = async (patch: PrefsPatch) => {
    try {
      await runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.app.setPrefs(patch)));
    } catch {
      setFailed(true);
    }
  };
  return (
    <ScrollView style={styles.screen}>
      <Button
        label={i18n._({ id: "Accounts", message: "Accounts" })}
        onPress={() => router.navigate("/")}
      />
      {accounts.kind === "ready" &&
        accounts.value.map((account) => (
          <View key={account.id} style={styles.row}>
            <Text style={styles.subject}>{account.email}</Text>
            <MobileSignatures account={account} />
            <Button
              label={i18n._({ id: "Sign in again", message: "Sign in again" })}
              onPress={() => {
                if (providerCapabilities(account.provider).signIn === "password") {
                  router.push({ pathname: "/imap-setup", params: { accountId: account.id } });
                  return;
                }
                void runtime
                  .runPromise(
                    Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts.reauth(account.id)),
                  )
                  .catch(() => setFailed(true));
              }}
            />
            <Button
              label={
                account.enabled === false
                  ? i18n._({ id: "Enable account", message: "Enable account" })
                  : i18n._({ id: "Disable account", message: "Disable account" })
              }
              onPress={() => {
                void runtime
                  .runPromise(
                    Effect.flatMap(Mailbox, (mailbox) =>
                      mailbox.accounts.setAccountSettings(account.id, {
                        enabled: account.enabled === false,
                        description: account.description ?? "",
                        color: account.color ?? null,
                      }),
                    ),
                  )
                  .catch(() => setFailed(true));
              }}
            />
            <Button
              label={i18n._({ id: "Remove account", message: "Remove account" })}
              onPress={() =>
                Alert.alert(
                  i18n._({ id: "Remove account", message: "Remove account" }),
                  account.email,
                  [
                    { text: names.cancel, style: "cancel" },
                    {
                      text: i18n._({ id: "Remove", message: "Remove" }),
                      style: "destructive",
                      onPress: () => {
                        void runtime
                          .runPromise(
                            Effect.flatMap(Mailbox, (mailbox) =>
                              mailbox.organize.perform(
                                { kind: "removeAccount", accountId: account.id },
                                { kind: "user", surface: "app" },
                              ),
                            ),
                          )
                          .catch(() => setFailed(true));
                      },
                    },
                  ],
                )
              }
            />
          </View>
        ))}
      {accounts.kind === "ready" && <BackgroundSettings accounts={accounts.value} />}
      {accounts.kind === "ready" && <AiSettings accounts={accounts.value} />}
      <Button
        label={i18n._({ id: "Review proposals", message: "Review proposals" })}
        onPress={() => router.push("/ai-proposals")}
      />
      {prefs.kind === "ready" && (
        <>
          <Text style={styles.title}>
            {i18n._({ id: "Swipe actions", message: "Swipe actions" })}
          </Text>
          {(
            [
              {
                key: "leftShort",
                label: i18n._({ id: "Short swipe left", message: "Short swipe left" }),
              },
              {
                key: "leftLong",
                label: i18n._({ id: "Long swipe left", message: "Long swipe left" }),
              },
              {
                key: "rightShort",
                label: i18n._({ id: "Short swipe right", message: "Short swipe right" }),
              },
              {
                key: "rightLong",
                label: i18n._({ id: "Long swipe right", message: "Long swipe right" }),
              },
            ] satisfies { key: keyof Prefs["swipeActions"]; label: string }[]
          ).map((item) => (
            <View key={item.key}>
              <Text style={styles.subject}>{item.label}</Text>
              <View style={styles.toolbar}>
                {SWIPE_ACTIONS.map((action) => (
                  <Button
                    key={action}
                    disabled={prefs.value.swipeActions[item.key] === action}
                    label={names[action]}
                    onPress={() =>
                      void update({
                        swipeActions: { ...prefs.value.swipeActions, [item.key]: action },
                      })
                    }
                  />
                ))}
              </View>
            </View>
          ))}
          <Text style={styles.title}>{i18n._({ id: "Undo send", message: "Undo send" })}</Text>
          <View style={styles.toolbar}>
            {UNDO_SEND_SECONDS.map((seconds) => (
              <Button
                key={seconds}
                disabled={prefs.value.undoSendSeconds === seconds}
                label={i18n._({
                  id: "{seconds} seconds",
                  message: "{seconds} seconds",
                  values: { seconds },
                })}
                onPress={() => void update({ undoSendSeconds: seconds })}
              />
            ))}
          </View>
          <Text style={styles.title}>
            {i18n._({ id: "Remote images", message: "Remote images" })}
          </Text>
          <View style={styles.toolbar}>
            {REMOTE_IMAGE_MODES.map((mode) => (
              <Button
                key={mode}
                // Until a mode is stored, every button records a choice.
                disabled={prefs.value.remoteImagesChosen && prefs.value.remoteImages === mode}
                label={
                  mode === "ask"
                    ? i18n._({ id: "Ask each time", message: "Ask each time" })
                    : mode === "known"
                      ? i18n._({ id: "From people I know", message: "From people I know" })
                      : i18n._({
                          id: "Always",
                          message: "Always",
                          comment: "Remote images setting: always load.",
                        })
                }
                onPress={() => void update({ remoteImages: mode })}
              />
            ))}
          </View>
          <Text style={styles.detail}>
            {i18n._({
              id: "Loading remote images lets the sender see when you open a message and your IP address.",
              message:
                "Loading remote images lets the sender see when you open a message and your IP address.",
            })}
          </Text>
          <Text style={styles.title}>{i18n._({ id: "Language", message: "Language" })}</Text>
          {LANGUAGES.map((language) => (
            <Button
              key={language}
              disabled={prefs.value.language === language}
              label={
                languageNames[language] ||
                i18n._({ id: "System language", message: "System language" })
              }
              onPress={() => void update({ language })}
            />
          ))}
        </>
      )}
      {queued.kind === "ready" && queued.value.length > 0 && (
        <Text style={styles.title}>{i18n._({ id: "Outbox", message: "Outbox" })}</Text>
      )}
      {queued.kind === "ready" &&
        queued.value.map((item) => (
          <View key={item.id} style={styles.row}>
            <Text style={styles.subject}>{item.message.subject}</Text>
            <Text style={styles.detail}>
              {item.status === "waiting"
                ? i18n._({ id: "Queued to send", message: "Queued to send" })
                : item.status === "retryable"
                  ? i18n._({
                      id: "Send failed. Review the draft and try again.",
                      message: "Send failed. Review the draft and try again.",
                    })
                  : item.status === "rejected"
                    ? i18n._({
                        id: "Rejected before sending. Edit the draft and try again.",
                        message: "Rejected before sending. Edit the draft and try again.",
                      })
                    : i18n._({
                        id: "Delivery uncertain. Check Sent before trying again.",
                        message: "Delivery uncertain. Check Sent before trying again.",
                      })}
            </Text>
            {item.status === "retryable" && (
              <Button
                label={i18n._({ id: "Retry send", message: "Retry send" })}
                onPress={() => {
                  void runtime
                    .runPromise(
                      Effect.flatMap(Mailbox, (mailbox) =>
                        mailbox.outbox.cancelQueuedSend(item.id),
                      ),
                    )
                    .then(() => {
                      return router.push({
                        pathname: "/compose",
                        params: { accountId: item.accountId, draftId: item.id },
                      });
                    })
                    .catch(() => setFailed(true));
                }}
              />
            )}
            <Button
              label={i18n._({ id: "Cancel queued send", message: "Cancel queued send" })}
              onPress={() => {
                void runtime
                  .runPromise(
                    Effect.flatMap(Mailbox, (mailbox) => mailbox.outbox.cancelQueuedSend(item.id)),
                  )
                  .catch(() => setFailed(true));
              }}
            />
          </View>
        ))}
      {(failed || prefs.kind === "failed") && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not save settings. Try again.",
            message: "Could not save settings. Try again.",
          })}
        </Text>
      )}
    </ScrollView>
  );
}
