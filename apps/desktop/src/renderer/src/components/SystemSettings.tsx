import type { NotificationPermission, DefaultClientStatus } from "../../../shared/desktop";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  DEFAULT_ACTIVE_HOURS,
  DEFAULT_PREFS,
  WEEKDAYS,
  type ActiveWindow,
  type Weekday,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import type { Account, Prefs } from "../../../shared/api";
import {
  NUMBERED_MAILBOXES,
  isShortcutAction,
  shortcutText,
  type ShortcutSet,
} from "../../../shared/shortcuts";
import { MAILBOX_NAMES } from "../view";
import { Keys } from "../state/keys";
import { useRunMail, withMail } from "../state/mail";
import { setPrefsAtom } from "../state/mutations";
import { ACTION_NAMES } from "../shortcut-names";
import { prefsAtom, profilesAtom } from "../state/queries";
import { Checkbox } from "./ui/Checkbox";
import { Dialog, alertButton } from "./ui/Dialog";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";

export function DefaultMailClient() {
  const run = useRunMail();
  const [status, setStatus] = useState<DefaultClientStatus | null>(null);
  const isDefault = status?.isDefault ?? false;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    run(
      withMail((call) => call("DefaultMailClient", undefined)).pipe(
        Effect.tap((value) => Effect.sync(() => setStatus(value))),
      ),
    );
  }, [run]);
  return (
    <section className="mt-6 space-y-2">
      <h3 className="text-[12px] font-semibold text-a11y-muted">
        <Trans>Default email app</Trans>
      </h3>
      <p className="text-a11y-muted">
        <Trans>Open email links in a new OpenMail draft.</Trans>
      </p>
      {status && !status.available && (
        <p className="text-a11y-muted">
          <Trans>
            Install the packaged app to make it the default. Development builds cannot register
            email links.
          </Trans>
        </p>
      )}
      <Button
        className={alertButton}
        disabled={busy || isDefault || !status?.available}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          run(
            withMail((call) => call("BecomeDefaultMailClient", undefined)).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  setStatus((current) => current && { ...current, isDefault: value });
                  setFailed(!value);
                }),
              ),
              Effect.ensuring(Effect.sync(() => setBusy(false))),
            ),
          );
        }}
      >
        {isDefault ? (
          <Trans>OpenMail is the default email app</Trans>
        ) : (
          <Trans>Make OpenMail default</Trans>
        )}
      </Button>
      {failed && (
        <output role="alert" className="text-orange-700 dark:text-orange-400">
          <Trans>Could not register OpenMail. Try again from the installed app.</Trans>
        </output>
      )}
    </section>
  );
}

const timeText = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const timeMinute = (value: string) =>
  /^\d{2}:\d{2}$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;

const timeInput = "rounded border border-black/10 bg-transparent px-2 py-1 dark:border-white/15";
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
  unknown: msg`Could not read system permission`,
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
  const save = (patch: Partial<Prefs>) =>
    setPrefs({ payload: { patch }, reactivityKeys: [Keys.prefs] });
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="font-semibold">
          <Trans>System notification permission</Trans>
        </h3>
        <output aria-live="polite">{t(PERMISSION_NAMES[permission])}</output>
        <div className="flex gap-3">
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
            className={alertButton}
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
            className={alertButton}
          >
            <Trans>Open macOS notification settings</Trans>
          </Button>
        </div>
        {settingsFailed && (
          <output role="alert" className="text-orange-700 dark:text-orange-400">
            <Trans>Could not open notification settings.</Trans>
          </output>
        )}
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">
          <Trans>Notification action buttons</Trans>
        </h3>
        {capabilities.buttons &&
          NOTIFICATION_ACTIONS.map(({ value, label }) => (
            <label
              key={value}
              htmlFor={`notification-action-${value}`}
              className="flex items-center gap-2"
            >
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
              {value === "menu" && !capabilities.selection ? <Trans>All actions</Trans> : t(label)}
            </label>
          ))}
        <p className="text-a11y-muted">
          {capabilities.buttons ? (
            capabilities.selection ? (
              <Trans>
                Up to three actions, in selection order. The action menu includes Archive, Trash and
                Mark read. Changes apply to new notifications.
              </Trans>
            ) : (
              <Trans>
                Up to three buttons, in selection order. All actions adds Archive, Trash and Mark
                read buttons. Changes apply to new notifications.
              </Trans>
            )
          ) : (
            <Trans>Notification actions are available on macOS and Windows.</Trans>
          )}
        </p>
      </section>
      <section>
        <h3 className="mb-3 font-semibold">
          <Trans>New mail notifications</Trans>
        </h3>
        <div className="space-y-3">
          {accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-4">
              <span className="truncate">{account.description?.trim() || account.email}</span>
              <Select
                aria-label={t`Notifications for ${account.email}`}
                value={prefs.notifications[account.id] ?? "primary"}
                options={[
                  {
                    value: "primary",
                    label: account.provider === "outlook" ? t`Focused` : t`Primary`,
                  },
                  { value: "inbox", label: t`Inbox` },
                  { value: "off", label: t`Off` },
                ]}
                onValueChange={(mode) =>
                  save({ notifications: { ...prefs.notifications, [account.id]: mode } })
                }
              />
            </div>
          ))}
        </div>
        <p className="mt-3 text-a11y-muted">
          <Trans>
            Primary excludes Gmail's other categories and includes only Outlook Focused mail. For
            IMAP, it includes all Inbox mail. Read mail and the first sync stay silent.
          </Trans>
        </p>
      </section>
      <section>
        <label htmlFor="menu-bar-unread-count" className="flex items-center gap-2">
          <Checkbox
            id="menu-bar-unread-count"
            checked={prefs.menuBarUnreadCount}
            onCheckedChange={(menuBarUnreadCount) => save({ menuBarUnreadCount })}
          />
          <Trans>Show unread count in the menu bar</Trans>
        </label>
        <p className="mt-2 text-a11y-muted">
          <Trans>The menu lists up to 50 unread messages in the current space.</Trans>
        </p>
      </section>
      <section>
        <h3 className="mb-3 font-semibold">
          <Trans>Active hours by space</Trans>
        </h3>
        <p className="mb-3 text-a11y-muted">
          <Trans>
            Use this Mac's local time. Outside active hours, notifications wait and the Dock badge
            excludes the space. When active hours resume, unread arrivals appear in one summary.
          </Trans>
        </p>
        <div className="space-y-5">
          {[{ id: "all", name: t`Ungrouped accounts` }, ...profiles].map((profile) => {
            const hours = prefs.activeHours[profile.id] ?? DEFAULT_ACTIVE_HOURS;
            const update = (patch: Partial<typeof hours>) =>
              save({ activeHours: { ...prefs.activeHours, [profile.id]: { ...hours, ...patch } } });
            const updateDay = (day: Weekday, windows: readonly ActiveWindow[]) =>
              update({ days: { ...hours.days, [day]: windows } });
            const legacy = !prefs.activeHours[profile.id] && prefs.quietHours[profile.id]?.enabled;
            return (
              <div key={profile.id}>
                <label className="mb-2 flex items-center gap-2 font-medium">
                  <Checkbox
                    checked={hours.enabled}
                    onCheckedChange={(enabled) => update({ enabled })}
                  />
                  {profile.name}
                </label>
                {legacy && (
                  <p className="mb-2 text-a11y-muted">
                    <Trans>
                      A previous daily quiet-hours setting is still active. Change this schedule to
                      replace it.
                    </Trans>
                  </p>
                )}
                {hours.enabled &&
                  WEEKDAYS.map((day) => {
                    const windows = hours.days[day];
                    const dayName = t(WEEKDAY_NAMES[day]);
                    return (
                      <div key={day} className="mb-3 space-y-2">
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={windows.length > 0}
                            onCheckedChange={(enabled) =>
                              updateDay(day, enabled ? [{ start: 540, end: 1020 }] : [])
                            }
                          />
                          {dayName}
                        </label>
                        {windows.map((window, index) => {
                          const change = (patch: Partial<ActiveWindow>) =>
                            updateDay(
                              day,
                              windows.map((current, i) =>
                                i === index ? { ...current, ...patch } : current,
                              ),
                            );
                          return (
                            <div key={index} className="ml-6 flex flex-wrap items-center gap-3">
                              <label
                                htmlFor={`active-start-${profile.id}-${day}-${index}`}
                                className="flex items-center gap-2"
                              >
                                <Trans>Start</Trans>
                                <Input
                                  id={`active-start-${profile.id}-${day}-${index}`}
                                  aria-label={t`Active hours start for ${profile.name} on ${dayName}, period ${index + 1}`}
                                  type="time"
                                  value={timeText(window.start)}
                                  className={timeInput}
                                  onChange={(e) => {
                                    const start = timeMinute(e.target.value);
                                    if (start !== null) change({ start });
                                  }}
                                />
                              </label>
                              <label
                                htmlFor={`active-end-${profile.id}-${day}-${index}`}
                                className="flex items-center gap-2"
                              >
                                <Trans>Until</Trans>
                                <Input
                                  id={`active-end-${profile.id}-${day}-${index}`}
                                  aria-label={t`Active hours end for ${profile.name} on ${dayName}, period ${index + 1}`}
                                  type="time"
                                  value={timeText(window.end)}
                                  className={timeInput}
                                  onChange={(e) => {
                                    const end = timeMinute(e.target.value);
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
                                className="text-a11y-muted"
                              >
                                <Trans>Remove period</Trans>
                              </Button>
                            </div>
                          );
                        })}
                        {windows.length > 0 && (
                          <Button
                            onClick={() => updateDay(day, [...windows, { start: 540, end: 1020 }])}
                            className="ml-6 text-a11y-muted"
                          >
                            <Trans>Add period</Trans>
                          </Button>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-a11y-muted">
          <Trans>
            Matching times keep that weekday active all day. Overnight periods continue into the
            next day. Unchecked days stay muted except for overnight periods from the previous day.
            Repeated daylight-saving times use the same schedule; skipped times are passed over.
          </Trans>
        </p>
      </section>
    </div>
  );
}

const SET_NAMES: { value: ShortcutSet; label: MessageDescriptor }[] = [
  { value: "mimestream", label: msg`Mimestream` },
  { value: "gmail", label: msg`Gmail` },
  { value: "apple", label: msg`Apple Mail` },
];

const ACTIONS = Object.entries(ACTION_NAMES);
function ShortcutTable({ set }: { set: ShortcutSet }) {
  const { i18n } = useLingui();
  return (
    <table className="w-full text-left">
      <tbody>
        {ACTIONS.map(([action, label]) => {
          if (!isShortcutAction(action)) return null;
          return (
            <tr key={action} className="border-b border-black/5 dark:border-white/5">
              <td className="py-1.5">{i18n._(label)}</td>
              <td className="py-1.5 text-right">
                <kbd className="font-mono text-[12px] text-a11y-muted">
                  {shortcutText(set, action)}
                </kbd>
              </td>
            </tr>
          );
        })}
        {NUMBERED_MAILBOXES.map((mailbox, index) => (
          <tr key={mailbox} className="border-b border-black/5 dark:border-white/5">
            <td className="py-1.5">{i18n._(MAILBOX_NAMES[mailbox])}</td>
            <td className="py-1.5 text-right">
              <kbd>
                {set === "gmail" ? "⌃⌘" : "⌘"}
                {index + 1}
              </kbd>
            </td>
          </tr>
        ))}
        <tr>
          <td className="pt-3">
            <Trans>Favorites in sidebar order</Trans>
          </td>
          <td className="pt-3 text-right">
            <kbd>⌥⌘1…9</kbd>
          </td>
        </tr>
        <tr>
          <td className="pt-3">
            <Trans>Move focus between panes</Trans>
          </td>
          <td className="pt-3 text-right">
            <kbd>← / →</kbd>
          </td>
        </tr>
        <tr>
          <td className="pt-3">
            <Trans>Switch spaces</Trans>
          </td>
          <td className="pt-3 text-right">
            <kbd>{set === "gmail" ? "⌘1…9" : "⌃⌘1…9"}</kbd>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
export function ShortcutsSettings() {
  const { t, i18n } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <div>
      <SegmentedControl
        aria-label={t`Shortcut set`}
        value={prefs.shortcutSet}
        options={SET_NAMES.map((item) => ({ value: item.value, label: i18n._(item.label) }))}
        onValueChange={(shortcutSet) =>
          setPrefs({ payload: { patch: { shortcutSet } }, reactivityKeys: [Keys.prefs] })
        }
      />
      <p className="my-3 text-a11y-muted">
        <Trans>Press ? outside a text field to show this list.</Trans>
      </p>
      <ShortcutTable set={prefs.shortcutSet} />
    </div>
  );
}
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  return (
    <Dialog
      aria-label={t`Keyboard shortcuts`}
      onClose={onClose}
      className="flex max-h-[80vh] w-[520px] flex-col p-5"
    >
      <h2 className="mb-3 text-[15px] font-semibold">
        <Trans>Keyboard shortcuts</Trans>
      </h2>
      <div className="overflow-y-auto">
        <ShortcutTable set={prefs.shortcutSet} />
      </div>
      <Button className={`${alertButton} mt-4 self-end`} onClick={onClose}>
        <Trans>Done</Trans>
      </Button>
    </Dialog>
  );
}
