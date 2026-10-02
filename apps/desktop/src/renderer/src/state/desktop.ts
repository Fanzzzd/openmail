import { NATIVE_MENUS } from "../../../shared/native-actions";
import { ACTION_NAMES } from "../components/SystemSettings";
import { useLingui } from "@lingui/react/macro";
import { Effect, Fiber, Stream } from "effect";
import { useEffect, useEffectEvent } from "react";

import type { DesktopEvent } from "../../../shared/desktop";
import { useRunMail, withMail } from "./mail";

/** The stream buffers launch URLs in main until this window subscribes. */
export function useDesktopEvents(receive: (event: DesktopEvent) => void) {
  const run = useRunMail();
  const onEvent = useEffectEvent(receive);
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
            spelling: {
              add: t`Add to Dictionary`,
              check: t`Check spelling while typing`,
              noSuggestions: t`No suggestions`,
            },
            checkUpdates: t`Check for Updates…`,
            updatesDisabled: t`Update checks require a signed, installed macOS app and a saved GitHub access token.`,
            updatesCurrent: t`OpenMail is up to date.`,
            updatesAvailable: t`Update available:`,
            updatesFailed: t`Could not check for updates. Try again later.`,
            ok: t`OK`,
            read: t`Mark read`,
            actionMenu: t`Actions`,
            settings: t`Settings`,
            newWindow: t`New Window`,
            compose: t`New message`,
            attachFiles: t`Attach Files…`,
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
            undoSend: t`Undo Send`,
            quitPending: t`Quit with messages waiting to send?`,
            quitPendingDetail: t`Messages in the undo window will remain drafts. A send already in progress may finish.`,
            quit: t`Quit`,
            cancel: t`Cancel`,
            selectAll: t`Select all`,
            window: t`Window`,
            feedback: t`Send Feedback…`,
            newMessages: t`new messages`,
          },
        }),
      ),
    );
  }, [run, t, i18n]);
}
