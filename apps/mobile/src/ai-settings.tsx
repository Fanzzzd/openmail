import { useCallback, useState } from "react";
import { Alert, Switch, Text, TextInput, View } from "react-native";
import { useLingui } from "@lingui/react";
import {
  Mailbox,
  AI_MODELS,
  signatureDefault,
  type Account,
  type SignatureKind,
  type NamedSignature,
} from "@openmail/core/portable";
import { Effect } from "effect";
import { useMailbox, useMailboxQuery } from "./mailbox";
import { Button, Sheet } from "./controls";
import { styles } from "./styles";

export function AiSettings({ accounts }: { accounts: readonly Account[] }) {
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const settings = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.aiSettings)),
      [runtime],
    ),
    { keepPrevious: true },
  );
  const change = async (effect: Effect.Effect<void, unknown, Mailbox>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await runtime.runPromise(effect);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const consent = i18n._({
    id: "Allow Anthropic to receive this account's visible mail text for AI. Images and attachments stay on this device. Changes require your approval.",
    message:
      "Allow Anthropic to receive this account's visible mail text for AI. Images and attachments stay on this device. Changes require your approval.",
  });
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{i18n._({ id: "AI", message: "AI" })}</Text>
      <Text style={styles.detail}>{consent}</Text>
      <Text style={styles.detail}>
        {i18n._({
          id: "MCP access follows this account's AI consent. Disabled accounts cannot be read through MCP.",
          message:
            "MCP access follows this account's AI consent. Disabled accounts cannot be read through MCP.",
        })}
      </Text>
      <TextInput
        style={styles.input}
        accessibilityLabel={i18n._({ id: "Anthropic API key", message: "Anthropic API key" })}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={key}
        onChangeText={setKey}
        maxLength={4096}
      />
      <Button
        disabled={busy || !key.trim()}
        label={i18n._({ id: "Save key", message: "Save key" })}
        onPress={() => {
          const value = key;
          setKey("");
          void change(Effect.flatMap(Mailbox, (mailbox) => mailbox.setAiKey(value)));
        }}
      />
      {settings.kind === "ready" && (
        <>
          {settings.value.keyConfigured && (
            <>
              <Text style={styles.detail}>
                {i18n._({ id: "API key saved", message: "API key saved" })}
              </Text>
              <Button
                disabled={busy}
                label={i18n._({ id: "Remove key", message: "Remove key" })}
                onPress={() =>
                  void change(Effect.flatMap(Mailbox, (mailbox) => mailbox.setAiKey("")))
                }
              />
            </>
          )}
          <Text style={styles.subject}>{i18n._({ id: "Model", message: "Model" })}</Text>
          {AI_MODELS.map((model) => (
            <Button
              key={model}
              disabled={busy || model === settings.value.model}
              label={model}
              onPress={() =>
                void change(Effect.flatMap(Mailbox, (mailbox) => mailbox.setAiModel(model)))
              }
            />
          ))}
          {accounts.map((account) => {
            const saved = settings.value.accounts.find(
              (entry) => entry.accountId === account.id,
            ) ?? { accountId: account.id, allowed: false, autoSummaries: false, autoTriage: false };
            const setAllowed = (allowed: boolean) =>
              void change(
                Effect.flatMap(Mailbox, (mailbox) =>
                  mailbox.setAiAccount({
                    ...saved,
                    allowed,
                    autoSummaries: allowed && saved.autoSummaries,
                    autoTriage: allowed && saved.autoTriage,
                  }),
                ),
              );
            return (
              <View key={account.id} style={styles.row}>
                <Text style={styles.subject}>{account.email}</Text>
                <Text>
                  {i18n._({
                    id: "Allow mail text to Anthropic",
                    message: "Allow mail text to Anthropic",
                  })}
                </Text>
                <Switch
                  disabled={busy}
                  value={saved.allowed}
                  accessibilityLabel={i18n._({
                    id: "Allow mail text to Anthropic",
                    message: "Allow mail text to Anthropic",
                  })}
                  onValueChange={(allowed) => {
                    if (!allowed) {
                      setAllowed(false);
                      return;
                    }
                    Alert.alert(account.email, consent, [
                      { text: i18n._({ id: "Cancel", message: "Cancel" }), style: "cancel" },
                      {
                        text: i18n._({ id: "Allow", message: "Allow" }),
                        onPress: () => setAllowed(true),
                      },
                    ]);
                  }}
                />
                <Text>{i18n._({ id: "Automatic summaries", message: "Automatic summaries" })}</Text>
                <Switch
                  disabled={busy || !saved.allowed}
                  value={saved.allowed && saved.autoSummaries}
                  accessibilityLabel={i18n._({
                    id: "Automatic summaries",
                    message: "Automatic summaries",
                  })}
                  onValueChange={(autoSummaries) =>
                    void change(
                      Effect.flatMap(Mailbox, (mailbox) =>
                        mailbox.setAiAccount({ ...saved, autoSummaries }),
                      ),
                    )
                  }
                />
              </View>
            );
          })}
        </>
      )}
      {(failed || settings.kind === "failed") && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not save settings. Try again.",
            message: "Could not save settings. Try again.",
          })}
        </Text>
      )}
    </View>
  );
}

type SignatureEdit = { kind: SignatureKind; text: string; signature: NamedSignature | undefined };
export function MobileSignatures({ account }: { account: Account }) {
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const [edit, setEdit] = useState<SignatureEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const signatures = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) =>
            Effect.gen(function* () {
              return {
                library: yield* mailbox.namedSignatures,
                defaults: yield* mailbox.signatureDefaults,
              };
            }),
          ),
        ),
      [runtime],
    ),
  );
  const save = async () => {
    if (!edit || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) =>
          Effect.gen(function* () {
            const signature = edit.text.trim()
              ? yield* mailbox.saveNamedSignature(
                  {
                    address: account.email,
                    name: edit.signature?.name ?? account.email,
                    text: edit.text,
                  },
                  edit.signature?.source === "local" ? edit.signature.id : undefined,
                )
              : null;
            yield* mailbox.setSignatureDefault({
              address: account.email.toLowerCase(),
              kind: edit.kind,
              signatureId: signature?.id ?? null,
            });
          }),
        ),
      );
      setEdit(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Text style={styles.subject}>{i18n._({ id: "Signature", message: "Signature" })}</Text>
      {(["new", "reply"] as const).map((kind) => (
        <Button
          key={kind}
          disabled={signatures.kind !== "ready" || busy}
          label={
            kind === "new"
              ? i18n._({ id: "New messages", message: "New messages" })
              : i18n._({ id: "Replies and forwards", message: "Replies and forwards" })
          }
          onPress={() => {
            if (signatures.kind !== "ready") return;
            const signature = signatureDefault(
              signatures.value.library,
              signatures.value.defaults,
              account.email,
              kind,
            );
            setFailed(false);
            setEdit({ kind, signature, text: signature?.text ?? "" });
          }}
        />
      ))}
      {edit && (
        <Sheet
          title={i18n._({ id: "Signature", message: "Signature" })}
          close={() => {
            if (!busy) setEdit(null);
          }}
          cancel={i18n._({ id: "Cancel", message: "Cancel" })}
        >
          <TextInput
            multiline
            style={styles.input}
            accessibilityLabel={i18n._({ id: "Signature", message: "Signature" })}
            value={edit.text}
            onChangeText={(text) => setEdit({ ...edit, text })}
            editable={!busy}
          />
          <Button
            disabled={busy}
            label={i18n._({ id: "Save signature", message: "Save signature" })}
            onPress={() => void save()}
          />
          {failed && (
            <Text accessibilityRole="alert" style={styles.error}>
              {i18n._({
                id: "Could not save settings. Try again.",
                message: "Could not save settings. Try again.",
              })}
            </Text>
          )}
        </Sheet>
      )}
      {signatures.kind === "failed" && (
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
