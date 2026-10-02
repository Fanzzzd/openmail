import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { imageSenderKey, MARK_READ_DELAYS, type Prefs, READER_ZOOMS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Keys } from "../state/keys";
import { setImageSenderAtom, setPrefsAtom } from "../state/mutations";
import { imageSendersAtom, prefsAtom } from "../state/queries";
import { useShortcutText } from "./SystemSettings";
import { Checkbox } from "./ui/Checkbox";
import { SegmentedControl } from "./ui/SegmentedControl";

const heading = "mb-2 text-[12px] font-semibold text-neutral-500 dark:text-neutral-400";
const note = "mt-2 text-neutral-500 dark:text-neutral-400";
const box = "rounded-lg border border-black/10 dark:border-white/10";

/** Settings > Reading: when mail counts as read, conversations, message look, remote images. */
export function ReadingSettings() {
  const { t } = useLingui();
  const readShortcut = useShortcutText()("read");
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefsMutation = useAtomSet(setPrefsAtom);
  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsMutation({ payload: { patch }, reactivityKeys: [Keys.prefs, Keys.threads] });

  return (
    <div className="space-y-6">
      <label htmlFor="show-account-labels" className="flex items-center gap-2">
        <Checkbox
          id="show-account-labels"
          checked={prefs?.showAccountLabels ?? false}
          onCheckedChange={(showAccountLabels) => setPrefs({ showAccountLabels })}
        />
        <Trans>Show account names in unified folders</Trans>
      </label>
      <section>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={prefs?.showMore ?? true}
            onCheckedChange={(showMore) => setPrefs({ showMore })}
          />
          <span>{t`Show More in sidebar`}</span>
        </label>
      </section>
      <section>
        <h3 className={heading}>
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
        <h3 className={heading}>
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
        <h3 className={heading}>
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
        <h3 className={heading}>
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
        <h3 className={heading}>
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
      <h3 className={heading}>
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
        <ul className={`${box} divide-y divide-black/[0.07] dark:divide-white/[0.08]`}>
          {senders.map((sender) => (
            <li key={sender} className="flex items-center gap-3 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{sender}</span>
              <button
                type="button"
                onClick={() => set(sender, false)}
                className="h-7 shrink-0 rounded-md px-2.5 text-red-600 hover:bg-red-500/10 dark:text-red-400"
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
