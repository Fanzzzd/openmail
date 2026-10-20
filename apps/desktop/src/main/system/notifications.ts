import {
  logError,
  Mailbox,
  messageLink,
  notificationAction,
  notificationButtonActions,
  type Prefs,
} from "@openmail/core";
import { Effect } from "effect";
import { Notification } from "electron";
import { showNotification } from "../windows/reveal";
import { type DesktopLabels, pluralText } from "../../shared/desktop-labels";

/**
 * New-mail notifications: one per message, or a digest for a large batch. Clicking opens the
 * thread; the action buttons run the person's notification actions on it.
 */
export function makeNotifications({
  mailbox,
  run,
  openThread,
  labels,
  ready,
}: {
  mailbox: Mailbox["Service"];
  run: <A, E>(effect: Effect.Effect<A, E>) => unknown;
  openThread: (id: string) => void;
  labels: () => DesktopLabels;
  /** The renderer has sent its labels; notifications wait for them. */
  ready: () => boolean;
}) {
  const notifications = new Set<Notification>();
  const notificationAccounts = new Map<Notification, readonly string[]>();
  const wireNotification = (
    notification: Notification,
    id: string,
    actions: Prefs["notificationActions"],
  ) => {
    notifications.add(notification);
    notification.on("click", () => openThread(id));
    // Electron 44 supplies actionIndex on the event; the positional argument is deprecated.
    notification.on("action", (event) => {
      const op = notificationAction(
        notificationButtonActions(actions, process.platform),
        event.actionIndex,
        event.selectionIndex,
      );
      if (!op) return;
      notification.close();
      run(
        mailbox.organize
          .perform({ kind: "modify", threads: [id], op }, { kind: "user", surface: "app" })
          .pipe(
            Effect.catchCause((cause) =>
              logError("notification-action-failed", "notification action failed", cause),
            ),
          ),
      );
    });
    notification.on("close", () => {
      notifications.delete(notification);
      notificationAccounts.delete(notification);
    });
    notification.on("failed", () => {
      notifications.delete(notification);
      notificationAccounts.delete(notification);
    });
  };
  const notify = Effect.gen(function* () {
    // Startup refresh and arrivals must wait for the renderer's Lingui labels.
    if (!ready() || !Notification.isSupported()) return;
    const prefs = yield* mailbox.app.prefs;
    const actions = notificationButtonActions(prefs.notificationActions, process.platform);
    const batches = yield* mailbox.app.takeNotifications;
    const accounts = yield* mailbox.accounts.accounts;
    const profiles = yield* mailbox.accounts.profiles;
    for (const batch of batches) {
      const first = batch.messages[0];
      if (!first) continue;
      const account = accounts.find((a) => a.id === first.accountId);
      if (batch.kind === "digest" || batch.messages.length > 5) {
        const singleAccount = batch.messages.every(
          (message) => message.accountId === first.accountId,
        );
        // reveal-ok: constructs the banner only; showNotification in reveal.ts posts it.
        const notification = new Notification({
          id: messageLink(first.id),
          groupId: batch.profileId ?? first.accountId,
          title: pluralText(labels().locale, labels().newMessages, batch.messages.length),
          body:
            profiles.find((p) => p.id === batch.profileId)?.name ??
            (singleAccount
              ? account
                ? account.description?.trim() || account.email
                : labels().allAccounts
              : labels().allAccounts),
        });
        notificationAccounts.set(
          notification,
          batch.messages.map((message) => message.accountId),
        );
        notifications.add(notification);
        notification.on("click", () => openThread(first.id));
        notification.on("close", () => {
          notifications.delete(notification);
          notificationAccounts.delete(notification);
        });
        notification.on("failed", () => {
          notifications.delete(notification);
          notificationAccounts.delete(notification);
        });
        showNotification(notification);
        continue;
      }
      for (const message of batch.messages) {
        const id = message.id;
        // reveal-ok: constructs the banner only; showNotification in reveal.ts posts it.
        const notification = new Notification({
          id: messageLink(id),
          groupId: batch.profileId ?? message.accountId,
          title: message.from.name || message.from.address,
          subtitle: message.subject,
          body: message.snippet,
          actions: actions.map((action) =>
            action === "menu"
              ? {
                  type: "selection" as const,
                  text: labels().actionMenu,
                  items: [labels().archive, labels().trash, labels().read],
                }
              : { type: "button" as const, text: labels()[action] },
          ),
        });
        notificationAccounts.set(notification, [message.accountId]);
        yield* mailbox.app.rememberNotificationActions(id, actions);
        wireNotification(notification, id, actions);
        showNotification(notification);
      }
    }
  });
  return { notifications, notificationAccounts, wireNotification, notify };
}
