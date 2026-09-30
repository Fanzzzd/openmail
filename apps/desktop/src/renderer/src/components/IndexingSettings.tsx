import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { MailClient } from "../rpc";
import { indexingProgressAtom } from "../state/queries";
import { Switch } from "@base-ui/react/switch";

const pauseAtom = MailClient.mutation("SetIndexingPaused");
export function IndexingSettings() {
  const { t } = useLingui();
  const progress = AsyncResult.getOrElse(useAtomValue(indexingProgressAtom), () => null);
  const pause = useAtomSet(pauseAtom);
  if (!progress) return null;
  const { done, queued, running, failed } = progress;
  return (
    <section className="mt-6 space-y-2">
      <h3 className="text-[12px] font-semibold text-neutral-500">
        <Trans>On-device indexing</Trans>
      </h3>
      <p className="text-neutral-500">
        <Trans>
          Images and PDF text are processed on this device. No content is sent to a cloud model.
        </Trans>
      </p>
      {!progress.available && (
        <p>
          <Trans>Image recognition is unavailable on this platform.</Trans>
        </p>
      )}
      <output>
        <Trans>
          {done} completed · {queued} queued · {running} running · {failed} failed
        </Trans>
      </output>
      <div className="flex items-center gap-2">
        <Switch.Root
          className="flex h-5 w-9 rounded-full bg-neutral-300 p-0.5 outline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-500 data-checked:bg-blue-500"
          checked={progress.paused}
          aria-label={t`Pause indexing`}
          onCheckedChange={(paused) => pause({ payload: { paused }, reactivityKeys: ["indexing"] })}
        >
          <Switch.Thumb className="size-4 rounded-full bg-white transition-transform data-checked:translate-x-4" />
        </Switch.Root>
        <Trans>Pause indexing</Trans>
      </div>
      {progress.onBattery && (
        <p className="text-neutral-500">
          <Trans>
            On battery: image recognition waits for AC power. PDF text indexing is throttled.
          </Trans>
        </p>
      )}
      <p className="text-neutral-500">
        <Trans>Runs while idle. Scanned PDF pages, audio and video are not indexed yet.</Trans>
      </p>
    </section>
  );
}
