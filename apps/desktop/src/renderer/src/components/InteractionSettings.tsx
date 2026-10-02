import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { DEFAULT_PREFS, SWIPE_ACTIONS, TOOLBAR_ACTIONS, type Prefs } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { prefsAtom } from "../state/queries";
import { setPrefsAtom } from "../state/mutations";
import { Keys } from "../state/keys";
import { moveToolbarAction } from "../toolbar-order";
import { Select } from "./ui/Select";
import { Checkbox } from "./ui/Checkbox";
import { IndexingSettings } from "./IndexingSettings";

export const actionNames = {
  none: msg`None`,
  archive: msg`Archive`,
  trash: msg`Delete`,
  spam: msg`Report spam`,
  snooze: msg`Snooze`,
  filter: msg`Create filter from these messages`,
  read: msg`Mark read/unread`,
  star: msg`Star`,
  important: msg`Important`,
  move: msg`Move To`,
  label: msg`Labels`,
  removeLabel: msg`Remove Current Label`,
  sendAgain: msg`Send Again`,
  reply: msg`Reply`,
  replyAll: msg`Reply all`,
  forward: msg`Forward`,
  forwardAttachment: msg`Forward as attachment`,
  openWindow: msg`Open in New Window`,
};
function usePreferences() {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const set = useAtomSet(setPrefsAtom);
  return {
    prefs,
    save: (patch: Partial<Prefs>) => set({ payload: { patch }, reactivityKeys: [Keys.prefs] }),
  };
}
export function LabsSettings() {
  const { prefs, save } = usePreferences();
  const { t } = useLingui();
  return (
    <div className="space-y-4">
      <p className="text-a11y-muted">
        <Trans>Experimental features can be enabled separately.</Trans>
      </p>
      {(
        [
          { key: "markdown", label: t`Markdown composition` },
          { key: "calendarDetection", label: t`Detect calendar events in messages` },
        ] as const
      ).map(({ key, label }) => (
        <label key={key} className="flex items-center gap-2">
          <Checkbox
            checked={prefs.labs[key]}
            onCheckedChange={(enabled) => save({ labs: { ...prefs.labs, [key]: enabled } })}
          />
          {label}
        </label>
      ))}
      <IndexingSettings />
    </div>
  );
}
export function InteractionSettings() {
  const { prefs, save } = usePreferences();
  const { t, i18n } = useLingui();
  const actions = prefs.toolbarActions;
  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="font-semibold">
          <Trans>Swipe actions</Trans>
        </h3>
        <p className="text-a11y-muted">
          <Trans>
            Swipe horizontally with two fingers. Release after a short or long swipe to apply the
            action.
          </Trans>
        </p>
        {(
          [
            { key: "leftShort", label: t`Left short swipe` },
            { key: "leftLong", label: t`Left long swipe` },
            { key: "rightShort", label: t`Right short swipe` },
            { key: "rightLong", label: t`Right long swipe` },
          ] as const
        ).map(({ key, label }) => (
          <label key={key} className="flex items-center justify-between gap-3">
            <span>{label}</span>
            <Select
              aria-label={label}
              value={prefs.swipeActions[key]}
              options={SWIPE_ACTIONS.map((value) => ({ value, label: i18n._(actionNames[value]) }))}
              onValueChange={(value) =>
                save({ swipeActions: { ...prefs.swipeActions, [key]: value } })
              }
            />
          </label>
        ))}
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">
          <Trans>Toolbar actions</Trans>
        </h3>
        <p className="text-a11y-muted">
          <Trans>Choose actions and use the buttons to change their order.</Trans>
        </p>
        <ol className="space-y-2">
          {[...actions, ...TOOLBAR_ACTIONS.filter((action) => !actions.includes(action))].map(
            (action) => {
              const index = actions.indexOf(action),
                label = i18n._(actionNames[action]);
              return (
                <li key={action} className="flex items-center gap-2">
                  <label className="flex flex-1 items-center gap-2">
                    <Checkbox
                      checked={index >= 0}
                      onCheckedChange={(enabled) =>
                        save({
                          toolbarActions: enabled
                            ? [...actions, action]
                            : actions.filter((a) => a !== action),
                        })
                      }
                    />
                    {label}
                  </label>
                  <button
                    type="button"
                    className="rounded border px-2 py-1 disabled:opacity-40"
                    aria-label={t`Move ${label} up`}
                    disabled={index <= 0}
                    onClick={() => save({ toolbarActions: moveToolbarAction(actions, action, -1) })}
                  >
                    <Trans>Move up</Trans>
                  </button>
                  <button
                    type="button"
                    className="rounded border px-2 py-1 disabled:opacity-40"
                    aria-label={t`Move ${label} down`}
                    disabled={index < 0 || index === actions.length - 1}
                    onClick={() => save({ toolbarActions: moveToolbarAction(actions, action, 1) })}
                  >
                    <Trans>Move down</Trans>
                  </button>
                </li>
              );
            },
          )}
        </ol>
        <button
          type="button"
          className="rounded border px-2 py-1"
          onClick={() => save({ toolbarActions: DEFAULT_PREFS.toolbarActions })}
        >
          <Trans>Reset toolbar</Trans>
        </button>
      </section>
    </div>
  );
}
