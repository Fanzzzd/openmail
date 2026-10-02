import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { MailClient } from "../rpc";
import { indexingProgressAtom } from "../state/queries";
import { Switch } from "@base-ui/react/switch";

const modelsAtom = MailClient.mutation("SetModelsEnabled");
const pauseAtom = MailClient.mutation("SetIndexingPaused");
export function IndexingSettings() {
  const { t, i18n } = useLingui();
  const progress = AsyncResult.getOrElse(useAtomValue(indexingProgressAtom), () => null);
  const pause = useAtomSet(pauseAtom);
  const models = useAtomSet(modelsAtom);
  if (!progress) return null;
  const done = i18n.number(progress.done),
    queued = i18n.number(progress.queued),
    running = i18n.number(progress.running),
    failed = i18n.number(progress.failed);
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
      <div className="flex items-center gap-2">
        <Switch.Root
          className="flex h-5 w-9 rounded-full bg-neutral-300 p-0.5 outline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-500 data-checked:bg-blue-500"
          checked={progress.modelsEnabled ?? false}
          aria-label={t`Download on-device models, ~226 MB`}
          onCheckedChange={(enabled) =>
            models({ payload: { enabled }, reactivityKeys: ["indexing"] })
          }
        >
          <Switch.Thumb className="size-4 rounded-full bg-white transition-transform data-checked:translate-x-4" />
        </Switch.Root>
        <Trans>Download on-device models, ~226 MB</Trans>
      </div>
      {progress.modelsEnabled && !progress.semanticAvailable && (
        <p>
          <Trans>Semantic search is unavailable. Full-text search remains available.</Trans>
        </p>
      )}
      {progress.modelsEnabled && (
        <>
          {progress.models?.kind === "downloading" && (
            <div>
              <progress
                value={progress.models.bytes}
                max={progress.models.total}
                aria-label={t`Model download progress`}
                className="w-full"
              />
              <p>
                <Trans>
                  Downloading models:{" "}
                  {i18n.number(Math.floor((progress.models.bytes / progress.models.total) * 100))}%
                </Trans>
              </p>
            </div>
          )}
          {progress.models?.kind === "ready" && (
            <p>
              <Trans>Models verified and ready. Search stays on this device.</Trans>
            </p>
          )}
          {progress.models?.kind === "error" && (
            <p role="alert">
              <Trans>Model download failed. Retrying while idle.</Trans>
            </p>
          )}
          <output>
            <Trans>
              {i18n.number(progress.embeddingDone ?? 0)} embedded ·{" "}
              {i18n.number(progress.embeddingQueued ?? 0)} queued ·{" "}
              {i18n.number(progress.embeddingRunning ?? 0)} running ·{" "}
              {i18n.number(progress.embeddingFailed ?? 0)} failed
            </Trans>
          </output>
        </>
      )}
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
