import {
  attachmentImportKind,
  attachmentFilename,
  DEFAULT_PREFS,
  EMPTY_QUOTE_HISTORY,
  type AttachmentAction,
  type SearchMatch,
  type EmbeddedMessage,
  type ReaderAttachment,
} from "@openmail/core/schema";
import { attachmentMatches, MatchedText, SearchSnippet } from "./SearchSnippet";
import { AttachmentImportDialog } from "./AttachmentImportDialog";
import { constVoid } from "effect/Function";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Download,
  Eye,
  MoreHorizontal,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Mail,
} from "lucide-react";
import { useEffect, useMemo, useState, useId, useRef, type ComponentType } from "react";
import type { Message } from "../../../shared/api";
import { causeText } from "../errors";
import { formatBytes } from "../format";
import { useRunMail, withMail } from "../state/mail";
import { prefsAtom } from "../state/queries";
import type { Notify } from "./Reader";
import { LazyEmailFrame } from "./MessageBodyShell";
import { DropdownMenu, MenuItem } from "./ui/Menu";
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

export function Attachments({
  message,
  notify,
  matches = [],
}: {
  message: Message;
  notify: Notify;
  matches?: readonly SearchMatch[];
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const [files, setFiles] = useState<readonly ReaderAttachment[]>([]);
  useEffect(() => {
    let active = true;
    run(
      withMail((call) => call("ReaderAttachments", { messageId: message.id })).pipe(
        Effect.matchCause({
          onSuccess: (value) => {
            if (active) setFiles(value);
          },
          onFailure: (cause) => {
            if (active) {
              setFiles(
                message.attachments.map((file, index) => ({
                  ...file,
                  filename: attachmentFilename(file.filename),
                  path: [index],
                  embedded: file.mimeType === "message/rfc822" || /\.eml$/i.test(file.filename),
                  decodeError: false,
                })),
              );
              const reason = causeText(i18n, cause);
              notify({ text: t`Couldn't get the attachment: ${reason}`, tone: "error" });
            }
          },
        }),
      ),
    );
    return () => {
      active = false;
    };
  }, [message.id, message.attachments, run, notify, i18n, t]);
  return (
    <AttachmentList
      key={message.id}
      messageId={message.id}
      files={files}
      notify={notify}
      matches={matches}
    />
  );
}

const buttonClass =
  "h-8 rounded-md px-2 text-[13px] font-medium text-a11y-accent hover:bg-blue-500/10 disabled:opacity-40 dark:text-blue-400";
const pathKey = (path: readonly number[]) => path.join(".");

/** File selections are scoped to one message/container, including duplicate names. */
export function AttachmentList({
  messageId,
  files,
  notify,
  matches = [],
}: {
  messageId: string;
  files: readonly ReaderAttachment[];
  notify: Notify;
  matches?: readonly SearchMatch[];
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const listId = useId();
  const pending = useRef<{ key: string; token: symbol } | null>(null);
  const expires = useRef(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [imported, setImported] = useState<ReaderAttachment | null>(null);
  const [embedded, setEmbedded] = useState<ReaderAttachment | null>(null);
  const [share, setShare] = useState(false);
  const [ready, setReady] = useState("");
  const chosen = useMemo(
    () => files.filter((file) => selected.has(pathKey(file.path))),
    [files, selected],
  );
  const selectionKey = JSON.stringify(chosen.map((file) => file.path));

  const fail = (cause: Parameters<typeof causeText>[1]) => {
    const reason = causeText(i18n, cause);
    notify({ text: t`Couldn't get the attachment: ${reason}`, tone: "error" });
  };
  useEffect(() => {
    let active = true;
    run(
      withMail((call) => call("AttachmentCapabilities", undefined)).pipe(
        Effect.matchCause({
          onFailure: constVoid,
          onSuccess: (caps) => {
            if (active) setShare(caps.share);
          },
        }),
      ),
    );
    return () => {
      active = false;
    };
  }, [run]);
  useEffect(
    () => () => {
      pending.current = null;
      run(
        withMail((call) => call("ReleaseAttachmentDrag", { messageId, listId })).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Attachment drag cleanup failed", cause)),
        ),
      );
    },
    [messageId, listId, run],
  );
  const prepare = () => {
    if (
      !chosen.length ||
      (ready === selectionKey && expires.current > Date.now()) ||
      pending.current?.key === selectionKey
    )
      return;
    setReady("");
    const token = Symbol();
    pending.current = { key: selectionKey, token };
    run(
      withMail((call) =>
        call("PrepareAttachmentDrag", {
          messageId,
          listId,
          paths: chosen.map((file) => file.path),
        }),
      ).pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            if (pending.current?.token === token) {
              pending.current = null;
              setReady("");
              fail(cause);
            }
          },
          onSuccess: () => {
            if (pending.current?.token === token) {
              pending.current = null;
              expires.current = Date.now() + 25 * 60 * 1000;
              setReady(selectionKey);
            }
          },
        }),
      ),
    );
  };
  const action = (kind: AttachmentAction, targets: readonly ReaderAttachment[]) => {
    if (!targets.length) return;
    if (kind === "open" || kind === "preview") {
      const special = targets.find((file) => attachmentImportKind(file) !== null);
      if (special) {
        setImported(special);
        return;
      }
    }
    run(
      withMail((call) =>
        call("AttachmentAction", {
          messageId,
          listId,
          paths: targets.map((file) => file.path),
          action: kind,
        }),
      ).pipe(
        Effect.matchCause({
          onFailure: fail,
          onSuccess: ({ count, failures }) => {
            if (failures.length) {
              const names = failures
                .map(
                  (failure) =>
                    targets.find((file) => pathKey(file.path) === pathKey(failure.path))
                      ?.filename ?? failure.filename,
                )
                .join(", ");
              notify({
                text: t`Saved ${count} attachments. Couldn't save: ${names}`,
                tone: "error",
              });
              return;
            }
            if (kind === "save" && count)
              notify({
                text: plural(count, { one: "Saved # attachment", other: "Saved # attachments" }),
              });
            if (kind === "copy" && count) notify({ text: t`Copied` });
          },
        }),
      ),
    );
  };
  const toggle = (file: ReaderAttachment, range: boolean) => {
    setReady("");
    pending.current = null;
    setSelected((current) => {
      const next = new Set(current);
      const key = pathKey(file.path);
      if (range) {
        const anchor = files.findIndex((item) => current.has(pathKey(item.path)));
        const target = files.indexOf(file);
        for (const item of files.slice(
          Math.min(anchor < 0 ? target : anchor, target),
          Math.max(anchor, target) + 1,
        ))
          next.add(pathKey(item.path));
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div className="pt-3">
      {imported && (
        <AttachmentImportDialog
          key={pathKey(imported.path)}
          messageId={messageId}
          file={imported}
          onClose={() => setImported(null)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {files.map((file) => {
          const Icon = iconFor(file.mimeType, file.filename);
          // The file's name or its extracted text matched the search.
          const atFile = (match: SearchMatch) =>
            (match.source === "attachment" || match.source === "filename") &&
            match.attachmentIndex === file.path[0] &&
            file.path.length === 1;
          const hit = matches.find(atFile);
          const nameHit = matches.find((match) => match.source === "filename" && atFile(match));
          return (
            <span
              key={pathKey(file.path)}
              className={`flex h-8 max-w-[min(20rem,100%)] items-center rounded-md border text-[13px] ${hit ? "border-amber-500 bg-amber-500/10" : "border-black/10 dark:border-white/10"}`}
              title={hit ? hit.snippet : undefined}
            >
              <input
                type="checkbox"
                aria-label={t`Select ${file.filename}`}
                checked={selected.has(pathKey(file.path))}
                onChange={(event) =>
                  toggle(
                    file,
                    event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey,
                  )
                }
                className="ml-2"
              />
              <button
                type="button"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) {
                    toggle(file, event.shiftKey);
                    return;
                  }
                  if (file.embedded)
                    setEmbedded((current) =>
                      pathKey(current?.path ?? []) === pathKey(file.path) ? null : file,
                    );
                  else action("open", [file]);
                }}
                className="flex h-full min-w-0 items-center gap-1.5 px-2 hover:bg-black/[0.04] dark:hover:bg-white/5"
              >
                <Icon className="size-4 shrink-0 text-a11y-muted" />
                <span className="min-w-0 truncate">
                  <MatchedText text={file.filename} match={nameHit} />
                </span>
                {hit && (
                  <span className="sr-only">
                    {t({
                      message: "Matches the search",
                      comment: "Announced after an attachment name whose name or text matched.",
                    })}
                  </span>
                )}
                <span className="shrink-0 text-a11y-muted">
                  {formatBytes(file.size, i18n.locale)}
                </span>
              </button>
              <Tip label={t`Quick Look`}>
                <button
                  type="button"
                  aria-label={t`Preview ${file.filename}`}
                  onClick={() => action("preview", [file])}
                  className="px-1.5 text-a11y-muted"
                >
                  <Eye className="size-3.5" />
                </button>
              </Tip>
              <Tip label={t`Save…`}>
                <button
                  type="button"
                  aria-label={t`Save ${file.filename}`}
                  onClick={() => action("save", [file])}
                  className="px-1.5 text-a11y-muted"
                >
                  <Download className="size-3.5" />
                </button>
              </Tip>
              <DropdownMenu
                trigger={
                  <button
                    type="button"
                    aria-label={t`Actions for ${file.filename}`}
                    className="px-1.5 text-a11y-muted"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                }
              >
                <MenuItem onClick={() => action("open", [file])}>
                  <Trans>Open</Trans>
                </MenuItem>
                {share && (
                  <MenuItem onClick={() => action("openWith", [file])}>
                    <Trans>Open With…</Trans>
                  </MenuItem>
                )}
                <MenuItem onClick={() => action("preview", [file])}>
                  <Trans>Quick Look</Trans>
                </MenuItem>
                <MenuItem onClick={() => action("copy", [file])}>
                  <Trans>Copy</Trans>
                </MenuItem>
                {share && (
                  <MenuItem onClick={() => action("share", [file])}>
                    <Trans>Share…</Trans>
                  </MenuItem>
                )}
              </DropdownMenu>
            </span>
          );
        })}
        {files.length > 1 && (
          <button type="button" onClick={() => action("save", files)} className={buttonClass}>
            <Trans>Save all…</Trans>
          </button>
        )}
      </div>
      {attachmentMatches(matches)
        .slice(0, 3)
        .map((match, index) => (
          <p key={index} className="mt-2 text-[12px] text-a11y-muted">
            <SearchSnippet match={match} />
          </p>
        ))}
      {files.some((file) => file.decodeError) && (
        <p className="mt-2 text-[12px] text-a11y-muted">
          <Trans>Could not decode winmail.dat. You can save the original file.</Trans>
        </p>
      )}
      {chosen.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <button type="button" onClick={() => action("save", chosen)} className={buttonClass}>
            <Trans>Save selected…</Trans>
          </button>
          <button type="button" onClick={() => action("copy", chosen)} className={buttonClass}>
            <Trans>Copy selected</Trans>
          </button>
          {share && (
            <button type="button" onClick={() => action("share", chosen)} className={buttonClass}>
              <Trans>Share selected…</Trans>
            </button>
          )}
          <button
            type="button"
            onPointerDown={prepare}
            onPointerEnter={prepare}
            onFocus={prepare}
            aria-disabled={ready !== selectionKey}
            draggable={ready === selectionKey}
            onDragStart={(event) => {
              event.preventDefault();
              if (ready === selectionKey) action("drag", chosen);
            }}
            className={buttonClass}
          >
            <Trans>Drag selected to Finder</Trans>
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className={buttonClass}>
            <Trans>Clear selection</Trans>
          </button>
        </div>
      )}
      {embedded && (
        <EmbeddedReader
          key={pathKey(embedded.path)}
          messageId={messageId}
          file={embedded}
          notify={notify}
        />
      )}
    </div>
  );
}

function EmbeddedReader({
  messageId,
  file,
  notify,
}: {
  messageId: string;
  file: ReaderAttachment;
  notify: Notify;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const [message, setMessage] = useState<EmbeddedMessage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    run(
      withMail((call) => call("EmbeddedMessage", { messageId, path: file.path })).pipe(
        Effect.matchCause({
          onSuccess: (value) => {
            if (active) setMessage(value);
          },
          onFailure: (cause) => {
            if (active) {
              setFailed(true);
              const reason = causeText(i18n, cause);
              notify({ text: t`Couldn't get the attachment: ${reason}`, tone: "error" });
            }
          },
        }),
      ),
    );
    return () => {
      active = false;
    };
  }, [messageId, file.path, run, i18n, t, notify]);
  if (!message)
    return (
      <p className="mt-2 text-a11y-muted">
        {failed ? t`Could not read attached message.` : t`Loading attached message…`}
      </p>
    );
  return (
    <section
      aria-label={t`Attached message`}
      className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
    >
      <h4 className="font-semibold">{message.subject || t`(No subject)`}</h4>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-[12px] break-all">
        <dt>
          <Trans>From</Trans>
        </dt>
        <dd>{message.from}</dd>
        <dt>
          <Trans>To</Trans>
        </dt>
        <dd>{message.to}</dd>
        {message.cc && (
          <>
            <dt>
              <Trans>Cc</Trans>
            </dt>
            <dd>{message.cc}</dd>
          </>
        )}
        <dt>
          <Trans>Date</Trans>
        </dt>
        <dd>{message.date}</dd>
      </dl>
      <LazyEmailFrame
        html={message.bodyHtml}
        remote={false}
        background="light"
        zoom={prefs.readerZoom}
        onActivate={constVoid}
        previous={EMPTY_QUOTE_HISTORY}
        findQuery=""
        findIndex={0}
        onMatches={undefined}
      />
      {message.attachments.length > 0 && file.path.length < 8 && (
        <AttachmentList messageId={messageId} files={message.attachments} notify={notify} />
      )}
    </section>
  );
}
