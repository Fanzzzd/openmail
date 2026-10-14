import { Trans, useLingui } from "@lingui/react/macro";
import { useShortcutText } from "../../i18n/use-shortcut-text";
import {
  AppWindow,
  ChevronDown,
  Code,
  FileDown,
  Forward,
  Images,
  Moon,
  MoreHorizontal,
  Printer,
  Reply,
  ReplyAll,
  Star,
  Sun,
} from "lucide-react";
import { Tip } from "../../ui/Tip";
import { buttonSecondary, touchIcon } from "../../ui/styles";
import type { Message } from "../../../../shared/api";
import {
  DEFAULT_PREFS,
  addressDomain,
  senderName,
  senderSpoofed,
  type ReaderZoom,
  type SearchMatch,
} from "@openmail/core/schema";
import { DropdownMenu, MenuItem, MenuSeparator } from "../../ui/Menu";
import { AppleContactActions } from "../contacts";
import { displayName, letterAvatarColor, threadDate } from "../../lib/format";
import { SearchHitsContext, type SearchHits } from "../search";
import type { Notify } from "./notify";
import type { modifyMessages } from "../../state/mail";
import { useDarkMode } from "./use-dark-mode";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { messageBackgroundAtom } from "../../state/ui";
import { setImageSenderAtom } from "../../state/mutations";
import type { MessageBackground } from "./body/frame-surface";
import { Keys } from "../../state/keys";
import { UnsubscribeButton } from "./UnsubscribeButton";
import { InviteBanner, MeetingLinks } from "../calendar";
import { Attachments } from "./attachments/Attachments";
import { LazyMessageBody } from "./body/MessageBodyShell";
import { useEffect, useRef, useState } from "react";
import { AsyncResult, Atom } from "effect/reactivity";
import { contactPhotoAtom, prefsAtom } from "../../state/queries";

/**
 * Reply, Reply all and Forward under the last message, as in Apple Mail and Mimestream. The
 * toolbar can fold its copies into the menu; this bar stays at every width.
 */
export function ReplyBar({
  onCompose,
}: {
  onCompose: (mode: "reply" | "replyAll" | "forward", attachment?: boolean) => void;
}) {
  const { t } = useLingui();
  const shortcut = useShortcutText();
  const actions = [
    { mode: "reply", icon: Reply, label: t`Reply` },
    { mode: "replyAll", icon: ReplyAll, label: t`Reply all` },
    { mode: "forward", icon: Forward, label: t`Forward` },
  ] as const;
  return (
    <fieldset
      aria-label={t`Reply to this conversation`}
      className="mt-4 flex min-w-0 flex-wrap gap-2 border-0 border-t border-separator p-0 pt-4"
    >
      {actions.map(({ mode, icon: Icon, label }) => (
        <Tip key={mode} label={label} shortcut={shortcut(mode)}>
          <button type="button" className={buttonSecondary} onClick={() => onCompose(mode)}>
            <Icon aria-hidden className="size-4" />
            {label}
          </button>
        </Tip>
      ))}
    </fieldset>
  );
}

export function MessageHead({
  message: m,
  onSearchSender,
}: {
  message: Message;
  onSearchSender?: (() => void) | undefined;
}) {
  const { t, i18n } = useLingui();
  const shortcut = useShortcutText();
  const label = senderName(m.from);
  // Names wrap between words; an unbroken run breaks only when it would overflow.
  const name = (
    <span data-sender-name className="line-clamp-2 break-words" title={label}>
      {label}
    </span>
  );
  return (
    <span className="block">
      <span className="flex flex-col @min-[520px]/message:flex-row @min-[520px]/message:items-baseline @min-[520px]/message:gap-2">
        <span className="min-w-0 text-callout font-semibold @min-[520px]/message:flex-1">
          {onSearchSender ? (
            <DropdownMenu
              trigger={
                <button type="button" className="block max-w-full text-left hover:text-blue-600">
                  {name}
                </button>
              }
            >
              <MenuItem
                onClick={onSearchSender}
                shortcut={shortcut("searchSender")}
              >{t`Search messages from this sender`}</MenuItem>
              <AppleContactActions address={m.from} />
            </DropdownMenu>
          ) : (
            name
          )}
        </span>
        <span className="flex min-w-0 items-baseline gap-x-2 text-footnote @max-[420px]/message:flex-wrap @min-[520px]/message:max-w-[65%]">
          {label !== m.from.address && (
            <span data-sender-address className="min-w-0 truncate" title={m.from.address}>
              {m.from.address}
            </span>
          )}
          {m.isStarred && (
            <Star className="size-3.5 shrink-0 self-center fill-amber-600 text-amber-600 dark:fill-amber-400 dark:text-amber-400" />
          )}
          <span
            data-message-date
            className="ml-auto shrink-0 text-a11y-muted @max-[420px]/message:ml-0 @max-[420px]/message:basis-full @min-[520px]/message:ml-0"
          >
            {threadDate(m.date, i18n)}
          </span>
        </span>
      </span>
      {m.security?.dmarc === "fail" && (
        <span
          role="alert"
          className="block text-footnote text-a11y-danger"
        >{t`Sender authentication failed (DMARC)`}</span>
      )}
      {senderSpoofed(m.from) && (
        <span
          role="alert"
          className="block text-footnote text-a11y-danger"
        >{t`The sender name contains a different email address.`}</span>
      )}
    </span>
  );
}

/** The active message's left edge: 3:1 against the reader in both themes. */
export const ACTIVE_MESSAGE_BORDER = "border-blue-600 dark:border-blue-400";

export function Expanded({
  message: m,
  searchMatches,
  searchHits,
  zoom,
  defaultBackground,
  onZoomKey,
  remote,
  imageNotice,
  onLoadImages,
  imageSenders,
  notify,
  onShowOriginal,
  onPrint,
  onCollapse,
  onEditDraft,
  onActivate,
  onSave,
  onSearchSender,
  onOpenWeb,
  onShare,
  webLabel,
  active,
  onMessageOp,
  onUnreadFrom,
  onOpenSingle,
  thread,
  findQuery,
  findIndex,
  onMatches,
}: {
  message: Message;
  searchMatches: readonly SearchMatch[];
  searchHits: SearchHits;
  zoom: ReaderZoom;
  defaultBackground: "light" | "theme";
  onZoomKey: (e: KeyboardEvent) => void;
  /** Remote images may load. */
  remote: boolean;
  /** Show the conversation's remote image notice on this message. */
  imageNotice: boolean;
  onLoadImages: () => void;
  imageSenders: readonly string[];
  notify: Notify;
  onShowOriginal: () => void;
  onPrint: ((pdf: boolean) => void) | undefined;
  onCollapse?: (() => void) | undefined;
  onEditDraft?: (() => void) | undefined;
  onActivate: () => void;
  onSave: (() => void) | undefined;
  onSearchSender: () => void;
  onShare: ((kind: "message" | "thread" | "web") => void) | undefined;
  onOpenWeb: (() => void) | undefined;
  webLabel: string;
  active: boolean;
  onMessageOp: (op: Parameters<typeof modifyMessages>[1]) => void;
  onUnreadFrom: () => void;
  onOpenSingle: (() => void) | undefined;
  /** Every stored message of the thread, for folding repeated quotes. */
  thread: readonly Message[];
  findQuery: string;
  findIndex: number;
  onMatches: ((count: number) => void) | undefined;
}) {
  const { t, i18n } = useLingui();
  const shortcut = useShortcutText();
  const dark = useDarkMode();
  const [override, setOverride] = useAtom(messageBackgroundAtom(m.id));
  const setImageSender = useAtomSet(setImageSenderAtom);

  const address = m.from.address.toLowerCase();
  const domain = addressDomain(address);
  const bySender = imageSenders.includes(address);
  const byDomain = domain !== "" && imageSenders.includes(domain);
  const authenticated = m.security?.dmarc === "pass";

  const background: MessageBackground =
    override ?? (defaultBackground === "theme" && dark ? "dark" : "light");
  const toggleBackground = () => setOverride(background === "dark" ? "light" : "dark");

  const allow = (entry: string, value: boolean) =>
    setImageSender({
      payload: { entry, allowed: value },
      reactivityKeys: [Keys.imageSenders],
    });
  const alwaysLoad = address && authenticated ? () => allow(address, true) : undefined;

  const separator = t({ message: ", ", comment: "Separator between list items" });
  const sender = displayName(m.from);
  const sent = threadDate(m.date, i18n);
  const to = m.to.map(displayName).join(separator) || "—";
  const cc = m.cc.map(displayName).join(separator);
  return (
    <article
      data-message-id={m.id}
      onMouseDownCapture={onActivate}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isTrusted) onActivate();
      }}
      aria-label={
        active ? t`Selected message from ${sender}, ${sent}` : t`Message from ${sender}, ${sent}`
      }
      className={`@container/message py-3 ${active ? `border-l-2 ${ACTIVE_MESSAGE_BORDER} pl-2` : ""}`}
    >
      {/* The thread's heading has the subject; each message is found by sender and time. */}
      <h3 className="sr-only">{t`${sender}, ${sent}`}</h3>
      {onEditDraft && (
        <div className="mb-2 flex items-center gap-2 rounded-control bg-red-500/[0.06] px-3 py-1.5 text-body">
          <span className="flex-1 text-a11y-danger dark:text-red-400">
            <Trans>Draft</Trans>
          </span>
          <button
            type="button"
            onClick={onEditDraft}
            className="h-6 rounded px-2 font-medium text-a11y-accent hover:bg-blue-500/10 dark:text-blue-400"
          >
            <Trans>Continue editing</Trans>
          </button>
        </div>
      )}
      <div className="flex gap-1">
        <div className="flex min-w-0 flex-1 gap-3 text-left select-text">
          <Avatar message={m} />
          {/* A readable measure: the header stops near 75 characters in a wide window. */}
          <span className="min-w-0 flex-1 max-w-[75ch]">
            <MessageHead message={m} onSearchSender={onSearchSender} />
            <span
              className="mt-0.5 block truncate text-body text-a11y-muted"
              title={[...m.to, ...m.cc].map((a) => a.address).join(separator)}
            >
              <Trans>To: {to}</Trans>
              {m.cc.length > 0 && (
                <>
                  {"　"}
                  <Trans>Cc: {cc}</Trans>
                </>
              )}
            </span>
          </span>
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t`Collapse message`}
            aria-expanded
            className="size-7 shrink-0 p-1.5 text-a11y-muted"
          >
            <ChevronDown className="size-4" />
          </button>
        )}
        <DropdownMenu
          trigger={
            <button
              type="button"
              aria-label={t`Message actions`}
              className={`size-7 shrink-0 self-start rounded-control p-1.5 ${touchIcon} text-a11y-muted outline-offset-0 outline-a11y-focus hover:bg-fill-hover hover:text-neutral-800 focus-visible:outline-[3px] data-popup-open:bg-fill-pressed dark:hover:text-neutral-100`}
            >
              <MoreHorizontal className="size-4" />
            </button>
          }
        >
          <MenuItem onClick={() => onMessageOp({ kind: "archive" })}>{t`Archive message`}</MenuItem>
          <MenuItem
            onClick={() => onMessageOp({ kind: "trash" })}
          >{t`Move message to Trash`}</MenuItem>
          <MenuItem onClick={() => onMessageOp({ kind: "star", value: !m.isStarred })}>
            {m.isStarred ? t`Unstar message` : t`Star message`}
          </MenuItem>
          <MenuItem
            onClick={() => onMessageOp({ kind: "read", value: false })}
          >{t`Mark message unread`}</MenuItem>
          <MenuItem onClick={onUnreadFrom}>{t`Mark unread from this message`}</MenuItem>
          {onOpenSingle && (
            <MenuItem
              icon={AppWindow}
              onClick={onOpenSingle}
            >{t`Open only this message in a new window`}</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            icon={background === "dark" ? Sun : Moon}
            shortcut={shortcut("toggleMessageBackground")}
            onClick={toggleBackground}
          >
            {background === "dark" ? t`Light background` : t`Dark background`}
          </MenuItem>
          <MenuItem icon={Code} shortcut={shortcut("showOriginal")} onClick={onShowOriginal}>
            {t`Show original`}
          </MenuItem>
          {onSave && (
            <MenuItem
              icon={FileDown}
              onClick={onSave}
              shortcut={shortcut("saveMessage")}
            >{t`Save message as EML…`}</MenuItem>
          )}
          <MenuItem
            onClick={onSearchSender}
            shortcut={shortcut("searchSender")}
          >{t`Search messages from this sender`}</MenuItem>
          {onShare && (
            <>
              <MenuItem onClick={() => onShare("message")}>{t`Send message link to…`}</MenuItem>
              <MenuItem onClick={() => onShare("thread")}>{t`Send conversation link to…`}</MenuItem>
              {onOpenWeb && (
                <MenuItem onClick={() => onShare("web")}>{t`Send webmail link to…`}</MenuItem>
              )}
            </>
          )}
          {onOpenWeb && (
            <MenuItem onClick={onOpenWeb} shortcut={shortcut("openMessageWeb")}>
              {webLabel}
            </MenuItem>
          )}
          {onPrint && (
            <>
              <MenuItem icon={Printer} onClick={() => onPrint(false)}>
                {t`Print message…`}
              </MenuItem>
              <MenuItem icon={FileDown} onClick={() => onPrint(true)}>
                {t`Save message as PDF…`}
              </MenuItem>
            </>
          )}
          {address && authenticated && (
            <>
              <MenuSeparator />
              <MenuItem icon={Images} onClick={() => allow(address, !bySender)}>
                {bySender
                  ? t`Stop loading images from ${address}`
                  : t`Always load images from ${address}`}
              </MenuItem>
              {domain && (
                <MenuItem icon={Images} onClick={() => allow(domain, !byDomain)}>
                  {byDomain
                    ? t`Stop loading images from ${domain}`
                    : t`Always load images from ${domain}`}
                </MenuItem>
              )}
            </>
          )}
        </DropdownMenu>
      </div>

      <UnsubscribeButton message={m} />
      <MeetingLinks sources={[m.bodyText, m.bodyHtml]} />
      <InviteBanner message={m} />

      {m.attachments.length > 0 && (
        <Attachments message={m} notify={notify} matches={searchMatches} />
      )}

      <SearchHitsContext value={searchHits}>
        <LazyMessageBody
          message={m}
          thread={thread}
          remote={remote}
          imageNotice={imageNotice}
          onLoadImages={onLoadImages}
          onAlwaysLoad={alwaysLoad}
          background={background}
          zoom={zoom}
          onZoomKey={onZoomKey}
          onActivate={onActivate}
          findQuery={findQuery}
          findIndex={findIndex}
          onMatches={onMatches}
        />
      </SearchHitsContext>
    </article>
  );
}

/** Mount the live region empty before announcing a newly opened thread. */
export function SelectedMessageAnnouncement({ message }: { message: Message | undefined }) {
  const { t } = useLingui();
  const sender = message ? displayName(message.from) : "";
  const subject = message?.subject || t`(No subject)`;
  const text = message ? t`Selected message: ${sender}, ${subject}` : "";
  const region = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (region.current) region.current.textContent = text;
  }, [text]);
  return <output ref={region} aria-live="polite" aria-atomic="true" className="sr-only" />;
}

const noPhoto = Atom.make(AsyncResult.success(null));
export function Avatar({ message: m }: { message: Message }) {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const photo = AsyncResult.getOrElse(
    useAtomValue(prefs.contactPhotos ? contactPhotoAtom(m.accountId, m.from.address) : noPhoto),
    () => null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-headline font-semibold text-white"
      style={{ backgroundColor: letterAvatarColor(displayName(m.from)) }}
    >
      {photo && photo !== failed && /^data:image\/(png|jpeg|gif|webp);base64,/.test(photo) ? (
        <img
          src={photo}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(photo)}
        />
      ) : (
        displayName(m.from).slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
