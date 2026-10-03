import type { I18n } from "@lingui/core";
import { router } from "expo-router";
import { useLingui } from "@lingui/react";
import { Mailbox } from "@openmail/core/portable";
import { Effect } from "effect";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Button, Sheet } from "./controls";
import { useMailbox, useMailboxQuery } from "./mailbox";
import { styles } from "./styles";

function operationLabels(i18n: I18n): Readonly<Record<string, string>> {
  return {
    read: i18n._({ id: "Read status", message: "Read status" }),
    star: i18n._({ id: "Star", message: "Star" }),
    important: i18n._({ id: "Important", message: "Important" }),
    archive: i18n._({ id: "Archive", message: "Archive" }),
    inbox: i18n._({ id: "Move to Inbox", message: "Move to Inbox" }),
    trash: i18n._({ id: "Move to Trash", message: "Move to Trash" }),
    spam: i18n._({ id: "Report spam", message: "Report spam" }),
    move: i18n._({ id: "Move to folder", message: "Move to folder" }),
    copy: i18n._({ id: "Copy", message: "Copy" }),
    label: i18n._({ id: "Label", message: "Label" }),
    categories: i18n._({ id: "Categories", message: "Categories" }),
    saveDraft: i18n._({ id: "Save draft", message: "Save draft" }),
    deleteDraft: i18n._({ id: "Delete draft", message: "Delete draft" }),
    delete: i18n._({ id: "Delete permanently", message: "Delete permanently" }),
    reconcile: i18n._({ id: "Restore message state", message: "Restore message state" }),
    send: i18n._({ id: "Send", message: "Send" }),
    sendPartial: i18n._({ id: "Partial delivery", message: "Partial delivery" }),
    sentCopyMissing: i18n._({ id: "Save sent copy", message: "Save sent copy" }),
  };
}

export function FailedOpNotice() {
  const { i18n } = useLingui();
  const runtime = useMailbox();
  const result = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const mailbox = yield* Mailbox;
            return { failures: yield* mailbox.listFailedOps, accounts: yield* mailbox.accounts };
          }),
        ),
      [runtime],
    ),
    { keepPrevious: true },
  );
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [resendError, setResendError] = useState(false);
  if (result.kind !== "ready" || !result.value.failures.length) return null;
  const { failures, accounts } = result.value;
  const labels = operationLabels(i18n);
  const count = failures.filter(
    (entry) => entry.kind !== "sendPartial" && entry.kind !== "sentCopyMissing",
  ).length;
  const partialCount = failures.filter((entry) => entry.kind === "sendPartial").length;
  const sentCopyCount = failures.filter((entry) => entry.kind === "sentCopyMissing").length;
  const title = [
    count > 0
      ? i18n._({
          id: "{count, plural, one {# change could not be saved} other {# changes could not be saved}}",
          message:
            "{count, plural, one {# change could not be saved} other {# changes could not be saved}}",
          values: { count },
        })
      : null,
    partialCount > 0
      ? i18n._({
          id: "{count, plural, one {# message had rejected recipients} other {# messages had rejected recipients}}",
          message:
            "{count, plural, one {# message had rejected recipients} other {# messages had rejected recipients}}",
          values: { count: partialCount },
        })
      : null,
    sentCopyCount > 0
      ? i18n._({
          id: "{count, plural, one {# sent message is missing from Sent} other {# sent messages are missing from Sent}}",
          message:
            "{count, plural, one {# sent message is missing from Sent} other {# sent messages are missing from Sent}}",
          values: { count: sentCopyCount },
        })
      : null,
  ]
    .filter((entry) => entry !== null)
    .join("\n");
  const resend = async (noticeId: number) => {
    setBusy(true);
    setResendError(false);
    try {
      const draft = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.prepareRejectedResend(noticeId)),
      );
      setExpanded(false);
      router.push({
        pathname: "/compose",
        params: { draftId: draft.id, accountId: draft.accountId },
      });
    } catch {
      setResendError(true);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    setError(false);
    try {
      await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) =>
          mailbox.acknowledgeFailedOps(failures.map((entry) => entry.id)),
        ),
      );
      setExpanded(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <View style={styles.toast}>
        <Text accessibilityRole="alert" style={[styles.detail, { flex: 1 }]}>
          {title}
        </Text>
        <Button
          label={i18n._({ id: "Details", message: "Details" })}
          onPress={() => setExpanded(true)}
        />
        <Button
          label={i18n._({ id: "Dismiss", message: "Dismiss" })}
          disabled={busy}
          onPress={() => void dismiss()}
        />
      </View>
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not dismiss this notice. Try again.",
            message: "Could not dismiss this notice. Try again.",
          })}
        </Text>
      )}
      {resendError && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not prepare the resend draft. Try again.",
            message: "Could not prepare the resend draft. Try again.",
          })}
        </Text>
      )}
      {expanded && (
        <Sheet
          title={title}
          close={() => setExpanded(false)}
          cancel={i18n._({ id: "Close", message: "Close" })}
        >
          {failures.map((entry) => (
            <View key={entry.id} style={styles.row}>
              <Text style={styles.subject}>
                {accounts.find((account) => account.id === entry.accountId)?.email ??
                  entry.accountId}
              </Text>
              <Text style={styles.detail}>
                {i18n.date(entry.at, { dateStyle: "short", timeStyle: "short" })}
              </Text>
              <Text style={styles.detail}>
                {labels[entry.kind] ?? i18n._({ id: "Change", message: "Change" })}
              </Text>
              <Text style={styles.subject}>
                {entry.subject || i18n._({ id: "(No subject)", message: "(No subject)" })}
              </Text>
              {entry.sender && <Text style={styles.detail}>{entry.sender}</Text>}
              {entry.kind === "sendPartial" && (
                <Text style={styles.detail}>
                  {i18n._({
                    id: "Some recipients did not receive this message.",
                    message: "Some recipients did not receive this message.",
                  })}
                </Text>
              )}
              {entry.kind === "sendPartial" && (
                <Text style={styles.detail}>
                  {i18n._({
                    id: "Your draft was kept. Check Sent before sending again.",
                    message: "Your draft was kept. Check Sent before sending again.",
                  })}
                </Text>
              )}
              {entry.kind === "sentCopyMissing" && (
                <Text style={styles.detail}>
                  {i18n._({
                    id: "The message was sent, but its copy is missing from Sent.",
                    message: "The message was sent, but its copy is missing from Sent.",
                  })}
                </Text>
              )}
              <Text style={styles.detail}>{entry.reason}</Text>
              {entry.kind === "sendPartial" && entry.providerId && (
                <Button
                  disabled={busy}
                  label={i18n._({
                    id: "Resend to rejected recipients",
                    message: "Resend to rejected recipients",
                  })}
                  onPress={() => void resend(entry.id)}
                />
              )}
            </View>
          ))}
        </Sheet>
      )}
    </View>
  );
}
