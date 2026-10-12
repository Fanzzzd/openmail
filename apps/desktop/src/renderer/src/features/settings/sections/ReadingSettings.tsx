import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  imageSenderKey,
  MARK_READ_DELAYS,
  type PrefsPatch,
  READER_ZOOMS,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { Keys } from "../../../state/keys";
import {
  chooseAttachmentFolderAtom,
  setImageSenderAtom,
  setPrefsAtom,
} from "../../../state/mutations";
import { imageSendersAtom, prefsAtom } from "../../../state/queries";
import { shortcutText } from "../../../../../shared/shortcuts";
import { useShortcutSet } from "../../../i18n/use-shortcut-text";
import { Checkbox } from "../../../ui/Checkbox";
import { SettingsCheckRow, SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import { buttonLink, buttonSecondary, formInput, settingsHint } from "../../../ui/styles";
import { SegmentedControl } from "../../../ui/SegmentedControl";

/** Settings > Reading: when mail counts as read, conversations, message look, remote images. */
export function ReadingSettings() {
  const { t } = useLingui();
  // Part of a sentence, not a hint beside a control, so the web build keeps it too.
  const readShortcut = shortcutText(useShortcutSet(), "read");
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefsMutation = useAtomSet(setPrefsAtom);
  const setPrefs = (patch: PrefsPatch) =>
    setPrefsMutation({ payload: { patch }, reactivityKeys: [Keys.prefs, Keys.threads] });
  const chooseFolderMutation = useAtomSet(chooseAttachmentFolderAtom);
  // The main process shows the folder picker and stores the path; Settings only displays it.
  const chooseFolder = () =>
    chooseFolderMutation({ payload: undefined, reactivityKeys: [Keys.prefs] });

  return (
    <>
      <SettingsGroup>
        <SettingsCheckRow>
          <label htmlFor="clean-mail-links" className="flex items-center gap-2">
            <Checkbox
              id="clean-mail-links"
              checked={prefs?.cleanLinks !== false}
              onCheckedChange={(cleanLinks) => setPrefs({ cleanLinks })}
            />
            <Trans>Remove tracking parameters from links</Trans>
          </label>
        </SettingsCheckRow>
        <SettingsCheckRow>
          <label htmlFor="show-account-labels" className="flex items-center gap-2">
            <Checkbox
              id="show-account-labels"
              checked={prefs?.showAccountLabels ?? false}
              onCheckedChange={(showAccountLabels) => setPrefs({ showAccountLabels })}
            />
            <Trans>Show account names in unified folders</Trans>
          </label>
        </SettingsCheckRow>
      </SettingsGroup>
      <SettingsGroup title={<Trans>Layout</Trans>}>
        <SettingsCheckRow>
          <label htmlFor="layout-sidebar" className="flex items-center gap-2">
            <Checkbox
              id="layout-sidebar"
              checked={prefs?.sidebarVisible ?? true}
              onCheckedChange={(sidebarVisible) => setPrefs({ sidebarVisible })}
            />
            <Trans>Show or hide sidebar</Trans>
          </label>
        </SettingsCheckRow>
        <SettingsCheckRow>
          <label htmlFor="layout-toolbar" className="flex items-center gap-2">
            <Checkbox
              id="layout-toolbar"
              checked={prefs?.toolbarVisible ?? true}
              onCheckedChange={(toolbarVisible) => setPrefs({ toolbarVisible })}
            />
            <Trans>Show or hide toolbar</Trans>
          </label>
        </SettingsCheckRow>
        <SettingsCheckRow>
          <label htmlFor="layout-reader" className="flex items-center gap-2">
            <Checkbox
              id="layout-reader"
              checked={prefs?.readingPaneVisible ?? true}
              onCheckedChange={(readingPaneVisible) => setPrefs({ readingPaneVisible })}
            />
            <Trans>Show or hide reading pane</Trans>
          </label>
        </SettingsCheckRow>
        <StackedRow label={<Trans>Message list density</Trans>}>
          <SegmentedControl
            aria-label={t`Message list density`}
            className="w-full"
            value={prefs?.messageListDensity ?? "default"}
            options={[
              { value: "dense" as const, label: t`Dense` },
              { value: "compact" as const, label: t`Compact` },
              { value: "default" as const, label: t`Default` },
              { value: "expanded" as const, label: t`Expanded` },
            ]}
            onValueChange={(messageListDensity) => setPrefs({ messageListDensity })}
          />
        </StackedRow>
      </SettingsGroup>
      <SettingsGroup title={<Trans>Special folder badges</Trans>}>
        {(
          [
            { id: "starred", label: t`Starred` },
            { id: "drafts", label: t`Drafts` },
            { id: "spam", label: t`Spam` },
          ] as const
        ).map(({ id, label }) => (
          <SettingsCheckRow key={id}>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={prefs?.specialFolderBadges[id] ?? true}
                onCheckedChange={(checked) =>
                  setPrefs({
                    specialFolderBadges: {
                      starred: true,
                      drafts: true,
                      spam: true,
                      ...prefs?.specialFolderBadges,
                      [id]: checked,
                    },
                  })
                }
              />
              <span>{label}</span>
            </label>
          </SettingsCheckRow>
        ))}
      </SettingsGroup>
      <SettingsGroup>
        <SettingsCheckRow>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={prefs?.showMore ?? true}
              onCheckedChange={(showMore) => setPrefs({ showMore })}
            />
            <span>{t`Show More in sidebar`}</span>
          </label>
        </SettingsCheckRow>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow label={<Trans>Attachment folder</Trans>}>
          {/* Saving never asks, so the legacy "ask" setting shows as Downloads, where it saves. */}
          <SegmentedControl
            aria-label={t`Attachment folder`}
            value={prefs?.attachmentSaveFolder?.kind === "custom" ? "custom" : "downloads"}
            options={[
              { value: "downloads" as const, label: t`Downloads` },
              { value: "custom" as const, label: t`Custom folder` },
            ]}
            onValueChange={(kind) =>
              kind === "custom" ? chooseFolder() : setPrefs({ attachmentSaveFolder: { kind } })
            }
          />
        </SettingsRow>
        {prefs?.attachmentSaveFolder?.kind === "custom" && (
          <div className="flex items-end gap-2 px-3 py-2">
            <label className="block min-w-0 flex-1">
              <span className="mb-1 block">{t`Folder path`}</span>
              <input readOnly className={formInput} value={prefs.attachmentSaveFolder.path} />
            </label>
            <button type="button" className={buttonSecondary} onClick={chooseFolder}>
              {t`Choose…`}
            </button>
          </div>
        )}
        <SettingsRow label={<Trans>Open attachments from</Trans>}>
          <SegmentedControl
            aria-label={t`Open attachments from`}
            value={prefs?.attachmentOpenFolder ?? "internal"}
            options={[
              { value: "internal" as const, label: t`Internal folder` },
              { value: "downloads" as const, label: t`Downloads` },
            ]}
            onValueChange={(attachmentOpenFolder) => setPrefs({ attachmentOpenFolder })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup>
        <StackedRow
          label={<Trans>Mark as read</Trans>}
          hint={
            <Trans>
              How long a conversation stays open before it is marked as read. Manually: use{" "}
              {readShortcut} or the toolbar.
            </Trans>
          }
        >
          <SegmentedControl
            aria-label={t`Mark as read`}
            className="w-full"
            value={prefs?.markReadDelay ?? null}
            options={MARK_READ_DELAYS.map((delay) => ({
              value: delay,
              label:
                delay === 0
                  ? t`Right away`
                  : delay === "manual"
                    ? t`Manually`
                    : plural(delay, { one: "# second", other: "# seconds" }),
            }))}
            onValueChange={(markReadDelay) => setPrefs({ markReadDelay })}
          />
        </StackedRow>
        <StackedRow label={<Trans>Delete key action</Trans>}>
          <SegmentedControl
            aria-label={t`Delete key action`}
            className="w-full"
            value={prefs?.deleteKeyAction ?? "trash"}
            options={[
              { value: "trash" as const, label: t`Move to Trash` },
              { value: "archive" as const, label: t`Archive` },
              { value: "removeLabel" as const, label: t`Remove current label` },
              { value: "ask" as const, label: t`Ask each time` },
            ]}
            onValueChange={(deleteKeyAction) => setPrefs({ deleteKeyAction })}
          />
        </StackedRow>
        <StackedRow label={<Trans>Selection after moving messages</Trans>}>
          <SegmentedControl
            aria-label={t`Selection after moving messages`}
            className="w-full"
            value={prefs?.nextSelection ?? "below"}
            options={[
              { value: "below" as const, label: t`Next below` },
              { value: "above" as const, label: t`Next above` },
              { value: "none" as const, label: t`None` },
            ]}
            onValueChange={(nextSelection) => setPrefs({ nextSelection })}
          />
        </StackedRow>
      </SettingsGroup>

      <SettingsGroup title={<Trans>Conversations</Trans>}>
        <SettingsCheckRow>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={prefs?.threadGrouping ?? true}
              onCheckedChange={(threadGrouping) => setPrefs({ threadGrouping })}
            />
            <span>{t`Group messages into conversations`}</span>
          </label>
        </SettingsCheckRow>
        <SettingsRow label={<Trans>Order</Trans>}>
          <SegmentedControl
            aria-label={t`Message order in a conversation`}
            value={prefs?.threadOrder ?? null}
            options={[
              { value: "oldest" as const, label: t`Oldest first` },
              { value: "newest" as const, label: t`Newest first` },
            ]}
            onValueChange={(threadOrder) => setPrefs({ threadOrder })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={<Trans>Message background</Trans>}
          hint={
            <Trans>
              Many HTML emails are designed for white. Each message's menu can switch its
              background.
            </Trans>
          }
        >
          <SegmentedControl
            aria-label={t`Message background`}
            value={prefs?.messageBackground ?? null}
            options={[
              { value: "light" as const, label: t`Always light` },
              { value: "theme" as const, label: t`Match appearance` },
            ]}
            onValueChange={(messageBackground) => setPrefs({ messageBackground })}
          />
        </SettingsRow>
        <StackedRow
          label={<Trans>Text size</Trans>}
          hint={<Trans>In the reader, ⌘+ and ⌘− change it and ⌘0 goes back to 100%.</Trans>}
        >
          <SegmentedControl
            aria-label={t`Text size`}
            className="w-full"
            value={prefs?.readerZoom ?? null}
            options={READER_ZOOMS.map((zoom) => ({ value: zoom, label: `${zoom}%` }))}
            onValueChange={(readerZoom) => setPrefs({ readerZoom })}
          />
        </StackedRow>
      </SettingsGroup>

      <SettingsGroup
        footer={
          <>
            <Trans>
              Loading remote images lets the sender see when you open a message and your IP address.
            </Trans>{" "}
            <Trans>
              People you know are your contacts and people you have sent mail to, when the message
              passes sender authentication. Known trackers stay blocked.
            </Trans>{" "}
            <Trans comment="Always is the Remote images option label above.">
              Outlook accounts, and IMAP accounts without a trusted authentication server, cannot
              confirm the sender, so only Always loads their images.
            </Trans>
          </>
        }
      >
        <StackedRow
          label={<Trans>Remote images</Trans>}
          hint={
            prefs && !prefs.remoteImagesChosen ? (
              <Trans>
                No mode picked yet. Remote images load, and known trackers stay blocked.
              </Trans>
            ) : undefined
          }
        >
          <SegmentedControl
            aria-label={t`Remote images`}
            className="w-full"
            // Until a mode is stored nothing is selected, so picking the default also records it.
            value={prefs?.remoteImagesChosen ? prefs.remoteImages : null}
            options={[
              { value: "ask" as const, label: t`Ask each time` },
              { value: "known" as const, label: t`From people I know` },
              {
                value: "always" as const,
                label: t({ message: "Always", comment: "Remote images setting: always load." }),
              },
            ]}
            onValueChange={(remoteImages) => setPrefs({ remoteImages })}
          />
        </StackedRow>
      </SettingsGroup>

      <ImageSenders />
    </>
  );
}

/** A setting whose control is too wide to sit beside its label: label, full-width control, hint. */
function StackedRow({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 px-3 py-2">
      <span className="block">{label}</span>
      {children}
      {hint && <div className={settingsHint}>{hint}</div>}
    </div>
  );
}

function ImageSenders() {
  const { t } = useLingui();
  const senders = AsyncResult.getOrElse(useAtomValue(imageSendersAtom), () => []);
  const setSender = useAtomSet(setImageSenderAtom);
  const [draft, setDraft] = useState("");
  const set = (entry: string, allowed: boolean) =>
    setSender({ payload: { entry, allowed }, reactivityKeys: [Keys.imageSenders] });
  const entry = imageSenderKey(draft);
  const valid = /^[^\s@]+(@[^\s@]+\.[^\s@]+)?$/.test(entry) && entry.includes(".");

  return (
    <SettingsGroup
      title={<Trans>Always load remote images from</Trans>}
      footer={
        <Trans>
          A domain covers its subdomains. Known trackers stay blocked for these senders too.
        </Trans>
      }
    >
      <form
        className="flex gap-2 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          set(entry, true);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t`news@shop.com or shop.com`}
          aria-label={t`Address or domain`}
          className={`min-w-0 flex-1 ${formInput}`}
        />
        <button type="submit" disabled={!valid} className={`shrink-0 ${buttonSecondary}`}>
          <Trans>Add</Trans>
        </button>
      </form>
      {senders.length > 0 && (
        <ul className="divide-y divide-separator">
          {senders.map((sender) => (
            <li key={sender} className="flex min-h-10 items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate">{sender}</span>
              <button
                type="button"
                onClick={() => set(sender, false)}
                className={`shrink-0 ${buttonLink}`}
              >
                <Trans>Remove</Trans>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}
