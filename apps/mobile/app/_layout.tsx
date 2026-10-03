import { I18nProvider, useLingui } from "@lingui/react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ForegroundLifecycle } from "../src/lifecycle";
import { UndoProvider } from "../src/undo";
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
        name="compose"
        options={{ title: i18n._({ id: "Compose", message: "Compose" }), presentation: "modal" }}
      />
      <Stack.Screen
        name="imap-setup"
        options={{
          title: i18n._({ id: "Add IMAP/SMTP account", message: "Add IMAP/SMTP account" }),
        }}
      />
      <Stack.Screen
        name="settings"
        options={{ title: i18n._({ id: "Settings", message: "Settings" }) }}
      />
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
      <GestureHandlerRootView style={{ flex: 1 }}>
        <MailboxProvider>
          <UndoProvider>
            <ForegroundLifecycle />
            <Navigation />
          </UndoProvider>
        </MailboxProvider>
      </GestureHandlerRootView>
    </I18nProvider>
  );
}
