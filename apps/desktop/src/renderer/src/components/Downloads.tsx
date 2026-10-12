import { Popover } from "@base-ui/react/popover";
import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import {
  ArrowDownToLine,
  ExternalLink,
  FolderSearch,
  RotateCw,
  ShieldAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  activeDownload,
  downloadsProgress,
  type DownloadCommand,
  type DownloadItem,
} from "../../../shared/downloads";
import { causeText } from "../errors";
import { formatBytes } from "../format";
import { downloadsAtom, downloadsFeedAtom, downloadsOpenAtom } from "../state/downloads";
import { useRunMail, withMail } from "../state/mail";
import { FileIcon } from "./file-icon";
import { ProgressBar, ProgressRing } from "./ui/Progress";
import { popupMotion } from "./ui/styles";
import { Tip } from "./ui/Tip";

const rowButton =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-a11y-muted outline-offset-0 outline-a11y-focus transition-colors duration-100 hover:bg-black/[0.06] hover:text-neutral-900 focus-visible:outline-2 active:bg-black/10 motion-reduce:transition-none dark:hover:bg-white/10 dark:hover:text-neutral-100 dark:active:bg-white/15";

/** An icon button on a download row: the tip names the action, the label names the file too. */
function RowAction({
  tip,
  label,
  icon: Icon,
  onClick,
}: {
  tip: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <Tip label={tip}>
      <button type="button" aria-label={label} className={rowButton} onClick={onClick}>
        <Icon className="size-3.5" />
      </button>
    </Tip>
  );
}

function useStatusText() {
  const { t, i18n } = useLingui();
  return (item: DownloadItem) => {
    const size = formatBytes(item.size, i18n.locale);
    if (item.status === "fetching") return t`Getting the attachment…`;
    if (item.status === "writing") {
      const received = formatBytes(item.received, i18n.locale);
      return t`${received} of ${size}`;
    }
    if (item.status === "failed")
      return item.failure === "write"
        ? t`Couldn't write to the attachment folder`
        : t`Couldn't get the attachment`;
    if (item.failure === "missing") return t`Moved or deleted`;
    return size;
  };
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const status = useStatusText();
  const [error, setError] = useState("");
  const active = activeDownload(item);
  const missing = item.failure === "missing";
  const done = item.status === "done" && !missing;
  const command = (kind: DownloadCommand) => {
    setError("");
    run(
      withMail((call) => call("DownloadAction", { id: item.id, command: kind })).pipe(
        Effect.catchCause((cause) => Effect.sync(() => setError(causeText(i18n, cause)))),
      ),
    );
  };
  const name = item.filename;
  const failed = item.status === "failed" || missing;
  return (
    <li
      aria-label={name}
      className="group relative flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
    >
      <span
        aria-hidden
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
          failed
            ? "bg-red-500/10 text-a11y-danger"
            : "bg-black/[0.05] text-a11y-muted dark:bg-white/10"
        }`}
      >
        <FileIcon filename={item.filename} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        {done && !item.blocked ? (
          <button
            type="button"
            onClick={() => command("open")}
            className="block max-w-full truncate rounded-sm text-left font-medium outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2"
            title={name}
          >
            {name}
          </button>
        ) : (
          <p className="truncate font-medium" title={name}>
            {name}
          </p>
        )}
        {active ? (
          <ProgressBar
            className="mt-1.5"
            aria-label={t`Downloading ${name}`}
            value={item.status === "writing" && item.size > 0 ? item.received : null}
            max={Math.max(item.size, 1)}
          />
        ) : null}
        <p
          className={`mt-0.5 truncate text-[11px] tabular-nums ${failed ? "text-a11y-danger" : "text-a11y-muted"}`}
        >
          {status(item)}
          {done && item.blocked && (
            <span className="ml-1.5 inline-flex items-center gap-1 align-bottom">
              <ShieldAlert aria-hidden className="size-3" />
              <Trans>Open it from Finder</Trans>
            </span>
          )}
        </p>
        {error && <p className="mt-0.5 text-[11px] text-a11y-danger">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {done && !item.blocked && (
          <RowAction
            tip={t`Open`}
            label={t`Open ${name}`}
            icon={ExternalLink}
            onClick={() => command("open")}
          />
        )}
        {done && (
          <RowAction
            tip={t`Show in Finder`}
            label={t`Show ${name} in Finder`}
            icon={FolderSearch}
            onClick={() => command("show")}
          />
        )}
        {failed && (
          <RowAction
            tip={t`Retry`}
            label={t`Retry ${name}`}
            icon={RotateCw}
            onClick={() => command("retry")}
          />
        )}
        {!active && (
          <RowAction
            tip={t`Remove from list`}
            label={t`Remove ${name} from list`}
            icon={X}
            onClick={() => command("remove")}
          />
        )}
      </div>
    </li>
  );
}

/** What finished since the last render, for the screen reader announcement. */
function useFinishedAnnouncement(items: readonly DownloadItem[]) {
  const { t } = useLingui();
  const previous = useRef(new Map<string, DownloadItem["status"]>());
  const [text, setText] = useState("");
  useEffect(() => {
    const finished = items.filter((item) => {
      const before = previous.current.get(item.id);
      return (before === "fetching" || before === "writing") && !activeDownload(item);
    });
    previous.current = new Map(items.map((item) => [item.id, item.status]));
    const last = finished.at(-1);
    if (!last) return;
    const name = last.filename;
    setText(last.status === "done" ? t`Downloaded ${name}` : t`Couldn't download ${name}`);
  }, [items, t]);
  return text;
}

/** The toolbar button and panel for saved attachments; a ring shows progress while saving. */
export function Downloads() {
  const { t } = useLingui();
  const run = useRunMail();
  useAtomMount(downloadsFeedAtom);
  const items = useAtomValue(downloadsAtom);
  const [open, setOpen] = useAtom(downloadsOpenAtom);
  const automatic = useRef(false);
  const announcement = useFinishedAnnouncement(items);
  const active = items.filter(activeDownload).length;
  const progress = downloadsProgress(items);
  useEffect(() => {
    if (open) automatic.current = document.activeElement?.closest("[data-downloads]") == null;
  }, [open]);
  const label = active
    ? plural(active, { one: "Downloads (# in progress)", other: "Downloads (# in progress)" })
    : t`Downloads`;
  const finished = items.length - active;
  return (
    <>
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tip label={t`Downloads`}>
          <Popover.Trigger
            data-downloads
            aria-label={label}
            className={`no-drag relative flex size-7 items-center justify-center rounded-md ${active > 0 ? "bg-blue-500/10 text-a11y-accent" : "text-a11y-muted"} outline-offset-1 outline-a11y-focus transition-colors duration-100 hover:bg-black/5 hover:text-neutral-900 focus-visible:outline-2 active:bg-black/10 data-popup-open:bg-black/[0.07] data-popup-open:text-neutral-900 motion-reduce:transition-none dark:hover:bg-white/10 dark:hover:text-neutral-100 dark:data-popup-open:bg-white/10 dark:data-popup-open:text-neutral-100`}
          >
            {active > 0 && <ProgressRing value={progress} className="absolute size-6" />}
            <ArrowDownToLine className={active > 0 ? "size-3" : "size-4"} />
          </Popover.Trigger>
        </Tip>
        <Popover.Portal>
          <Popover.Positioner sideOffset={6} align="end" className="z-[60] outline-none">
            <Popover.Popup
              initialFocus={() => !automatic.current}
              className={`no-drag flex max-h-[min(28rem,var(--available-height))] w-[22rem] max-w-(--available-width) flex-col overflow-hidden rounded-xl bg-white/95 text-[13px] text-neutral-900 shadow-[0_12px_32px_rgb(0_0_0/0.18)] ring-1 ring-black/10 outline-none backdrop-blur-xl dark:bg-[#2c2c2e]/95 dark:text-neutral-100 dark:shadow-[0_12px_32px_rgb(0_0_0/0.5)] dark:ring-white/10 ${popupMotion}`}
            >
              <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-4 pt-3 pb-2.5 dark:border-white/10">
                <Popover.Title className="text-[13px] font-semibold">
                  <Trans>Downloads</Trans>
                </Popover.Title>
                {items.length > 0 && (
                  <button
                    type="button"
                    disabled={finished === 0}
                    onClick={() => run(withMail((call) => call("ClearDownloads", undefined)))}
                    className="rounded-md px-2 py-0.5 text-[12px] font-medium text-a11y-accent outline-offset-1 outline-a11y-focus hover:bg-blue-500/10 focus-visible:outline-2 active:bg-blue-500/15 disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Trans>Clear</Trans>
                  </button>
                )}
              </div>
              {items.length ? (
                <ul aria-label={t`Downloads`} className="min-h-0 flex-1 overflow-y-auto p-1.5">
                  {items.map((item) => (
                    <DownloadRow key={item.id} item={item} />
                  ))}
                </ul>
              ) : (
                <div className="flex flex-col items-center gap-1.5 px-6 py-8 text-center">
                  <span
                    aria-hidden
                    className="mb-1 flex size-10 items-center justify-center rounded-full bg-black/[0.05] text-a11y-muted dark:bg-white/10"
                  >
                    <ArrowDownToLine className="size-5" />
                  </span>
                  <p className="font-medium">
                    <Trans>No downloads</Trans>
                  </p>
                  <p className="text-[12px] text-a11y-muted">
                    <Trans>Attachments you save appear here.</Trans>
                  </p>
                </div>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}
