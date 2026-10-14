import {
  recipientLabel,
  Mailbox,
  mobileAttachmentProblem,
  restoreMobileRichText,
  type Provider,
  type Address,
  type OutgoingMessage,
  signatureDefault,
} from "@openmail/core/portable";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, View } from "react-native";
import { useLingui } from "@lingui/react";
import { router, useLocalSearchParams } from "expo-router";
import { Effect } from "effect";
import { randomUUID } from "expo-crypto";
import { useMailbox } from "../src/mailbox";
import { Button } from "../src/controls";
import {
  composeMessage,
  draftSession,
  draftRecipients,
  parseRecipients,
  type Format,
} from "../src/workflows";
import {
  markSelection,
  editMarks,
  richTextBody,
  richTextSegments,
  type Mark,
} from "../src/rich-text";
import { pickAttachments } from "../src/attachments";
import { useUndo } from "../src/undo";
import { styles } from "../src/styles";
import { ComposeAi } from "../src/ai-controls";
import { aiUndoBody, type AiEditUndo } from "../src/ai-edit";
import {
  signedMobileMessage,
  reviewAgentRecipients,
  mobileRecipientWarnings,
} from "../src/ai-workflows";

const recipientsText = (addresses: readonly Address[]) =>
  addresses.map((address) => recipientLabel(address, true)).join(", ");
export default function Compose() {
  const params = useLocalSearchParams<{
    accountId: string;
    messageId?: string;
    draftId?: string;
    mode?: string;
  }>();
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const notice = useUndo("send");
  const autosave = useRef(true);
  const lastEdit = useRef<OutgoingMessage | null>(null);
  const [id] = useState(() => params.draftId ?? `draft:${randomUUID()}`);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [draft, setDraft] = useState<{
    id: string;
    accountId: string;
    message: OutgoingMessage;
  } | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [field, setField] = useState<"to" | "cc" | "bcc">("to");
  const [contacts, setContacts] = useState<Address[]>([]);
  const [aiUndo, setAiUndo] = useState<AiEditUndo | null>(null);
  const [signature, setSignature] = useState<{ text: string | undefined } | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [list, setList] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const writer = useMemo(
    () =>
      draftSession(
        (message) =>
          runtime.runPromise(
            Effect.flatMap(Mailbox, (mailbox) =>
              mailbox.compose.saveDraft({
                id: draft?.id ?? id,
                accountId: draft?.accountId ?? params.accountId,
                message,
              }),
            ),
          ),
        () =>
          runtime.runPromise(
            Effect.flatMap(Mailbox, (mailbox) => mailbox.compose.discardDraft(draft?.id ?? id)),
          ),
      ),
    [runtime, id, params.accountId, draft?.id, draft?.accountId],
  );
  useEffect(() => {
    let active = true;
    void runtime
      .runPromise(
        Effect.flatMap(Mailbox, (mailbox) =>
          Effect.gen(function* () {
            if (params.draftId) return yield* mailbox.compose.openDraft(params.draftId);
            const original = params.messageId
              ? (yield* mailbox.reading.readerThread(params.messageId)).find(
                  (message) => message.id === params.messageId,
                )
              : undefined;
            const accounts = yield* mailbox.accounts.accounts;
            const mode =
              params.mode === "reply" || params.mode === "replyAll" || params.mode === "forward"
                ? params.mode
                : "new";
            const message = yield* signedMobileMessage(
              mailbox,
              params.accountId,
              composeMessage(
                mode,
                original,
                accounts.map((account) => account.email),
              ),
            );
            const attachments =
              mode === "forward" && original
                ? yield* mailbox.compose.composeAttachments(original.id)
                : [];
            return { id, accountId: params.accountId, message: { ...message, attachments } };
          }),
        ),
      )
      .then((value) => {
        if (active) {
          const editor = restoreMobileRichText(value.message);
          setMarks(editor.marks);
          setList(editor.list);
          setDraft({ ...value, message: { ...value.message, text: editor.text } });
          setTo(recipientsText(value.message.to));
          setCc(recipientsText(value.message.cc));
          setBcc(recipientsText(value.message.bcc));
        }
        return runtime
          .runPromise(
            Effect.flatMap(Mailbox, (mailbox) =>
              Effect.gen(function* () {
                const accounts = yield* mailbox.accounts.accounts;
                const account = accounts.find((entry) => entry.id === value.accountId);
                const selected = account
                  ? signatureDefault(
                      yield* mailbox.compose.namedSignatures,
                      yield* mailbox.compose.signatureDefaults,
                      value.message.from?.address ?? account.email,
                      value.message.mode === "new" ? "new" : "reply",
                    )
                  : undefined;
                return { accounts, signature: selected?.text };
              }),
            ),
          )
          .then(({ accounts, signature: selected }) => {
            if (active) setSignature({ text: selected });
            if (active)
              setProvider(
                accounts.find((account) => account.id === value.accountId)?.provider ?? null,
              );
            return null;
          });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [runtime, id, params.accountId, params.draftId, params.messageId, params.mode]);
  const currentMessage = useMemo(() => {
    if (!draft) return null;
    try {
      return {
        ...draft.message,
        to: parseRecipients(to),
        cc: parseRecipients(cc),
        bcc: parseRecipients(bcc),
      };
    } catch {
      return null;
    }
  }, [draft, to, cc, bcc]);
  const autosaveMessage = useMemo(
    () =>
      draft
        ? {
            ...draft.message,
            to: draftRecipients(to),
            cc: draftRecipients(cc),
            bcc: draftRecipients(bcc),
          }
        : null,
    [draft, to, cc, bcc],
  );
  useEffect(() => {
    const message = autosaveMessage;
    lastEdit.current = message;
    let alive = true;
    const timer =
      message && !busy
        ? setTimeout(() => {
            void writer
              .autosave(message)
              .then((wrote) => {
                if (wrote && alive && autosave.current) setSaved(true);
                return null;
              })
              .catch(() => {
                if (alive) setFailed(true);
              });
          }, 600)
        : null;
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [autosaveMessage, writer, busy]);
  useEffect(
    () => () => {
      if (autosave.current && lastEdit.current)
        void writer.autosave(lastEdit.current).catch(() => null);
    },
    [writer],
  );
  useEffect(() => {
    let active = true;
    const query = { to, cc, bcc }[field].split(/[,;]/).at(-1)?.trim() ?? "";
    void runtime
      .runPromise(
        Effect.flatMap(Mailbox, (mailbox) =>
          query
            ? mailbox.compose.suggestContacts(query, { accountIds: [params.accountId], limit: 5 })
            : Effect.succeed([]),
        ),
      )
      .then((values) => {
        if (active) setContacts(values);
        return null;
      })
      .catch(() => {
        if (active) setContacts([]);
      });
    return () => {
      active = false;
    };
  }, [runtime, params.accountId, to, cc, bcc, field]);
  const update = (patch: Partial<OutgoingMessage>) => {
    if (!draft) return;
    const message = { ...draft.message, ...patch };
    if (JSON.stringify(message) === JSON.stringify(draft.message)) return;
    writer.markEdited();
    setSaved(false);
    setRejected(false);
    setDraft({ ...draft, message });
  };
  const attach = async (source: "document" | "photo") => {
    if (!draft || !provider || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const files = await pickAttachments(source, draft.message.attachments, provider);
      update({ attachments: [...draft.message.attachments, ...files] });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const send = async (confirmResend = false) => {
    if (!draft || !provider || !currentMessage || busy) return;
    if (mobileAttachmentProblem(provider, currentMessage.attachments)) {
      setRejected(true);
      return;
    }
    setRejected(false);
    writer.pause();
    autosave.current = false;
    setBusy(true);
    setFailed(false);
    try {
      await writer.save(currentMessage);
      await writer.flush();
      const prefs = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.app.prefs),
      );
      const due = Date.now() + prefs.undoSendSeconds * 1000;
      const queued = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) =>
          mailbox.outbox.queueSend(
            { id: draft.id, accountId: draft.accountId, message: currentMessage },
            due,
            confirmResend,
          ),
        ).pipe(Effect.result),
      );
      if (queued._tag === "Failure") {
        if (queued.failure._tag === "SendUncertain") setUncertain(true);
        throw new Error("Could not queue the message");
      }
      notice({
        kind: "undo",
        text: i18n._({ id: "Queued to send", message: "Queued to send" }),
        until: due,
        undo: async () => {
          const undone = await runtime.runPromise(
            Effect.flatMap(Mailbox, (mailbox) => mailbox.outbox.cancelWaitingSend(draft.id)),
          );
          if (!undone) throw new Error("Send has started");
          router.push({
            pathname: "/compose",
            params: { accountId: draft.accountId, draftId: draft.id },
          });
        },
      });
      router.back();
    } catch {
      writer.resume();
      autosave.current = true;
      setFailed(true);
      setBusy(false);
    }
  };
  const discard = async () => {
    if (busy) return;
    autosave.current = false;
    setBusy(true);
    setFailed(false);
    try {
      await writer.discard();
      router.back();
    } catch {
      writer.resume();
      autosave.current = true;
      setFailed(true);
      setBusy(false);
    }
  };
  const confirmSend = async () => {
    if (!draft || !currentMessage || busy) return;
    if (currentMessage.agentOrigin) {
      setBusy(true);
      try {
        const warnings = await runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) =>
            mobileRecipientWarnings(mailbox, draft.accountId, currentMessage),
          ),
        );
        const approved = await reviewAgentRecipients(
          warnings,
          () =>
            new Promise<boolean>((resolve) => {
              Alert.alert(
                i18n._({ id: "Review AI recipients", message: "Review AI recipients" }),
                [
                  ...(warnings.unfamiliar.length
                    ? [
                        `${i18n._({
                          id: "AI added unfamiliar recipients:",
                          message: "AI added unfamiliar recipients:",
                        })} ${warnings.unfamiliar.join(", ")}`,
                      ]
                    : []),
                  ...(warnings.outsideThread.length
                    ? [
                        `${i18n._({
                          id: "Recipients outside the original conversation:",
                          message: "Recipients outside the original conversation:",
                        })} ${warnings.outsideThread.join(", ")}`,
                      ]
                    : []),
                ].join("\n\n"),
                [
                  {
                    text: i18n._({ id: "Cancel", message: "Cancel" }),
                    style: "cancel",
                    onPress: () => resolve(false),
                  },
                  {
                    text: i18n._({ id: "Continue", message: "Continue" }),
                    onPress: () => resolve(true),
                  },
                ],
                { cancelable: false },
              );
            }),
        );
        if (!approved) return;
      } catch {
        setFailed(true);
        return;
      } finally {
        setBusy(false);
      }
    }
    Alert.alert(
      uncertain
        ? i18n._({
            id: "Have you checked Sent and confirmed that this message was not sent?",
            message: "Have you checked Sent and confirmed that this message was not sent?",
          })
        : i18n._({ id: "Send message?", message: "Send message?" }),
      to,
      [
        { text: i18n._({ id: "Cancel", message: "Cancel" }), style: "cancel" },
        { text: i18n._({ id: "Send", message: "Send" }), onPress: () => void send(uncertain) },
      ],
    );
  };
  return (
    <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled">
      {!draft && !failed && <ActivityIndicator />}
      {draft && signature !== null && (
        <ComposeAi
          accountId={draft.accountId}
          message={draft.message}
          marks={marks}
          list={list}
          signature={signature.text}
          accept={(body) => {
            setAiUndo({
              before: {
                text: draft.message.text,
                html: draft.message.html,
                originalHtml: draft.message.originalHtml,
                marks: [...marks],
                list,
              },
              acceptedText: body.text,
            });
            setMarks([...body.marks]);
            setList(body.list);
            update({ text: body.text, html: body.html, originalHtml: undefined });
          }}
        />
      )}
      {draft && aiUndo && aiUndoBody(draft.message, aiUndo) && (
        <Button
          disabled={busy}
          label={i18n._({ id: "Undo AI edit", message: "Undo AI edit" })}
          onPress={() => {
            const before = aiUndoBody(draft.message, aiUndo);
            if (!before) return;
            setMarks([...before.marks]);
            setList(before.list);
            update({ text: before.text, html: before.html, originalHtml: before.originalHtml });
            setAiUndo(null);
          }}
        />
      )}
      {draft && (
        <>
          <View style={styles.toolbar}>
            <Button
              disabled={
                busy ||
                !provider ||
                !currentMessage ||
                (!currentMessage.to.length &&
                  !currentMessage.cc.length &&
                  !currentMessage.bcc.length)
              }
              label={i18n._({ id: "Send", message: "Send" })}
              onPress={confirmSend}
            />
            <Button
              disabled={busy}
              label={i18n._({ id: "Discard", message: "Discard" })}
              onPress={() => void discard()}
            />
          </View>
          {(["to", "cc", "bcc"] as const).map((name) => (
            <TextInput
              key={name}
              accessibilityLabel={
                name === "to"
                  ? i18n._({ id: "To", message: "To" })
                  : name === "cc"
                    ? i18n._({ id: "Cc", message: "Cc" })
                    : i18n._({ id: "Bcc", message: "Bcc" })
              }
              placeholder={
                name === "to"
                  ? i18n._({ id: "To", message: "To" })
                  : name === "cc"
                    ? i18n._({ id: "Cc", message: "Cc" })
                    : i18n._({ id: "Bcc", message: "Bcc" })
              }
              style={styles.input}
              value={{ to, cc, bcc }[name]}
              autoCapitalize="none"
              keyboardType="email-address"
              onFocus={() => setField(name)}
              onChangeText={(value) => {
                if (value === { to, cc, bcc }[name]) return;
                writer.markEdited();
                setSaved(false);
                (name === "to" ? setTo : name === "cc" ? setCc : setBcc)(value);
              }}
            />
          ))}
          {!currentMessage && (
            <Text accessibilityRole="alert" style={styles.error}>
              {i18n._({
                id: "Enter valid email addresses.",
                message: "Enter valid email addresses.",
              })}
            </Text>
          )}
          {contacts.map((contact) => (
            <Button
              key={contact.address}
              label={recipientsText([contact])}
              onPress={() => {
                writer.markEdited();
                setSaved(false);
                const setter = field === "to" ? setTo : field === "cc" ? setCc : setBcc;
                setter((value) =>
                  [...value.split(/[,;]/).slice(0, -1), recipientsText([contact])]
                    .join(", ")
                    .concat(", "),
                );
              }}
            />
          ))}
          <TextInput
            accessibilityLabel={i18n._({ id: "Subject", message: "Subject" })}
            placeholder={i18n._({ id: "Subject", message: "Subject" })}
            style={styles.input}
            value={draft.message.subject}
            onChangeText={(subject) => update({ subject })}
          />
          <View style={styles.toolbar}>
            {(
              [
                { kind: "plain", label: i18n._({ id: "Plain text", message: "Plain text" }) },
                { kind: "bold", label: i18n._({ id: "Bold", message: "Bold" }) },
                { kind: "italic", label: i18n._({ id: "Italic", message: "Italic" }) },
                { kind: "list", label: i18n._({ id: "Bulleted list", message: "Bulleted list" }) },
              ] satisfies { kind: Format; label: string }[]
            ).map((item) => (
              <Button
                key={item.kind}
                label={item.label}
                onPress={() => {
                  const nextMarks =
                    item.kind === "plain"
                      ? []
                      : item.kind === "list"
                        ? marks
                        : markSelection(draft.message.text, marks, selection, item.kind);
                  const nextList =
                    item.kind === "plain" ? false : item.kind === "list" ? !list : list;
                  setMarks(nextMarks);
                  setList(nextList);
                  const body = richTextBody(draft.message.text, nextMarks, nextList);
                  if (body.text !== draft.message.text || body.html !== draft.message.html) {
                    writer.markEdited();
                    setSaved(false);
                  }
                  setDraft((value) => {
                    if (!value) return value;
                    const { html: _html, ...rest } = value.message;
                    return { ...value, message: { ...rest, ...body } };
                  });
                }}
              />
            ))}
          </View>
          <TextInput
            multiline
            accessibilityLabel={i18n._({
              id: "Message text",
              message: "Message text",
              comment: "Plain message body text field.",
            })}
            style={[styles.input, { minHeight: 220, textAlignVertical: "top" }]}
            value={draft.message.text}
            onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
            onChangeText={(text) => {
              if (text === draft.message.text) return;
              writer.markEdited();
              setSaved(false);
              const next = editMarks(draft.message.text, text, marks);
              setMarks(next);
              const body = richTextBody(text, next, list);
              setDraft((value) => {
                if (!value) return value;
                const { html: _html, originalHtml: _original, ...rest } = value.message;
                return { ...value, message: { ...rest, ...body } };
              });
            }}
          />
          {(marks.length > 0 || list) && (
            <View style={styles.message}>
              <Text style={styles.detail}>{i18n._({ id: "Preview", message: "Preview" })}</Text>
              <Text style={styles.body}>
                {richTextSegments(draft.message.text, marks).map((segment) => (
                  <Text
                    key={segment.start}
                    style={{
                      fontWeight: segment.bold ? "700" : "400",
                      fontStyle: segment.italic ? "italic" : "normal",
                    }}
                  >
                    {list ? segment.text.replaceAll("\n", "\n• ") : segment.text}
                  </Text>
                ))}
              </Text>
            </View>
          )}
          <Button
            disabled={busy}
            label={i18n._({ id: "Attach file", message: "Attach file" })}
            onPress={() => void attach("document")}
          />
          <Button
            disabled={busy}
            label={i18n._({ id: "Attach photo", message: "Attach photo" })}
            onPress={() => void attach("photo")}
          />
          {draft.message.attachments.map((file, index) => (
            <Button
              key={`${index}:${file.filename}`}
              label={i18n._({
                id: "Remove {filename}",
                message: "Remove {filename}",
                values: { filename: file.filename },
              })}
              onPress={() =>
                update({
                  attachments: draft.message.attachments.filter(
                    (_, position) => index !== position,
                  ),
                })
              }
            />
          ))}
          {saved && (
            <Text accessibilityLiveRegion="polite" style={styles.detail}>
              {i18n._({ id: "Draft saved on this device", message: "Draft saved on this device" })}
            </Text>
          )}
        </>
      )}
      {uncertain && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "This message may have been sent. Check Sent before sending it again.",
            message: "This message may have been sent. Check Sent before sending it again.",
          })}
        </Text>
      )}
      {rejected && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Attachments rejected before sending. Remove blocked or oversized attachments.",
            message:
              "Attachments rejected before sending. Remove blocked or oversized attachments.",
          })}
        </Text>
      )}
      {failed && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not save, attach or queue mail. Try again.",
            message: "Could not save, attach or queue mail. Try again.",
          })}
        </Text>
      )}
    </ScrollView>
  );
}
