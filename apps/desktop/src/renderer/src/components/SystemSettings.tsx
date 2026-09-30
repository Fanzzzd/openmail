import type { DefaultClientStatus } from "../../../shared/desktop";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import type { Account, Prefs } from "../../../shared/api";
import {
  isShortcutAction,
  shortcutText,
  type ShortcutAction,
  type ShortcutSet,
} from "../../../shared/shortcuts";
import { Keys } from "../state/keys";
import { useRunMail, withMail } from "../state/mail";
import { setPrefsAtom } from "../state/mutations";
import { prefsAtom, profilesAtom } from "../state/queries";
import { Checkbox } from "./ui/Checkbox";
import { Dialog, alertButton } from "./ui/Dialog";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";

export function useShortcutText() {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  return (action: ShortcutAction) => shortcutText(prefs.shortcutSet, action);
}

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
      <h3 className="text-[12px] font-semibold text-neutral-500">
        <Trans>Default email app</Trans>
      </h3>
      <p className="text-neutral-500">
        <Trans>Open email links in a new OpenMail draft.</Trans>
      </p>
      {status && !status.available && (
        <p className="text-neutral-500">
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
        <output className="text-orange-600">
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

export function NotificationsSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const profiles = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const setPrefs = useAtomSet(setPrefsAtom);
  const save = (patch: Partial<Prefs>) =>
    setPrefs({ payload: { patch }, reactivityKeys: [Keys.prefs] });
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 font-semibold">
          <Trans>New mail notifications</Trans>
        </h3>
        <div className="space-y-3">
          {accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-4">
              <span className="truncate">{account.email}</span>
              <Select
                aria-label={t`Notifications for ${account.email}`}
                value={prefs.notifications[account.id] ?? "primary"}
                options={[
                  { value: "primary", label: t`Primary` },
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
        <p className="mt-3 text-neutral-500">
          <Trans>
            Primary excludes Gmail's other categories. For Outlook and IMAP, it includes all Inbox
            mail. Read mail and the first sync stay silent.
          </Trans>
        </p>
      </section>
      <section>
        <h3 className="mb-3 font-semibold">
          <Trans>Quiet hours by space</Trans>
        </h3>
        <p className="mb-3 text-neutral-500">
          <Trans>
            Use this Mac's local time. Notifications received during quiet hours stay silent.
          </Trans>
        </p>
        <div className="space-y-4">
          {[{ id: "all", name: t`Ungrouped accounts` }, ...profiles].map((profile) => {
            const hours = prefs.quietHours[profile.id] ?? {
              enabled: false,
              start: 22 * 60,
              end: 8 * 60,
            };
            const update = (patch: Partial<typeof hours>) =>
              save({ quietHours: { ...prefs.quietHours, [profile.id]: { ...hours, ...patch } } });
            return (
              <div key={profile.id} className="flex items-center gap-3">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <Checkbox
                    checked={hours.enabled}
                    onCheckedChange={(enabled) => update({ enabled })}
                  />
                  <span className="truncate">{profile.name}</span>
                </label>
                <label htmlFor={`quiet-start-${profile.id}`} className="flex items-center gap-2">
                  <span className="text-neutral-500">
                    <Trans>Start</Trans>
                  </span>
                  <Input
                    id={`quiet-start-${profile.id}`}
                    aria-label={t`Quiet hours start for ${profile.name}`}
                    type="time"
                    value={timeText(hours.start)}
                    disabled={!hours.enabled}
                    className="rounded border border-black/10 bg-transparent px-2 py-1 disabled:opacity-40 dark:border-white/15"
                    onChange={(e) => {
                      const start = timeMinute(e.target.value);
                      if (start !== null) update({ start });
                    }}
                  />
                </label>
                <label htmlFor={`quiet-end-${profile.id}`} className="flex items-center gap-2">
                  <span className="text-neutral-500">
                    <Trans>Until</Trans>
                  </span>
                  <Input
                    id={`quiet-end-${profile.id}`}
                    aria-label={t`Quiet hours end for ${profile.name}`}
                    type="time"
                    value={timeText(hours.end)}
                    disabled={!hours.enabled}
                    className="rounded border border-black/10 bg-transparent px-2 py-1 disabled:opacity-40 dark:border-white/15"
                    onChange={(e) => {
                      const end = timeMinute(e.target.value);
                      if (end !== null) update({ end });
                    }}
                  />
                </label>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-neutral-500">
          <Trans>Matching start and end times mute the space all day.</Trans>
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
const ACTION_NAMES: Record<ShortcutAction, MessageDescriptor> = {
  compose: msg`New message`,
  newWindow: msg`New Window`,
  settings: msg`Settings`,
  help: msg`Keyboard shortcuts`,
  reply: msg`Reply`,
  replyAll: msg`Reply all`,
  forward: msg`Forward`,
  forwardAttachment: msg`Forward as attachment`,
  archive: msg`Archive`,
  trash: msg`Delete`,
  spam: msg`Report spam`,
  search: msg`Search`,
  sync: msg`Sync now`,
  read: msg`Mark read/unread`,
  star: msg`Star`,
  important: msg`Important`,
  label: msg`Labels`,
  move: msg`Move to folder`,
  openThread: msg`Open in New Window`,
  next: msg`Next thread`,
  previous: msg`Previous thread`,
  undo: msg`Undo`,
  print: msg`Print`,
  goToFolder: msg`Go to folder`,
  inbox: msg`Move to Inbox`,
  filterUnread: msg`Unread filter`,
  templates: msg`Templates`,
  sendArchive: msg`Send and archive`,
  attach: msg`Attach files`,
  saveDraft: msg`Save draft`,
  closeCompose: msg`Close compose window`,
  zoomIn: msg`Larger text`,
  zoomOut: msg`Smaller text`,
  zoomReset: msg`Actual size`,
  expandAll: msg`Expand all messages`,
  collapseAll: msg`Collapse all messages`,
  saveMessage: msg`Save message as EML…`,
  searchSender: msg`Search messages from this sender`,
  openMessageWeb: msg`Open in web mail`,
  send: msg`Send`,
};
const ACTIONS = Object.entries(ACTION_NAMES);
export function ShortcutTable({ set }: { set: ShortcutSet }) {
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
                <kbd className="font-mono text-[12px] text-neutral-500">
                  {shortcutText(set, action)}
                </kbd>
              </td>
            </tr>
          );
        })}
        <tr>
          <td className="pt-3">
            <Trans>Switch spaces</Trans>
          </td>
          <td className="pt-3 text-right">
            <kbd>⌃⌘1…9</kbd>
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
      <p className="my-3 text-neutral-500">
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
