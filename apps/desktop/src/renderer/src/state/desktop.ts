import { NATIVE_MENUS } from "../../../shared/native-actions";
import { ACTION_NAMES } from "../i18n/shortcut-names";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Effect, Fiber, Stream } from "effect";
import { useEffect, useEffectEvent } from "react";

import { cleanLink, parseAppLink } from "@openmail/core/schema";
import type { DesktopEvent } from "../../../shared/desktop";
import { pluralTemplates } from "../../../shared/desktop-labels";
import { externalUrl } from "../../../shared/external-url";
import { isDesktop, openOnDevice } from "../lib/platform";
import { useRunMail, withMail } from "./mail";

const localListeners = new Set<(event: DesktopEvent) => void>();

/**
 * Delivers an event as if main had sent it. The web build uses it for
 * actions main would route back to this window, such as a sender search.
 */
export function emitLocalDesktopEvent(event: DesktopEvent) {
  for (const listener of localListeners) listener(event);
}

/**
 * Opens a link from mail. The desktop app asks main, which opens the Mac's
 * browser. The web build opens it on this device with the same checks: http,
 * https or a mailto that starts a message here, never anything else.
 */
export const openMailLink = (url: string, cleanLinks = true) =>
  isDesktop()
    ? withMail((call) => call("OpenMailLink", { url }))
    : Effect.sync(() => {
        const target = externalUrl(url);
        if (!target) return;
        if (new URL(target).protocol === "mailto:") {
          const link = parseAppLink(target);
          if (link?.kind === "compose")
            emitLocalDesktopEvent({ _tag: "Compose", draft: link.draft });
          return;
        }
        openOnDevice(cleanLink(target, cleanLinks));
      });

/** The stream buffers launch URLs in main until this window subscribes. */
export function useDesktopEvents(receive: (event: DesktopEvent) => void) {
  const run = useRunMail();
  const onEvent = useEffectEvent(receive);
  useEffect(() => {
    const local = (event: DesktopEvent) => onEvent(event);
    localListeners.add(local);
    return () => {
      localListeners.delete(local);
    };
  }, []);
  useEffect(() => {
    const fiber = run(
      withMail((call) =>
        call("DesktopEvents", undefined).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [run]);
}

export function useDesktopLabels() {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  useEffect(() => {
    run(
      withMail((call) =>
        call("SetDesktopLabels", {
          labels: {
            menuLabels: {
              message: t`Message`,
              mailbox: t`Mailbox`,
              format: t`Format`,
              ...Object.fromEntries(
                NATIVE_MENUS.flatMap((group) =>
                  group.actions.map((action) => [action, i18n._(ACTION_NAMES[action])]),
                ),
              ),
            },
            checkUpdates: t`Check for updates…`,
            updatesDisabled: t`Update checks require a signed, installed macOS app.`,
            updatesCurrent: t`OpenMail is up to date.`,
            updatesAvailable: t`Update available:`,
            updatesFailed: t`Couldn't check for updates. Try again later.`,
            ok: t`OK`,
            read: t`Mark read`,
            actionMenu: t`Actions`,
            settings: t`Settings`,
            newWindow: t`New window`,
            compose: t`New message`,
            attachFiles: t`Attach files…`,
            helpMenu: t`Help`,
            help: t`Keyboard shortcuts`,
            archive: t`Archive`,
            trash: t`Delete`,
            noUnread: t`No unread mail`,
            showInbox: t`Show Inbox`,
            allAccounts: t`All accounts`,
            file: t`File`,
            edit: t`Edit`,
            undo: t`Undo`,
            undoSend: t`Undo send`,
            quitPending: t`Quit with messages waiting to send?`,
            quitPendingDetail: t`Messages in the undo window will remain drafts. A send already in progress may finish.`,
            quit: t`Quit`,
            cancel: t`Cancel`,
            selectAll: t`Select all`,
            window: t`Window`,
            feedback: t`Send feedback…`,
            newMessages: pluralTemplates(
              i18n.locale,
              (count) => t`${plural(count, { one: "# new message", other: "# new messages" })}`,
              (count) => i18n.number(count),
            ),
            locale: i18n.locale,
          },
        }),
      ),
    );
  }, [run, t, i18n]);
}
