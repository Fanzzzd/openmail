import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ProgressBar } from "../../../ui/Progress";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { MailClient } from "../../../state/rpc";
import { indexingProgressAtom } from "../../../state/queries";
import { Switch } from "@base-ui/react/switch";
import { SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import { settingsHint, switchThumb, switchTrack } from "../../../ui/styles";

const modelsAtom = MailClient.mutation("SetModelsEnabled");
const pauseAtom = MailClient.mutation("SetIndexingPaused");
export function IndexingSettings() {
  const { t, i18n } = useLingui();
  const progress = AsyncResult.getOrElse(useAtomValue(indexingProgressAtom), () => null);
  const pause = useAtomSet(pauseAtom);
  const models = useAtomSet(modelsAtom);
  if (!progress) return null;
  // ONNX Runtime has no Intel Mac binding, so core never loads the models there.
  const unsupported = progress.modelsSupported === false;
  const done = i18n.number(progress.done),
    queued = i18n.number(progress.queued),
    running = i18n.number(progress.running),
    failed = i18n.number(progress.failed);
  return (
    <SettingsGroup
      title={<Trans>On-device indexing</Trans>}
      footer={
        <Trans>Runs while idle. Scanned PDF pages, audio and video are not indexed yet.</Trans>
      }
    >
      <SettingsRow
        label={<Trans>Download on-device models, ~226 MB</Trans>}
        hint={
          unsupported ? (
            <Trans>
              Semantic search needs a Mac with Apple silicon. Full-text search still works.
            </Trans>
          ) : (
            <Trans>
              Images and PDF text are processed on this device. No content is sent to a cloud model.
            </Trans>
          )
        }
      >
        <Switch.Root
          className={switchTrack}
          disabled={unsupported}
          checked={!unsupported && (progress.modelsEnabled ?? false)}
          aria-label={t`Download on-device models, ~226 MB`}
          onCheckedChange={(enabled) =>
            models({ payload: { enabled }, reactivityKeys: ["indexing"] })
          }
        >
          <Switch.Thumb className={switchThumb} />
        </Switch.Root>
      </SettingsRow>
      <div className="space-y-1 px-3 py-2">
        {progress.modelsEnabled && !progress.semanticAvailable && (
          <p>
            <Trans>Semantic search is unavailable. Full-text search remains available.</Trans>
          </p>
        )}
        {progress.modelsEnabled && (
          <>
            {progress.models?.kind === "downloading" && (
              <ModelDownload progress={{ models: progress.models }} />
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
            <output aria-live="off" className={`block ${settingsHint}`}>
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
        <output aria-live="off" className={`block ${settingsHint}`}>
          <Trans>
            {done} completed · {queued} queued · {running} running · {failed} failed
          </Trans>
        </output>
      </div>
      <SettingsRow
        label={<Trans>Pause indexing</Trans>}
        hint={
          progress.onBattery ? (
            <Trans>
              On battery: image recognition waits for AC power. PDF text indexing is throttled.
            </Trans>
          ) : undefined
        }
      >
        <Switch.Root
          className={switchTrack}
          checked={progress.paused}
          aria-label={t`Pause indexing`}
          onCheckedChange={(paused) => pause({ payload: { paused }, reactivityKeys: ["indexing"] })}
        >
          <Switch.Thumb className={switchThumb} />
        </Switch.Root>
      </SettingsRow>
    </SettingsGroup>
  );
}

/** The model download bar. The props keep the shape of the progress the message text reads. */
function ModelDownload({ progress }: { progress: { models: { bytes: number; total: number } } }) {
  const { t, i18n } = useLingui();
  return (
    <div>
      <ProgressBar
        value={progress.models.bytes}
        max={progress.models.total}
        aria-label={t`Model download progress`}
        className="mb-1"
      />
      <p>
        <Trans>
          Downloading models:{" "}
          {i18n.number(Math.floor((progress.models.bytes / progress.models.total) * 100))}%
        </Trans>
      </p>
    </div>
  );
}
