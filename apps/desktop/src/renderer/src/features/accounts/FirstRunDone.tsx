import { useAtomSet } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRef } from "react";

import { setPrefsAtom } from "../../state/mutations";
import { Dialog } from "../../ui/Dialog";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { buttonPrimary, buttonSecondary } from "../../ui/styles";
import { useShortcutSet, useShortcutText } from "../../i18n/use-shortcut-text";
import { SET_NAMES } from "../../i18n/shortcut-set-names";
import { useDefaultMailClient } from "../settings/use-default-mail-client";
import { isDesktop } from "../../lib/platform";
import { Keys } from "../../state/keys";

/**
 * The step after the first account: mail is syncing, the keymap with three shortcuts to start
 * with, and two optional setups. Done, Escape or a click outside skips it; it does not come back.
 */
export function FirstRunDone({
  onClose,
  onAiAccess,
}: {
  onClose: () => void;
  /** Opens Settings at AI Access. */
  onAiAccess?: (() => void) | undefined;
}) {
  const { t, i18n } = useLingui();
  const shortcut = useShortcutText();
  const set = useShortcutSet();
  const setPrefs = useAtomSet(setPrefsAtom);
  const defaultApp = useDefaultMailClient();
  const done = useRef<HTMLButtonElement>(null);
  const keys = [
    { action: "compose", label: t`New message` },
    { action: "reply", label: t`Reply` },
    { action: "archive", label: t`Archive` },
  ] as const;
  const help = shortcut("help");
  // Only an installed app can register for email links; a development build hides the offer.
  const offerDefault = isDesktop() && defaultApp.status?.available === true;
  return (
    <Dialog
      aria-label={t`You're set`}
      onClose={onClose}
      initialFocus={done}
      className="w-[min(380px,calc(100vw-48px))] p-6"
    >
      <h2 className="text-headline font-semibold">
        <Trans>You're set</Trans>
      </h2>
      <p className="mt-1.5 text-a11y-muted">
        <Trans>Your mail is syncing. Three shortcuts to start with:</Trans>
      </p>
      <SegmentedControl
        aria-label={t`Shortcut set`}
        className="mt-3 w-full"
        value={set}
        options={SET_NAMES.map((item) => ({ value: item.value, label: i18n._(item.label) }))}
        onValueChange={(shortcutSet) =>
          setPrefs({ payload: { patch: { shortcutSet } }, reactivityKeys: [Keys.prefs] })
        }
      />
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
        {keys.map(({ action, label }) => (
          <div key={action} className="contents">
            <dt>{label}</dt>
            <dd>
              <kbd className="rounded-item bg-fill-quiet px-1.5 py-px font-sans text-footnote tabular-nums">
                {shortcut(action)}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-footnote text-a11y-muted">
        <Trans>Press {help} for all shortcuts.</Trans>
      </p>
      {(offerDefault || onAiAccess) && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-separator pt-4">
          {offerDefault && (
            <button
              type="button"
              className={buttonSecondary}
              disabled={defaultApp.busy || defaultApp.isDefault}
              onClick={defaultApp.become}
            >
              {defaultApp.isDefault ? (
                <Trans>OpenMail is the default email app</Trans>
              ) : (
                <Trans>Make OpenMail default</Trans>
              )}
            </button>
          )}
          {onAiAccess && (
            <button type="button" className={buttonSecondary} onClick={onAiAccess}>
              <Trans>Open AI Access</Trans>
            </button>
          )}
          {defaultApp.failed && (
            <output role="alert" className="block basis-full text-footnote text-a11y-danger">
              <Trans>Couldn't register OpenMail. Try again from the installed app.</Trans>
            </output>
          )}
        </div>
      )}
      <div className="mt-5 flex justify-end">
        <button ref={done} type="button" className={buttonPrimary} onClick={onClose}>
          <Trans>Done</Trans>
        </button>
      </div>
    </Dialog>
  );
}
