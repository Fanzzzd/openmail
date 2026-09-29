import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import {
  Download,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Mail,
} from "lucide-react";
import type { ComponentType } from "react";

import type { Message } from "../../../shared/api";
import { causeText } from "../errors";
import { formatBytes } from "../format";
import { openAttachment, saveAllAttachments, saveAttachment, useRunMail } from "../state/mail";
import type { Notify } from "./Reader";
import { Tip } from "./ui/Tip";

type Icon = ComponentType<{ className?: string }>;

function iconFor(mimeType: string, filename: string): Icon {
  const type = mimeType.toLowerCase();
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (type.startsWith("image/")) return FileImage;
  if (type.startsWith("audio/")) return FileAudio;
  if (type.startsWith("video/")) return FileVideo;
  if (type === "message/rfc822" || ext === "eml") return Mail;
  if (/zip|compressed|tar|gzip|x-7z|rar/.test(type) || /^(zip|rar|7z|gz|tgz|tar)$/.test(ext))
    return FileArchive;
  if (/spreadsheet|excel|csv/.test(type) || /^(xlsx?|csv|numbers)$/.test(ext))
    return FileSpreadsheet;
  if (type.startsWith("text/") || /pdf|word|document|presentation/.test(type)) return FileText;
  return File;
}

/** The message's attachments: click opens one, the arrow saves it, Save All saves every one. */
export function Attachments({ message: m, notify }: { message: Message; notify: Notify }) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const fail = (cause: Parameters<typeof causeText>[1]) => {
    const reason = causeText(i18n, cause);
    notify({ text: t`Couldn't get the attachment: ${reason}`, tone: "error" });
  };

  const open = (index: number) =>
    run(
      openAttachment(m.id, index).pipe(
        Effect.catchCause((cause) => Effect.sync(() => fail(cause))),
      ),
    );
  const save = (index: number) =>
    run(
      saveAttachment(m.id, index).pipe(
        Effect.matchCause({
          onFailure: fail,
          onSuccess: (saved) => {
            if (saved) notify({ text: t`Saved` });
          },
        }),
      ),
    );
  const saveAll = () =>
    run(
      saveAllAttachments(m.id).pipe(
        Effect.matchCause({
          onFailure: fail,
          onSuccess: (count) => {
            if (count > 0) {
              notify({
                text: plural(count, { one: "Saved # attachment", other: "Saved # attachments" }),
              });
            }
          },
        }),
      ),
    );

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
      {m.attachments.map((a, i) => {
        const Icon = iconFor(a.mimeType, a.filename);
        return (
          <span
            key={`${a.filename}-${i}`}
            className="group flex h-8 max-w-72 items-center rounded-md border border-black/10 text-[13px] dark:border-white/10"
          >
            <Tip label={t`Open`}>
              <button
                type="button"
                onClick={() => open(i)}
                className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1.5 pl-2 outline-offset-0 outline-blue-500/60 hover:bg-black/[0.04] focus-visible:outline-[3px] dark:hover:bg-white/5"
              >
                <Icon className="size-4 shrink-0 text-neutral-400" />
                <span className="min-w-0 truncate">{a.filename}</span>
                <span className="shrink-0 text-neutral-400">{formatBytes(a.size)}</span>
              </button>
            </Tip>
            <Tip label={t`Save…`}>
              <button
                type="button"
                aria-label={t`Save ${a.filename}`}
                onClick={() => save(i)}
                className="flex h-full items-center rounded-r-md border-l border-black/10 px-1.5 text-neutral-400 outline-offset-0 outline-blue-500/60 hover:bg-black/[0.04] hover:text-neutral-700 focus-visible:outline-[3px] dark:border-white/10 dark:hover:bg-white/5 dark:hover:text-neutral-200"
              >
                <Download className="size-3.5" />
              </button>
            </Tip>
          </span>
        );
      })}
      {m.attachments.length > 1 && (
        <button
          type="button"
          onClick={saveAll}
          className="h-8 rounded-md px-2 text-[13px] font-medium text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
        >
          <Trans>Save all…</Trans>
        </button>
      )}
    </div>
  );
}
