import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  DEFAULT_PREFS,
  SWIPE_ACTIONS,
  TOOLBAR_ACTIONS,
  type PrefsPatch,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { prefsAtom } from "../../../state/queries";
import { setPrefsAtom } from "../../../state/mutations";
import { Keys } from "../../../state/keys";
import { moveToolbarAction } from "./toolbar-order";
import { Select } from "../../../ui/Select";
import { Checkbox } from "../../../ui/Checkbox";
import { IndexingSettings } from "./IndexingSettings";
import { SettingsCheckRow, SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import { buttonSecondary } from "../../../ui/styles";

import { actionNames } from "../../../i18n/action-names";
import { canCall, isDesktop } from "../../../lib/platform";

function usePreferences() {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const set = useAtomSet(setPrefsAtom);
  return {
    prefs,
    save: (patch: PrefsPatch) => set({ payload: { patch }, reactivityKeys: [Keys.prefs] }),
  };
}
export function LabsSettings() {
  const { prefs, save } = usePreferences();
  const { t } = useLingui();
  return (
    <>
      <SettingsGroup footer={<Trans>Experimental features can be enabled separately.</Trans>}>
        {(
          [
            { key: "markdown", label: t`Markdown composition` },
            { key: "calendarDetection", label: t`Detect calendar events in messages` },
          ] as const
        ).map(({ key, label }) => (
          <SettingsCheckRow key={key}>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={prefs.labs[key]}
                onCheckedChange={(enabled) => save({ labs: { ...prefs.labs, [key]: enabled } })}
              />
              {label}
            </label>
          </SettingsCheckRow>
        ))}
      </SettingsGroup>
      {/* The models and the index live on the Mac; the remote server refuses these switches. */}
      {canCall("SetModelsEnabled") && canCall("SetIndexingPaused") && <IndexingSettings />}
    </>
  );
}
export function InteractionSettings() {
  const { prefs, save } = usePreferences();
  const { t, i18n } = useLingui();
  const actions = prefs.toolbarActions;
  return (
    <>
      {/* Swipes come from a trackpad's two-finger scroll; a phone browser has none. */}
      {isDesktop() && (
        <SettingsGroup
          title={<Trans>Swipe actions</Trans>}
          footer={
            <Trans>
              Swipe horizontally with two fingers. Release after a short or long swipe to apply the
              action.
            </Trans>
          }
        >
          {(
            [
              { key: "leftShort", label: t`Left short swipe` },
              { key: "leftLong", label: t`Left long swipe` },
              { key: "rightShort", label: t`Right short swipe` },
              { key: "rightLong", label: t`Right long swipe` },
            ] as const
          ).map(({ key, label }) => (
            <SettingsRow key={key} label={label} htmlFor={`swipe-action-${key}`}>
              <Select
                id={`swipe-action-${key}`}
                aria-label={label}
                variant="field"
                className="min-w-40"
                value={prefs.swipeActions[key]}
                options={SWIPE_ACTIONS.map((value) => ({
                  value,
                  label: i18n._(actionNames[value]),
                }))}
                onValueChange={(value) =>
                  save({ swipeActions: { ...prefs.swipeActions, [key]: value } })
                }
              />
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
      <SettingsGroup
        title={<Trans>Toolbar actions</Trans>}
        footer={<Trans>Choose actions and use the buttons to change their order.</Trans>}
      >
        <ol className="divide-y divide-separator">
          {[...actions, ...TOOLBAR_ACTIONS.filter((action) => !actions.includes(action))].map(
            (action) => {
              const index = actions.indexOf(action),
                label = i18n._(actionNames[action]);
              return (
                <li key={action} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
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
                    className={buttonSecondary}
                    aria-label={t`Move ${label} up`}
                    disabled={index <= 0}
                    onClick={() => save({ toolbarActions: moveToolbarAction(actions, action, -1) })}
                  >
                    <Trans>Move up</Trans>
                  </button>
                  <button
                    type="button"
                    className={buttonSecondary}
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
        <div className="flex justify-end px-3 py-2">
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => save({ toolbarActions: DEFAULT_PREFS.toolbarActions })}
          >
            <Trans>Reset toolbar</Trans>
          </button>
        </div>
      </SettingsGroup>
    </>
  );
}
