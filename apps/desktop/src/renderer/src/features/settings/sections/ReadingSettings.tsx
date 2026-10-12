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
import { useState } from "react";

import { Keys } from "../../../state/keys";
import {
  chooseAttachmentFolderAtom,
  setImageSenderAtom,
  setPrefsAtom,
} from "../../../state/mutations";
import { imageSendersAtom, prefsAtom } from "../../../state/queries";
import { useShortcutText } from "../../../i18n/use-shortcut-text";
import { Checkbox } from "../../../ui/Checkbox";
import { formButton, formInput, settingsBox, settingsHeading } from "../../../ui/form-styles";
import { SegmentedControl } from "../../../ui/SegmentedControl";

const note = "mt-2 text-a11y-muted";

/** Settings > Reading: when mail counts as read, conversations, message look, remote images. */
export function ReadingSettings() {
  const { t } = useLingui();
  const readShortcut = useShortcutText()("read");
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefsMutation = useAtomSet(setPrefsAtom);
  const setPrefs = (patch: PrefsPatch) =>
    setPrefsMutation({ payload: { patch }, reactivityKeys: [Keys.prefs, Keys.threads] });
  const chooseFolderMutation = useAtomSet(chooseAttachmentFolderAtom);
  // The main process shows the folder picker and stores the path; Settings only displays it.
  const chooseFolder = () =>
    chooseFolderMutation({ payload: undefined, reactivityKeys: [Keys.prefs] });

  return (
    <div className="space-y-6">
      <label htmlFor="clean-mail-links" className="flex items-center gap-2">
        <Checkbox
          id="clean-mail-links"
          checked={prefs?.cleanLinks !== false}
          onCheckedChange={(cleanLinks) => setPrefs({ cleanLinks })}
        />
        <Trans>Remove tracking parameters from links</Trans>
      </label>
      <label htmlFor="show-account-labels" className="flex items-center gap-2">
        <Checkbox
          id="show-account-labels"
          checked={prefs?.showAccountLabels ?? false}
          onCheckedChange={(showAccountLabels) => setPrefs({ showAccountLabels })}
        />
        <Trans>Show account names in unified folders</Trans>
      </label>
      <section className="space-y-2">
        <h3 className={settingsHeading}>
          <Trans>Layout</Trans>
        </h3>
        <label htmlFor="layout-sidebar" className="flex items-center gap-2">
          <Checkbox
            id="layout-sidebar"
            checked={prefs?.sidebarVisible ?? true}
            onCheckedChange={(sidebarVisible) => setPrefs({ sidebarVisible })}
          />
          <Trans>Show or hide sidebar</Trans>
        </label>
        <label htmlFor="layout-toolbar" className="flex items-center gap-2">
          <Checkbox
            id="layout-toolbar"
            checked={prefs?.toolbarVisible ?? true}
            onCheckedChange={(toolbarVisible) => setPrefs({ toolbarVisible })}
          />
          <Trans>Show or hide toolbar</Trans>
        </label>
        <label htmlFor="layout-reader" className="flex items-center gap-2">
          <Checkbox
            id="layout-reader"
            checked={prefs?.readingPaneVisible ?? true}
            onCheckedChange={(readingPaneVisible) => setPrefs({ readingPaneVisible })}
          />
          <Trans>Show or hide reading pane</Trans>
        </label>
      </section>
      <section>
        <h3 className={settingsHeading}>
          <Trans>Message list density</Trans>
        </h3>
        <SegmentedControl
          aria-label={t`Message list density`}
          value={prefs?.messageListDensity ?? "default"}
          options={[
            { value: "dense" as const, label: t`Dense` },
            { value: "compact" as const, label: t`Compact` },
            { value: "default" as const, label: t`Default` },
            { value: "expanded" as const, label: t`Expanded` },
          ]}
          onValueChange={(messageListDensity) => setPrefs({ messageListDensity })}
        />
      </section>
      <section className="space-y-2">
        <h3 className={settingsHeading}>
          <Trans>Special folder badges</Trans>
        </h3>
        {(
          [
            { id: "starred", label: t`Starred` },
            { id: "drafts", label: t`Drafts` },
            { id: "spam", label: t`Spam` },
          ] as const
        ).map(({ id, label }) => (
          <label key={id} className="flex items-center gap-2">
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
        ))}
      </section>
      <section>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={prefs?.showMore ?? true}
            onCheckedChange={(showMore) => setPrefs({ showMore })}
          />
          <span>{t`Show More in sidebar`}</span>
        </label>
      </section>
      <section className="space-y-2">
        <h3 className={settingsHeading}>
          <Trans>Attachment folder</Trans>
        </h3>
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
        {prefs?.attachmentSaveFolder?.kind === "custom" && (
          <div className="flex items-end gap-2">
            <label className="block min-w-0 flex-1">
              <span>{t`Folder path`}</span>
              <input readOnly className={formInput} value={prefs.attachmentSaveFolder.path} />
            </label>
            <button type="button" className={formButton} onClick={chooseFolder}>
              {t`Choose…`}
            </button>
          </div>
        )}
        <h3 className={settingsHeading}>
          <Trans>Open attachments from</Trans>
        </h3>
        <SegmentedControl
          aria-label={t`Open attachments from`}
          value={prefs?.attachmentOpenFolder ?? "internal"}
          options={[
            { value: "internal" as const, label: t`Internal folder` },
            { value: "downloads" as const, label: t`Downloads` },
          ]}
          onValueChange={(attachmentOpenFolder) => setPrefs({ attachmentOpenFolder })}
        />
      </section>
      <section>
        <h3 className={settingsHeading}>
          <Trans>Mark as read</Trans>
        </h3>
        <SegmentedControl
          aria-label={t`Mark as read`}
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
        <p className={note}>
          <Trans>
            How long a conversation stays open before it is marked as read. Manually: use{" "}
            {readShortcut} or the toolbar.
          </Trans>
        </p>
      </section>

      <section>
        <h3 className={settingsHeading}>
          <Trans>Delete key action</Trans>
        </h3>
        <SegmentedControl
          aria-label={t`Delete key action`}
          value={prefs?.deleteKeyAction ?? "trash"}
          options={[
            { value: "trash" as const, label: t`Move to Trash` },
            { value: "archive" as const, label: t`Archive` },
            { value: "removeLabel" as const, label: t`Remove current label` },
            { value: "ask" as const, label: t`Ask each time` },
          ]}
          onValueChange={(deleteKeyAction) => setPrefs({ deleteKeyAction })}
        />
      </section>
      <section>
        <h3 className={settingsHeading}>
          <Trans>Selection after moving messages</Trans>
        </h3>
        <SegmentedControl
          aria-label={t`Selection after moving messages`}
          value={prefs?.nextSelection ?? "below"}
          options={[
            { value: "below" as const, label: t`Next below` },
            { value: "above" as const, label: t`Next above` },
            { value: "none" as const, label: t`None` },
          ]}
          onValueChange={(nextSelection) => setPrefs({ nextSelection })}
        />
      </section>

      <section>
        <h3 className={settingsHeading}>
          <Trans>Conversations</Trans>
        </h3>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={prefs?.threadGrouping ?? true}
            onCheckedChange={(threadGrouping) => setPrefs({ threadGrouping })}
          />
          <span>{t`Group messages into conversations`}</span>
        </label>
        <div className="mt-3 flex items-center gap-3">
          <span>
            <Trans>Order</Trans>
          </span>
          <SegmentedControl
            aria-label={t`Message order in a conversation`}
            value={prefs?.threadOrder ?? null}
            options={[
              { value: "oldest" as const, label: t`Oldest first` },
              { value: "newest" as const, label: t`Newest first` },
            ]}
            onValueChange={(threadOrder) => setPrefs({ threadOrder })}
          />
        </div>
      </section>

      <section>
        <h3 className={settingsHeading}>
          <Trans>Message background</Trans>
        </h3>
        <SegmentedControl
          aria-label={t`Message background`}
          value={prefs?.messageBackground ?? null}
          options={[
            { value: "light" as const, label: t`Always light` },
            { value: "theme" as const, label: t`Match appearance` },
          ]}
          onValueChange={(messageBackground) => setPrefs({ messageBackground })}
        />
        <p className={note}>
          <Trans>
            Many HTML emails are designed for white. Each message's menu can switch its background.
          </Trans>
        </p>
      </section>

      <section>
        <h3 className={settingsHeading}>
          <Trans>Text size</Trans>
        </h3>
        <SegmentedControl
          aria-label={t`Text size`}
          value={prefs?.readerZoom ?? null}
          options={READER_ZOOMS.map((zoom) => ({ value: zoom, label: `${zoom}%` }))}
          onValueChange={(readerZoom) => setPrefs({ readerZoom })}
        />
        <p className={note}>
          <Trans>In the reader, ⌘+ and ⌘− change it and ⌘0 goes back to 100%.</Trans>
        </p>
      </section>

      <section>
        <h3 className={settingsHeading}>
          <Trans>Remote images</Trans>
        </h3>
        <SegmentedControl
          aria-label={t`Remote images`}
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
        {prefs && !prefs.remoteImagesChosen && (
          <p className={note}>
            <Trans>No mode picked yet. Remote images load, and known trackers stay blocked.</Trans>
          </p>
        )}
        <p className={note}>
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
        </p>
      </section>

      <ImageSenders />
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
    <section>
      <h3 className={settingsHeading}>
        <Trans>Always load remote images from</Trans>
      </h3>
      <form
        className="mb-2 flex gap-2"
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
          className="h-7 min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-2 outline-none focus:border-blue-500 dark:border-white/15"
        />
        <button
          type="submit"
          disabled={!valid}
          className="h-7 shrink-0 rounded-md border border-black/10 px-3 font-medium hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/5"
        >
          <Trans>Add</Trans>
        </button>
      </form>
      {senders.length > 0 && (
        <ul className={`${settingsBox} divide-y divide-black/[0.07] dark:divide-white/[0.08]`}>
          {senders.map((sender) => (
            <li key={sender} className="flex items-center gap-3 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{sender}</span>
              <button
                type="button"
                onClick={() => set(sender, false)}
                className="h-7 shrink-0 rounded-md px-2.5 text-a11y-danger hover:bg-red-500/10 dark:text-red-400"
              >
                <Trans>Remove</Trans>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={note}>
        <Trans>
          A domain covers its subdomains. Known trackers stay blocked for these senders too.
        </Trans>
      </p>
    </section>
  );
}
