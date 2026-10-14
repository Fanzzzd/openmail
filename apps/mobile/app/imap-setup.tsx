import {
  IMAP_PRESETS,
  Mailbox,
  type Account,
  type ImapConnectInput,
} from "@openmail/core/portable";
import { Effect } from "effect";
import { useLingui } from "@lingui/react";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, Text, TextInput, View } from "react-native";
import { Button } from "../src/controls";
import { useMailbox, useMailboxQuery } from "../src/mailbox";
import { styles } from "../src/styles";

export default function ImapSetup() {
  const { accountId } = useLocalSearchParams<{ accountId?: string }>();
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const accounts = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts.accounts)),
      [runtime],
    ),
  );
  if (!accountId) return <ImapForm />;
  if (accounts.kind === "loading") return <ActivityIndicator />;
  const account =
    accounts.kind === "ready" ? accounts.value.find((item) => item.id === accountId) : undefined;
  if (!account?.imap)
    return (
      <Text accessibilityRole="alert" style={styles.error}>
        {i18n._({
          id: "Could not load mail. Try again.",
          message: "Could not load mail. Try again.",
        })}
      </Text>
    );
  return <ImapForm key={account.id} account={account} />;
}
function ImapForm({ account }: { account?: Account }) {
  const accountId = account?.id;
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const [preset, setPreset] = useState(account?.imap?.preset ?? "icloud");
  const [email, setEmail] = useState(account?.email ?? "");
  const [username, setUsername] = useState(account?.imap?.username ?? "");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState(account?.imap?.imapHost ?? "");
  const [imapPort, setImapPort] = useState(String(account?.imap?.imapPort ?? 993));
  const [smtpHost, setSmtpHost] = useState(account?.imap?.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(String(account?.imap?.smtpPort ?? 465));
  const [smtpSecure, setSmtpSecure] = useState(account?.imap?.smtpSecure ?? true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const input: ImapConnectInput = {
      preset,
      email,
      username,
      password,
      ...(preset === "custom" || accountId
        ? { imapHost, imapPort: Number(imapPort), smtpHost, smtpPort: Number(smtpPort), smtpSecure }
        : {}),
    };
    try {
      const connected = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts.connect({ provider: "imap", input })),
      );
      setPassword("");
      router.replace({ pathname: "/mailboxes", params: { accountId: connected.id } });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const chosen = IMAP_PRESETS[preset];
  const fields = [
    {
      label: i18n._({ id: "Email address", message: "Email address" }),
      value: email,
      change: setEmail,
      secure: false,
      editable: !accountId,
    },
    {
      label: i18n._({ id: "Username", message: "Username" }),
      value: username,
      change: setUsername,
      secure: false,
      editable: true,
    },
    {
      label: i18n._({ id: "App password", message: "App password" }),
      value: password,
      change: setPassword,
      secure: true,
      editable: true,
    },
    ...(preset === "custom"
      ? [
          {
            label: i18n._({ id: "IMAP server", message: "IMAP server" }),
            value: imapHost,
            change: setImapHost,
            secure: false,
            editable: true,
          },
          {
            label: i18n._({ id: "IMAP port", message: "IMAP port" }),
            value: imapPort,
            change: setImapPort,
            secure: false,
            editable: true,
          },
          {
            label: i18n._({ id: "SMTP server", message: "SMTP server" }),
            value: smtpHost,
            change: setSmtpHost,
            secure: false,
            editable: true,
          },
          {
            label: i18n._({ id: "SMTP port", message: "SMTP port" }),
            value: smtpPort,
            change: setSmtpPort,
            secure: false,
            editable: true,
          },
        ]
      : []),
  ];
  return (
    <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.toolbar}>
        {[
          { id: "icloud", name: "iCloud" },
          { id: "yahoo", name: "Yahoo" },
          { id: "qq", name: "QQ" },
          { id: "163", name: "163" },
          { id: "fastmail", name: "Fastmail" },
          { id: "custom", name: i18n._({ id: "Other", message: "Other" }) },
        ].map((item) => (
          <Button
            key={item.id}
            label={item.name}
            disabled={busy || !!accountId || preset === item.id}
            onPress={() => setPreset(item.id)}
          />
        ))}
      </View>
      {fields.map((field) => (
        <View key={field.label}>
          <Text style={styles.detail}>{field.label}</Text>
          <TextInput
            accessibilityLabel={field.label}
            style={styles.input}
            value={field.value}
            onChangeText={field.change}
            secureTextEntry={field.secure}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy && field.editable}
          />
        </View>
      ))}
      {chosen?.appPasswordUrl && (
        <Button
          label={i18n._({ id: "Create an app password", message: "Create an app password" })}
          onPress={() => {
            void Linking.openURL(chosen.appPasswordUrl ?? "").catch(() => setFailed(true));
          }}
        />
      )}
      {preset === "custom" && (
        <Button
          disabled={busy}
          label={
            smtpSecure
              ? i18n._({ id: "SMTP: TLS", message: "SMTP: TLS" })
              : i18n._({ id: "SMTP: STARTTLS", message: "SMTP: STARTTLS" })
          }
          onPress={() => {
            setSmtpSecure(!smtpSecure);
            setSmtpPort(smtpSecure ? "587" : "465");
          }}
        />
      )}
      <Button
        label={i18n._({ id: "Connect", message: "Connect" })}
        disabled={busy || !email.trim() || !password}
        onPress={() => void connect()}
      />
      {failed && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not connect. Check the servers and app password.",
            message: "Could not connect. Check the servers and app password.",
          })}
        </Text>
      )}
    </ScrollView>
  );
}
