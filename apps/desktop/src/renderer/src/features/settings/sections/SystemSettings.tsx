import type { NotificationPermission } from "../../../../../shared/desktop";
import {
  SettingsCheckRow,
  SettingsGroup,
  SettingsRow,
  SettingsSwitchRow,
} from "../../../ui/SettingsRows";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { DateInput } from "../../../ui/DateInput";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  DEFAULT_ACTIVE_HOURS,
  DEFAULT_PREFS,
  WEEKDAYS,
  type ActiveWindow,
  type Weekday,
  providerCapabilities,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import type { Account, PrefsPatch } from "../../../../../shared/api";
import {
  KEYMAP,
  NUMBERED_MAILBOXES,
  isShortcutAction,
  shortcutText,
  type ShortcutSet,
} from "../../../../../shared/shortcuts";
import { MAILBOX_NAMES } from "../../../lib/view";
import { Keys } from "../../../state/keys";
import { useRunMail, withMail } from "../../../state/mail";
import { useDefaultMailClient } from "../use-default-mail-client";
import { SET_NAMES } from "../../../i18n/shortcut-set-names";
import { setPrefsAtom } from "../../../state/mutations";
import { ACTION_NAMES } from "../../../i18n/shortcut-names";
import {
  matchesShortcutFilter,
  SHORTCUT_GROUP,
  SHORTCUT_GROUP_NAMES,
  SHORTCUT_GROUPS,
  type ShortcutGroup,
} from "../../../i18n/shortcut-groups";
import { prefsAtom, profilesAtom } from "../../../state/queries";
import { Checkbox } from "../../../ui/Checkbox";
import { Dialog, alertButton } from "../../../ui/Dialog";
import {
  buttonLink,
  buttonPrimary,
  buttonSecondary,
  formInput,
  settingsGroup,
  settingsHeading,
  settingsHint,
} from "../../../ui/styles";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { Select } from "../../../ui/Select";

export function DefaultMailClient() {
  const { status, isDefault, busy, failed, become } = useDefaultMailClient();
  return (
    <SettingsRow
      label={<Trans>Default email app</Trans>}
      hint={
        <>
          <Trans>Open email links in a new OpenMail draft.</Trans>
          {status && !status.available && (
            <>
              {" "}
              <Trans>
                Install the packaged app to make it the default. Development builds cannot register
                email links.
              </Trans>
            </>
          )}
          {failed && (
            <output role="alert" className="mt-1 block text-orange-700 dark:text-orange-400">
              <Trans>Couldn't register OpenMail. Try again from the installed app.</Trans>
            </output>
          )}
        </>
      }
    >
      <Button
        className={alertButton}
        disabled={busy || isDefault || !status?.available}
        onClick={become}
      >
        {isDefault ? (
          <Trans>OpenMail is the default email app</Trans>
        ) : (
          <Trans>Make OpenMail default</Trans>
        )}
      </Button>
    </SettingsRow>
  );
}

const timeText = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const timeMinute = (value: string) =>
  /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;

/** "Remove period": quieter than the accent link beside it. */
const quietLink =
  "rounded-item text-footnote text-a11y-muted outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2";
const WEEKDAY_NAMES: Record<Weekday, MessageDescriptor> = {
  sunday: msg`Sunday`,
  monday: msg`Monday`,
  tuesday: msg`Tuesday`,
  wednesday: msg`Wednesday`,
  thursday: msg`Thursday`,
  friday: msg`Friday`,
  saturday: msg`Saturday`,
};

const PERMISSION_NAMES: Record<NotificationPermission, MessageDescriptor> = {
  notDetermined: msg`Not requested`,
  denied: msg`Denied`,
  authorized: msg`Allowed`,
  provisional: msg`Allowed quietly`,
  ephemeral: msg`Allowed temporarily`,
  unknown: msg`Couldn't read system permission`,
  unavailable: msg`Available in the installed macOS app`,
  unsupported: msg`Unsupported on this platform`,
};
const NOTIFICATION_ACTIONS = [
  { value: "archive", label: msg`Archive` },
  { value: "trash", label: msg`Trash` },
  { value: "read", label: msg`Mark read` },
  { value: "menu", label: msg`Action menu` },
] as const;

export function NotificationsSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const profiles = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const setPrefs = useAtomSet(setPrefsAtom);
  const run = useRunMail();
  const [capabilities, setCapabilities] = useState({ buttons: false, selection: false });
  const [permission, setPermission] = useState<NotificationPermission>("unknown");
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [settingsFailed, setSettingsFailed] = useState(false);
  useEffect(() => {
    run(
      withMail((call) => call("NotificationActionCapabilities", undefined)).pipe(
        Effect.tap((value) => Effect.sync(() => setCapabilities(value))),
      ),
    );
    const refresh = () =>
      run(
        withMail((call) => call("NotificationPermission", undefined)).pipe(
          Effect.tap((value) => Effect.sync(() => setPermission(value))),
        ),
      );
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [run]);
  const save = (patch: PrefsPatch) =>
    setPrefs({ payload: { patch }, reactivityKeys: [Keys.prefs] });
  return (
    <>
      <SettingsGroup title={<Trans>System notification permission</Trans>}>
        <SettingsRow
          label={<output aria-live="polite">{t(PERMISSION_NAMES[permission])}</output>}
          hint={
            settingsFailed && (
              <output role="alert" className="text-orange-700 dark:text-orange-400">
                <Trans>Couldn't open notification settings.</Trans>
              </output>
            )
          }
        >
          <Button
            disabled={permissionBusy || permission !== "notDetermined"}
            onClick={() => {
              setPermissionBusy(true);
              run(
                withMail((call) => call("RequestNotificationPermission", undefined)).pipe(
                  Effect.tap((value) => Effect.sync(() => setPermission(value))),
                  Effect.ensuring(Effect.sync(() => setPermissionBusy(false))),
                ),
              );
            }}
            className={buttonSecondary}
          >
            <Trans>Allow notifications</Trans>
          </Button>
          <Button
            onClick={() =>
              run(
                withMail((call) => call("OpenNotificationSettings", undefined)).pipe(
                  Effect.tap((opened) => Effect.sync(() => setSettingsFailed(!opened))),
                ),
              )
            }
            className={buttonSecondary}
          >
            <Trans>Open macOS notification settings</Trans>
          </Button>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title={<Trans>Notification action buttons</Trans>}
        footer={
          capabilities.buttons &&
          (capabilities.selection ? (
            <Trans>
              Up to three actions, in selection order. The action menu includes Archive, Trash and
              Mark read. Changes apply to new notifications.
            </Trans>
          ) : (
            <Trans>
              Up to three buttons, in selection order. All actions adds Archive, Trash and Mark read
              buttons. Changes apply to new notifications.
            </Trans>
          ))
        }
      >
        {capabilities.buttons ? (
          NOTIFICATION_ACTIONS.map(({ value, label }) => (
            <SettingsCheckRow key={value}>
              <label htmlFor={`notification-action-${value}`} className="flex items-center gap-2">
                <Checkbox
                  id={`notification-action-${value}`}
                  checked={prefs.notificationActions.includes(value)}
                  onCheckedChange={(checked) =>
                    save({
                      notificationActions: checked
                        ? [
                            ...prefs.notificationActions.filter((action) => action !== value),
                            value,
                          ].slice(-3)
                        : prefs.notificationActions.filter((action) => action !== value),
                    })
                  }
                />
                {value === "menu" && !capabilities.selection ? (
                  <Trans>All actions</Trans>
                ) : (
                  t(label)
                )}
              </label>
            </SettingsCheckRow>
          ))
        ) : (
          <p className={`px-3 py-2.5 ${settingsHint}`}>
            <Trans>Notification actions are available on macOS and Windows.</Trans>
          </p>
        )}
      </SettingsGroup>
      <SettingsGroup
        title={<Trans>New mail notifications</Trans>}
        footer={
          <Trans>
            Primary excludes Gmail's other categories and includes only Outlook Focused mail. For
            IMAP, it includes all Inbox mail. Read mail and the first sync stay silent.
          </Trans>
        }
      >
        {accounts.map((account) => (
          <SettingsRow
            key={account.id}
            label={
              <span className="block truncate">{account.description?.trim() || account.email}</span>
            }
          >
            <Select
              aria-label={t`Notifications for ${account.email}`}
              variant="field"
              className="min-w-32"
              value={prefs.notifications[account.id] ?? "primary"}
              options={[
                {
                  value: "primary",
                  label:
                    providerCapabilities(account.provider).inboxTabs === "focused"
                      ? t`Focused`
                      : t`Primary`,
                },
                { value: "inbox", label: t`Inbox` },
                { value: "off", label: t`Off` },
              ]}
              onValueChange={(mode) =>
                save({ notifications: { ...prefs.notifications, [account.id]: mode } })
              }
            />
          </SettingsRow>
        ))}
      </SettingsGroup>
      <SettingsGroup>
        <SettingsSwitchRow
          label={<Trans>Show unread count in the menu bar</Trans>}
          hint={<Trans>The menu lists up to 50 unread messages in the current space.</Trans>}
          checked={prefs.menuBarUnreadCount}
          onCheckedChange={(menuBarUnreadCount) => save({ menuBarUnreadCount })}
        />
      </SettingsGroup>
      <section>
        <h3 className={settingsHeading}>
          <Trans>Active hours by space</Trans>
        </h3>
        <p className={`mb-2 px-1 ${settingsHint}`}>
          <Trans>
            Times follow this Mac's time zone. Outside a space's active hours, OpenMail holds its
            notifications and leaves its unread mail out of the Dock badge. When active hours start
            again, you get one summary of the unread mail that arrived.
          </Trans>
        </p>
        <div className={settingsGroup}>
          {[{ id: "all", name: t`Ungrouped accounts` }, ...profiles].map((profile) => {
            const hours = prefs.activeHours[profile.id] ?? DEFAULT_ACTIVE_HOURS;
            const update = (patch: Partial<typeof hours>) =>
              save({ activeHours: { ...prefs.activeHours, [profile.id]: { ...hours, ...patch } } });
            const updateDay = (day: Weekday, windows: readonly ActiveWindow[]) =>
              update({ days: { ...hours.days, [day]: windows } });
            const legacy = !prefs.activeHours[profile.id] && prefs.quietHours[profile.id]?.enabled;
            return (
              <div key={profile.id} className="space-y-2 px-3 py-2.5">
                <label className="flex items-center gap-2 font-medium">
                  <Checkbox
                    checked={hours.enabled}
                    onCheckedChange={(enabled) => update({ enabled })}
                  />
                  {profile.name}
                </label>
                {legacy && (
                  <p className={`pl-[22px] ${settingsHint}`}>
                    <Trans>
                      A previous daily quiet-hours setting is still active. Change this schedule to
                      replace it.
                    </Trans>
                  </p>
                )}
                {hours.enabled && (
                  <div className="space-y-1.5 pl-[22px]">
                    {WEEKDAYS.map((day) => {
                      const windows = hours.days[day];
                      const dayName = t(WEEKDAY_NAMES[day]);
                      return (
                        <div key={day} className="flex flex-wrap items-start gap-x-4 gap-y-1">
                          <label className="flex h-7 w-28 shrink-0 items-center gap-2">
                            <Checkbox
                              checked={windows.length > 0}
                              onCheckedChange={(enabled) =>
                                updateDay(day, enabled ? [{ start: 540, end: 1020 }] : [])
                              }
                            />
                            {dayName}
                          </label>
                          {windows.length > 0 && (
                            <div className="min-w-0 flex-1 space-y-1">
                              {windows.map((window, index) => {
                                const change = (patch: Partial<ActiveWindow>) =>
                                  updateDay(
                                    day,
                                    windows.map((current, i) =>
                                      i === index ? { ...current, ...patch } : current,
                                    ),
                                  );
                                return (
                                  <div
                                    key={index}
                                    className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1"
                                  >
                                    <label
                                      htmlFor={`active-start-${profile.id}-${day}-${index}`}
                                      className="flex items-center gap-1.5"
                                    >
                                      <Trans>Start</Trans>
                                      <DateInput
                                        id={`active-start-${profile.id}-${day}-${index}`}
                                        aria-label={t`Active hours start for ${profile.name} on ${dayName}, period ${index + 1}`}
                                        type="time"
                                        variant="compact"
                                        value={timeText(window.start)}
                                        onValueChange={(value) => {
                                          const start = timeMinute(value);
                                          if (start !== null) change({ start });
                                        }}
                                      />
                                    </label>
                                    <label
                                      htmlFor={`active-end-${profile.id}-${day}-${index}`}
                                      className="flex items-center gap-1.5"
                                    >
                                      <Trans>Until</Trans>
                                      <DateInput
                                        id={`active-end-${profile.id}-${day}-${index}`}
                                        aria-label={t`Active hours end for ${profile.name} on ${dayName}, period ${index + 1}`}
                                        type="time"
                                        variant="compact"
                                        value={timeText(window.end)}
                                        onValueChange={(value) => {
                                          const end = timeMinute(value);
                                          if (end !== null) change({ end });
                                        }}
                                      />
                                    </label>
                                    <Button
                                      onClick={() =>
                                        updateDay(
                                          day,
                                          windows.filter((_, i) => i !== index),
                                        )
                                      }
                                      className={quietLink}
                                    >
                                      <Trans>Remove period</Trans>
                                    </Button>
                                  </div>
                                );
                              })}
                              <Button
                                onClick={() =>
                                  updateDay(day, [...windows, { start: 540, end: 1020 }])
                                }
                                className={`text-footnote ${buttonLink}`}
                              >
                                <Trans>Add period</Trans>
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className={`mt-1.5 px-1 ${settingsHint}`}>
          <Trans>
            Matching times keep that weekday active all day. Overnight periods continue into the
            next day. Unchecked days stay muted except for overnight periods from the previous day.
            Repeated daylight-saving times use the same schedule; skipped times are passed over.
          </Trans>
        </p>
      </section>
    </>
  );
}

const ACTIONS = Object.entries(ACTION_NAMES);
/** Keys drawn as a small key cap: the system font, so ⌘ and ⌥ match the menu bar. */
const keyCap =
  "rounded-item bg-fill-quiet px-1.5 py-px font-sans text-footnote whitespace-nowrap text-neutral-700 tabular-nums dark:text-neutral-300";
const shortcutRow = "px-3 py-1.5";
const shortcutKeys = "px-3 py-1.5 text-right";

interface ShortcutRow {
  id: string;
  group: ShortcutGroup;
  label: string;
  keys: string;
}

/** Forward Delete, typed as Fn-Delete on a Mac keyboard without the key; see removesSuggestion. */
const SUGGESTION_REMOVAL_KEYS = "⌦ / fn⌫";

const navigation = (id: string, label: string, keys: string): ShortcutRow => ({
  id,
  group: "navigation",
  label,
  keys,
});

/** Every shortcut of the set as a row with its section, label and keys. */
function useShortcutRows(set: ShortcutSet): ShortcutRow[] {
  const { t, i18n } = useLingui();
  const rows: ShortcutRow[] = ACTIONS.flatMap(([action, label]) =>
    // Actions without a key in this set, such as Gmail's X in the Mimestream set, are left out.
    isShortcutAction(action) && KEYMAP[set][action].length > 0
      ? [
          {
            id: action,
            group: SHORTCUT_GROUP[action],
            label: i18n._(label),
            keys: shortcutText(set, action),
          },
        ]
      : [],
  );
  return [
    ...rows,
    ...NUMBERED_MAILBOXES.map((mailbox, index) =>
      navigation(
        `mailbox-${mailbox}`,
        i18n._(MAILBOX_NAMES[mailbox]),
        `${set === "gmail" ? "⌃⌘" : "⌘"}${index + 1}`,
      ),
    ),
    navigation("favorites", t`Favorites in sidebar order`, "⌥⌘1…9"),
    navigation(
      "views",
      t({
        message: "Previous / next view",
        comment:
          "Keyboard shortcuts help: go back or forward through the views opened in this window, like a browser's Back and Forward.",
      }),
      "⌘[ / ⌘]",
    ),
    navigation("panes", t`Move focus between panes`, "← / →"),
    navigation(
      "list-ends",
      t({
        message: "First / last message in the list",
        comment: "Keyboard shortcuts help: Home and End select the first or last loaded message.",
      }),
      "Home / End",
    ),
    navigation(
      "list-pages",
      t({
        message: "A page up / down in the list",
        comment:
          "Keyboard shortcuts help: Page Up and Page Down move the selection by one screen of messages.",
      }),
      "Page Up / Page Down",
    ),
    navigation("spaces", t`Switch spaces`, set === "gmail" ? "⌘1…9" : "⌃⌘1…9"),
    navigation(
      "remove-recent-search",
      t({
        message: "Remove the highlighted recent search",
        comment:
          "Keyboard shortcuts help: in the search field, removes the highlighted recent search.",
      }),
      SUGGESTION_REMOVAL_KEYS,
    ),
    {
      id: "stop-suggesting",
      group: "compose",
      label: t({
        message: "Stop suggesting the highlighted address",
        comment:
          "Keyboard shortcuts help: in a To, Cc or Bcc field, hides the highlighted address from suggestions.",
      }),
      keys: SUGGESTION_REMOVAL_KEYS,
    },
  ];
}

/**
 * The shortcuts of a set in sections, Triage first, with a filter field that matches a name or
 * a key such as "⌘R".
 */
function ShortcutTable({ set }: { set: ShortcutSet }) {
  const { t, i18n } = useLingui();
  const [filter, setFilter] = useState("");
  const rows = useShortcutRows(set).filter((row) =>
    matchesShortcutFilter(filter, row.label, row.keys),
  );
  return (
    <div className="space-y-4">
      <Input
        type="search"
        value={filter}
        onValueChange={setFilter}
        aria-label={t`Filter shortcuts`}
        placeholder={t`Filter shortcuts`}
        className={`w-full ${formInput}`}
      />
      {rows.length === 0 && (
        <output className={`block px-1 ${settingsHint}`}>
          <Trans>No shortcuts match.</Trans>
        </output>
      )}
      {SHORTCUT_GROUPS.map((group) => {
        const groupRows = rows.filter((row) => row.group === group);
        if (groupRows.length === 0) return null;
        const name = i18n._(SHORTCUT_GROUP_NAMES[group]);
        return (
          <section key={group} aria-label={name}>
            <h3 className={settingsHeading}>{name}</h3>
            <div className={`overflow-hidden ${settingsGroup}`}>
              <table className="w-full text-left">
                <tbody className="divide-y divide-separator">
                  {groupRows.map((row) => (
                    <tr key={row.id}>
                      <td className={shortcutRow}>{row.label}</td>
                      <td className={shortcutKeys}>
                        <kbd className={keyCap}>{row.keys}</kbd>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
export function ShortcutsSettings() {
  const { t, i18n } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <>
      <div className="space-y-2">
        <SegmentedControl
          aria-label={t`Shortcut set`}
          value={prefs.shortcutSet}
          options={SET_NAMES.map((item) => ({ value: item.value, label: i18n._(item.label) }))}
          onValueChange={(shortcutSet) =>
            setPrefs({ payload: { patch: { shortcutSet } }, reactivityKeys: [Keys.prefs] })
          }
        />
        <p className={`px-1 ${settingsHint}`}>
          <Trans>Press ? outside a text field to show this list.</Trans>
        </p>
      </div>
      <ShortcutTable set={prefs.shortcutSet} />
    </>
  );
}
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  return (
    <Dialog
      aria-label={t`Keyboard shortcuts`}
      onClose={onClose}
      maxHeight="640px"
      className="flex w-[min(520px,calc(100vw-48px))] flex-col overflow-hidden"
    >
      <h2 className="shrink-0 px-5 pt-4 pb-3 text-headline font-semibold">
        <Trans>Keyboard shortcuts</Trans>
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        <ShortcutTable set={prefs.shortcutSet} />
      </div>
      <div className="flex shrink-0 justify-end border-t border-separator px-5 py-3">
        <Button className={buttonPrimary} onClick={onClose}>
          <Trans>Done</Trans>
        </Button>
      </div>
    </Dialog>
  );
}
