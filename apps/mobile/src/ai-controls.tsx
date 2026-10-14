import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useLingui } from "@lingui/react";
import { router } from "expo-router";
import {
  messageModelText,
  mobileComposeTextPrefix,
  type OutgoingMessage,
  type AiComposeRequest,
} from "@openmail/core/portable";
import { useAiRequest } from "./ai-request";
import { Button } from "./controls";
import { styles } from "./styles";
import { applyAiEdit, composeAiPart, type AiEditorBody } from "./ai-edit";
import type { Mark } from "./rich-text";

function AiError() {
  const { i18n } = useLingui();
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {i18n._({
        id: "AI request failed. Check your settings and try again.",
        message: "AI request failed. Check your settings and try again.",
      })}
    </Text>
  );
}
export function ThreadAi({ accountId, messageId }: { accountId: string; messageId: string }) {
  const { i18n } = useLingui();
  const ai = useAiRequest(accountId);
  const { enabled, account, run } = ai;
  const [question, setQuestion] = useState("");
  const automatic = useRef("");
  useEffect(() => {
    const key = `${accountId}:${messageId}`;
    if (!enabled || !account?.autoSummaries || automatic.current === key) return;
    automatic.current = key;
    void run((mailbox) => mailbox.ai.summarize(messageId));
  }, [accountId, messageId, enabled, account?.autoSummaries, run]);
  if (!ai.enabled) return null;
  const busy = ai.response.kind === "busy";
  return (
    <View style={styles.row}>
      <Button
        disabled={busy}
        label={i18n._({ id: "Summarize conversation", message: "Summarize conversation" })}
        onPress={() => void ai.run((mailbox) => mailbox.ai.summarize(messageId))}
      />
      <Text style={styles.subject}>
        {i18n._({ id: "Ask about this conversation", message: "Ask about this conversation" })}
      </Text>
      <TextInput
        style={styles.input}
        accessibilityLabel={i18n._({ id: "Question", message: "Question" })}
        value={question}
        onChangeText={setQuestion}
        maxLength={4000}
        multiline
      />
      <Button
        disabled={busy || !question.trim()}
        label={i18n._({ id: "Ask", message: "Ask" })}
        onPress={() =>
          void ai.run((mailbox) =>
            mailbox.ai.askAi({
              accountIds: [accountId],
              threadId: messageId,
              question: question.trim(),
            }),
          )
        }
      />
      {busy && <Button label={i18n._({ id: "Cancel", message: "Cancel" })} onPress={ai.cancel} />}
      {ai.response.kind === "ready" && (
        <Text selectable style={styles.body}>
          {ai.response.text}
        </Text>
      )}
      {ai.response.kind === "failed" && <AiError />}
      <Button
        label={i18n._({ id: "Review proposals", message: "Review proposals" })}
        onPress={() => router.push("/ai-proposals")}
      />
    </View>
  );
}
export function ComposeAi({
  accountId,
  message,
  accept,
  marks = [],
  list = false,
  signature,
}: {
  accountId: string;
  message: OutgoingMessage;
  accept: (body: AiEditorBody) => void;
  marks?: readonly Mark[];
  list?: boolean;
  signature?: string;
}) {
  const { i18n } = useLingui();
  const ai = useAiRequest(accountId);
  const [base, setBase] = useState<{
    message: OutgoingMessage;
    editor: AiEditorBody;
    signature?: string;
  } | null>(null);
  if (!ai.enabled) return null;
  const busy = ai.response.kind === "busy";
  const changed = base?.message !== message;
  const part = composeAiPart(message.text, signature, message.html);
  const authoredHtml = part.text ? mobileComposeTextPrefix(message, part.end) : null;
  const edit =
    base && !changed && ai.response.kind === "ready"
      ? applyAiEdit(base.editor, ai.response.text, base.signature)
      : null;
  const request = (tone: Extract<AiComposeRequest["task"], { kind: "rewrite" }>["tone"]) => {
    setBase({
      message,
      editor: {
        text: message.text,
        html: message.html,
        originalHtml: message.originalHtml,
        marks: [...marks],
        list,
      },
      signature,
    });
    void ai.run((mailbox) =>
      mailbox.ai.composeAi({
        accountId,
        text: messageModelText(part.text, authoredHtml ?? "").text,
        ...(message.inReplyTo ? { replyTo: message.inReplyTo } : {}),
        task: { kind: "rewrite", tone },
      }),
    );
  };
  return (
    <View style={styles.row}>
      <View style={styles.toolbar}>
        <Button
          disabled={busy || !part.text || authoredHtml === null}
          label={i18n._({ id: "Rewrite", message: "Rewrite" })}
          onPress={() => request("proofread")}
        />
        <Button
          disabled={busy || !part.text || authoredHtml === null}
          label={i18n._({ id: "Shorten", message: "Shorten" })}
          onPress={() => request("shorter")}
        />
        <Button
          disabled={busy || !part.text || authoredHtml === null}
          label={i18n._({ id: "Friendlier", message: "Friendlier" })}
          onPress={() => request("friendlier")}
        />
        <Button
          disabled={busy || !part.text || authoredHtml === null}
          label={i18n._({ id: "Formal", message: "Formal" })}
          onPress={() => request("formal")}
        />
      </View>
      {busy && <Button label={i18n._({ id: "Cancel", message: "Cancel" })} onPress={ai.cancel} />}
      {ai.response.kind === "ready" && (
        <>
          <Text style={styles.detail}>
            {i18n._({
              id: "Before",
              message: "Before",
              comment:
                "Authored message text before the AI edit; excludes signature and quoted history.",
            })}
          </Text>
          <Text selectable style={styles.body}>
            {base
              ? composeAiPart(base.message.text, base.signature, base.message.html).text
              : part.text}
          </Text>
          <Text style={styles.detail}>
            {i18n._({
              id: "After",
              message: "After",
              comment: "Proposed replacement for the authored message text only.",
            })}
          </Text>
          <Text selectable style={styles.body}>
            {ai.response.text.trim()}
          </Text>
          {changed && (
            <Text style={styles.detail}>
              {i18n._({
                id: "Draft changed. Generate again.",
                message: "Draft changed. Generate again.",
              })}
            </Text>
          )}
          <Button
            disabled={changed || !edit}
            label={i18n._({ id: "Apply draft change", message: "Apply draft change" })}
            onPress={() => {
              if (ai.response.kind !== "ready" || base?.message !== message || !edit) return;
              accept(edit);
              ai.cancel();
            }}
          />
          <Button label={i18n._({ id: "Reject", message: "Reject" })} onPress={ai.cancel} />
        </>
      )}
      {ai.response.kind === "failed" && <AiError />}
    </View>
  );
}
