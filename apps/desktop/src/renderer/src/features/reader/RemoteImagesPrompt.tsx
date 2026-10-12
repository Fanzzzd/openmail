import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Trans, useLingui } from "@lingui/react/macro";
import type { RemoteImageMode } from "@openmail/core/schema";
import { ImageIcon, X } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { Keys } from "../../state/keys";
import { setPrefsAtom } from "../../state/mutations";
import { prefsAtom } from "../../state/queries";
import { formButton } from "../../ui/form-styles";
import { iconButton } from "../../ui/styles";

/**
 * Floats over the bottom-right corner of the window: clear of the titlebar, above the
 * panes (z-30) and below drawers, toasts and dialogs (z-40, z-50). It does not shift the
 * layout and does not take focus.
 */
const card =
  "no-drag fixed right-4 bottom-4 z-30 max-h-[calc(100vh-64px)] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-xl bg-white/95 p-4 text-[13px] text-neutral-900 shadow-[0_8px_24px_rgb(0_0_0/0.16)] ring-1 ring-black/10 backdrop-blur-xl transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none dark:bg-[#2c2c2e]/95 dark:text-neutral-100 dark:shadow-[0_8px_24px_rgb(0_0_0/0.5)] dark:ring-white/10";

/**
 * Asks once how remote images load. It stays until the person stores a mode; closing it
 * stores "always", the option it preselects.
 */
export function RemoteImagesPrompt({ hasAccounts }: { hasAccounts: boolean }) {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  const [mode, setMode] = useState<RemoteImageMode>("always");
  const [saved, setSaved] = useState(false);
  const id = useId();
  if (!hasAccounts || !prefs || prefs.remoteImagesChosen || saved) return null;
  const save = (remoteImages: RemoteImageMode) => {
    setSaved(true);
    setPrefs({ payload: { patch: { remoteImages } }, reactivityKeys: [Keys.prefs, Keys.threads] });
  };
  const loadImages = t`Load images`;
  const options: readonly { value: RemoteImageMode; label: string; hint: string }[] = [
    {
      value: "always",
      label: t`Always, block trackers`,
      hint: t`Recommended. Known tracking pixels stay blocked.`,
    },
    {
      value: "known",
      label: t`From people I know`,
      hint: t`Contacts and people you've sent mail to, when the sender is verified.`,
    },
    {
      value: "ask",
      label: t`Ask each time`,
      hint: t({
        message: `Click ${loadImages} on each message.`,
        comment: "loadImages is the translated Load images button above a message in the reader.",
      }),
    },
  ];
  return (
    <section aria-labelledby={`${id}-title`} className={card}>
      <div className="flex items-start gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-600/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
          <ImageIcon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 id={`${id}-title`} className="leading-5 font-semibold">
            <Trans>Load images in messages?</Trans>
          </h2>
          <p className="mt-0.5 text-[12px] text-a11y-muted">
            <Trans>
              Loading remote images lets the sender see when you open a message and your IP address.
            </Trans>
          </p>
        </div>
        <button
          type="button"
          aria-label={t`Close`}
          className={`-mt-1 -mr-1 shrink-0 text-a11y-muted ${iconButton}`}
          onClick={() => save("always")}
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <RadioGroup<RemoteImageMode>
        aria-label={t`Remote images`}
        value={mode}
        onValueChange={setMode}
        className="mt-3 space-y-1"
      >
        {options.map((option) => (
          <Radio.Root<RemoteImageMode>
            key={option.value}
            value={option.value}
            aria-labelledby={`${id}-${option.value}`}
            aria-describedby={`${id}-${option.value}-hint`}
            // The ring replaces the base radio outline, which reads as a heavy box on a full row.
            className="group flex w-full cursor-default gap-2.5 rounded-lg px-2 py-1.5 ring-1 ring-black/[0.08] outline-a11y-focus hover:bg-black/[0.04] focus-visible:outline-[3px] data-checked:bg-blue-600/10 data-checked:ring-blue-600/45 dark:ring-white/[0.08] dark:hover:bg-white/[0.06] dark:data-checked:bg-blue-500/[0.12] dark:data-checked:ring-blue-400/45"
          >
            <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full bg-white shadow-[0_0.5px_1px_rgb(0_0_0/0.15)] ring-1 ring-black/20 group-data-checked:bg-blue-600 group-data-checked:ring-blue-600 dark:bg-white/10 dark:ring-white/20 dark:group-data-checked:bg-blue-600 dark:group-data-checked:ring-blue-500">
              <Radio.Indicator className="size-1.5 rounded-full bg-white" />
            </span>
            <span className="min-w-0">
              <span id={`${id}-${option.value}`} className="block font-medium">
                {option.label}
              </span>
              <span
                id={`${id}-${option.value}-hint`}
                className="block text-[11px] leading-4 text-a11y-muted"
              >
                {option.hint}
              </span>
            </span>
          </Radio.Root>
        ))}
      </RadioGroup>
      <div className="mt-3 flex justify-end">
        <button type="button" className={formButton} onClick={() => save(mode)}>
          <Trans>Done</Trans>
        </button>
      </div>
    </section>
  );
}
