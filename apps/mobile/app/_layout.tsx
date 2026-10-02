import { I18nProvider, useLingui } from "@lingui/react";
import { Stack } from "expo-router";
import { MailboxProvider } from "../src/mailbox";
import { i18n as mobileI18n } from "../src/i18n";

function Navigation() {
  const { i18n } = useLingui();
  return (
    <Stack
      screenOptions={{ headerTintColor: "#1f4fd1", contentStyle: { backgroundColor: "#ffffff" } }}
    >
      <Stack.Screen
        name="index"
        options={{ title: i18n._({ id: "Accounts", message: "Accounts" }) }}
      />
      <Stack.Screen
        name="mailboxes"
        options={{ title: i18n._({ id: "Mailboxes", message: "Mailboxes" }) }}
      />
      <Stack.Screen
        name="threads"
        options={{ title: i18n._({ id: "Messages", message: "Messages" }) }}
      />
      <Stack.Screen
        name="reader"
        options={{ title: i18n._({ id: "Conversation", message: "Conversation" }) }}
      />
    </Stack>
  );
}
export default function Layout() {
  return (
    <I18nProvider i18n={mobileI18n}>
      <MailboxProvider>
        <Navigation />
      </MailboxProvider>
    </I18nProvider>
  );
}
