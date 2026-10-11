import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { RemoteImageMode } from "@openmail/core/schema";
import { X } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { Keys } from "../state/keys";
import { setPrefsAtom } from "../state/mutations";
import { prefsAtom } from "../state/queries";
import { formButton } from "./ui/form-styles";
import { SegmentedControl } from "./ui/SegmentedControl";
import { iconButton } from "./ui/styles";

/**
 * Asks once how remote images load, above the mail panes. It stays until the person stores
 * a mode; closing it stores "always", the default it already shows.
 */
export function RemoteImagesPrompt({ hasAccounts }: { hasAccounts: boolean }) {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  const [mode, setMode] = useState<RemoteImageMode>("always");
  const [saved, setSaved] = useState(false);
  const titleId = useId();
  if (!hasAccounts || !prefs || prefs.remoteImagesChosen || saved) return null;
  const save = (remoteImages: RemoteImageMode) => {
    setSaved(true);
    setPrefs({ payload: { patch: { remoteImages } }, reactivityKeys: [Keys.prefs, Keys.threads] });
  };
  return (
    <section
      aria-labelledby={titleId}
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5"
    >
      <div className="min-w-60 flex-1">
        <h2 id={titleId} className="font-semibold">
          <Trans>Load images in messages?</Trans>
        </h2>
        <p className="text-a11y-muted">
          <Trans>
            Loading remote images lets the sender see when you open a message and your IP address.
          </Trans>{" "}
          <Trans>OpenMail blocks known tracking pixels in every mode.</Trans>
        </p>
      </div>
      <SegmentedControl
        aria-label={t`Remote images`}
        value={mode}
        options={[
          { value: "always" as const, label: t`Always, block trackers` },
          { value: "known" as const, label: t`From people I know` },
          { value: "ask" as const, label: t`Ask each time` },
        ]}
        onValueChange={setMode}
      />
      <button type="button" className={formButton} onClick={() => save(mode)}>
        <Trans>Done</Trans>
      </button>
      <button
        type="button"
        aria-label={t`Close`}
        className={`text-a11y-muted ${iconButton}`}
        onClick={() => save("always")}
      >
        <X className="size-4" />
      </button>
    </section>
  );
}
