import { matchesShortcut, type ShortcutSet } from "../../../shared/shortcuts";
import { SearchField } from "./ui/SearchField";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  addressDomain,
  DEFAULT_PREFS,
  imagesAllowed,
  orderThread,
  prepareMessageHtml,
  shouldLoadInvitation,
  READER_ZOOMS,
  type ReaderZoom,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  AppWindow,
  Code,
  FileDown,
  ImageOff,
  Images,
  Mail,
  Minus,
  MoreHorizontal,
  Moon,
  Plus,
  Printer,
  ShieldCheck,
  Star,
  Sun,
  Type,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { Message, DerivedChunk } from "../../../shared/api";
import { causeText } from "../errors";
import { avatarColor, displayName, threadDate } from "../format";
import { Keys } from "../state/keys";
import { openThreadWindow, printThread, useRunMail, withMail } from "../state/mail";
import { setImageSenderAtom, setPrefsAtom } from "../state/mutations";
import { imageSendersAtom, inlineImagesAtom, prefsAtom, threadAtom } from "../state/queries";
import { imagesLoadedAtom, messageBackgroundAtom } from "../state/ui";
import { MediaMatches } from "./MediaMatches";
import { Attachments } from "./Attachments";
import { EmailFrame, type MessageBackground } from "./EmailFrame";
import { InviteBanner } from "./InviteBanner";

import { useShortcutText } from "./SystemSettings";
import { RawMessageDialog } from "./RawMessage";
import { DropdownMenu, MenuItem, MenuSeparator } from "./ui/Menu";
import { PickerPopover } from "./ui/Picker";

/** Shows a one-line notice, the app's toast. */
export type Notify = (toast: { text: string; tone?: "error" }) => void;

interface Props {
  messageId: string | null;
  derivedMatches?: readonly DerivedChunk[] | undefined;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Actions for the open thread, left of the search field. */
  renderToolbar?: (compact: boolean) => ReactNode;
  /** Opens a draft of the thread in the compose window, by local draft id or message id. */
  onEditDraft: (messageId: string) => void;
  notify: Notify;
}

export function Reader({
  messageId,
  derivedMatches,
  query,
  onQuery,
  searchRef,
  renderToolbar,
  onEditDraft,
  notify,
}: Props) {
  const headerRef = useRef<HTMLElement>(null);
  const width = useSyncExternalStore(
    (onChange) => {
      const header = headerRef.current;
      if (!header) return constVoid;
      const observer = new ResizeObserver(onChange);
      observer.observe(header);
      return () => observer.disconnect();
    },
    () => headerRef.current?.clientWidth ?? 0,
  );
  const thread = AsyncResult.value(useAtomValue(threadAtom(messageId)));
  const messages = thread._tag === "Some" ? thread.value : undefined;
  const grouping = AsyncResult.getOrElse(
    useAtomValue(prefsAtom),
    () => DEFAULT_PREFS,
  ).threadGrouping;

  return (
    <main className="flex h-full w-full min-w-0 flex-col bg-white dark:bg-neutral-900">
      <header
        ref={headerRef}
        data-reader-toolbar
        className="drag flex min-h-13 shrink-0 items-center gap-3 px-4 py-3"
      >
        <div className="no-drag shrink-0">{renderToolbar?.(width < 900)}</div>
        <SearchField value={query} onChange={onQuery} inputRef={searchRef} />
      </header>
      {!messageId || !messages ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-neutral-300 dark:text-neutral-600">
          <Mail className="size-10 stroke-1" />
          <p className="text-neutral-400">
            <Trans>Select a message</Trans>
          </p>
        </div>
      ) : (
        // Keyed by message so expansion state resets when the selection changes.
        <ThreadView
          key={messageId}
          messages={messages}
          selectedId={messageId}
          derivedMatches={derivedMatches}
          // Grouping off lists messages on their own; the reader shows just that one.
          single={!grouping}
          onEditDraft={onEditDraft}
          notify={notify}
          canOpenWindow
        />
      )}
    </main>
  );
}

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/** Whether the app is in dark mode right now. */
function useDarkMode(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = darkQuery();
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => darkQuery().matches,
  );
}

/** The next text size up (1) or down (-1), or normal size (0). */
function stepZoom(zoom: ReaderZoom, step: -1 | 0 | 1): ReaderZoom {
  if (step === 0) return 100;
  const i = READER_ZOOMS.indexOf(zoom);
  return READER_ZOOMS[Math.max(0, Math.min(READER_ZOOMS.length - 1, i + step))] ?? zoom;
}

/** ⌘+ / ⌘= bigger, ⌘- smaller, ⌘0 normal. */
function zoomStep(e: KeyboardEvent, set: ShortcutSet): -1 | 0 | 1 | null {
  if (matchesShortcut(set, "zoomIn", e)) return 1;
  if (matchesShortcut(set, "zoomOut", e)) return -1;
  if (matchesShortcut(set, "zoomReset", e)) return 0;
  return null;
}

/** Prints a thread or one message of it, or saves it as PDF, reporting failures. */
export function useThreadPrint(notify: Notify) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  return (id: string, pdf: boolean, only?: string) =>
    run(
      printThread({
        id,
        ...(only ? { only } : {}),
        pdf,
        headings: { from: t`From`, to: t`To`, cc: t`Cc`, date: t`Date` },
        locale: i18n.locale,
      }).pipe(
        Effect.matchCause({
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            notify({
              text: pdf ? t`Couldn't save the PDF: ${reason}` : t`Couldn't print: ${reason}`,
              tone: "error",
            });
          },
          onSuccess: (done) => {
            if (done && pdf) notify({ text: t`Saved as PDF` });
          },
        }),
      ),
    );
}

/**
 * Mimestream-style thread: one stacked column, avatars on the left, a hairline
 * between messages. Collapsed messages show one line of snippet. The reader in
 * the main window and a thread window both use it.
 */
export function ThreadView({
  messages: stored,
  derivedMatches = [],
  selectedId,
  single,
  onEditDraft,
  notify,
  canOpenWindow,
}: {
  messages: readonly Message[];
  derivedMatches?: readonly DerivedChunk[] | undefined;
  selectedId: string;
  /** Show only the selected message (conversation grouping off). */
  single: boolean;
  onEditDraft?: ((messageId: string) => void) | undefined;
  notify: Notify;
  /** Offer Open in New Window (not inside a thread window). */
  canOpenWindow?: boolean;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const shortcut = useShortcutText();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  const print = useThreadPrint(notify);
  const [raw, setRaw] = useState<string | null>(null);

  const shown = single ? stored.filter((m) => m.id === selectedId) : stored;
  const messages = orderThread(shown.length ? shown : stored, prefs.threadOrder);
  const newest = messages.reduce<Message | undefined>(
    (a, m) => (!a || m.date >= a.date ? m : a),
    undefined,
  );
  const [open, setOpen] = useState(() => new Set([selectedId, newest?.id ?? selectedId]));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const zoom = prefs.readerZoom;
  const setZoom = (next: ReaderZoom) => {
    if (next !== zoom) {
      setPrefs({ payload: { patch: { readerZoom: next } }, reactivityKeys: [Keys.prefs] });
    }
  };
  const onZoomKey = (e: KeyboardEvent) => {
    const step = zoomStep(e, prefs.shortcutSet);
    if (step === null) return;
    e.preventDefault();
    setZoom(stepZoom(zoom, step));
  };
  const printOnly = single ? selectedId : undefined;

  // ⌘+ and ⌘- apply while focus is in the thread; a click anywhere in it focuses it.
  const scroller = useRef<HTMLDivElement>(null);
  const zoomKeys = useEffectEvent((e: KeyboardEvent) => onZoomKey(e));
  useEffect(() => {
    const el = scroller.current;
    if (!el) return constVoid;
    const listener = (e: KeyboardEvent) => zoomKeys(e);
    el.addEventListener("keydown", listener);
    return () => el.removeEventListener("keydown", listener);
  }, []);

  return (
    // Focusable so ⌘+ and ⌘- reach it after a click anywhere in the thread.
    <div
      ref={scroller}
      data-reader-text
      role="document"
      aria-label={newest?.subject || t`(No subject)`}
      tabIndex={-1}
      onMouseDownCapture={(event) => {
        if (
          event.target instanceof Element &&
          !event.target.closest("button,a,input,textarea,select,iframe,[contenteditable]")
        )
          event.currentTarget.focus({ preventScroll: true });
      }}
      className="selectable flex-1 overflow-y-auto px-7 pb-10 outline-none"
    >
      <div className="flex items-start gap-2 pt-2 pb-4">
        <h2 className="min-w-0 flex-1 text-[24px] leading-tight font-bold">
          {newest?.subject || t`(No subject)`}
        </h2>
        <DropdownMenu
          trigger={
            <button
              type="button"
              aria-label={t`More actions`}
              className="mt-1 rounded-md p-1.5 text-neutral-500 outline-offset-0 outline-blue-500/60 hover:bg-black/5 hover:text-neutral-800 focus-visible:outline-[3px] data-popup-open:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100 dark:data-popup-open:bg-white/10"
            >
              <MoreHorizontal className="size-4" />
            </button>
          }
        >
          {canOpenWindow && (
            <MenuItem icon={AppWindow} onClick={() => run(openThreadWindow(selectedId))}>
              {t`Open in New Window`}
            </MenuItem>
          )}
          <MenuItem
            onClick={() =>
              run(
                withMail((call) => call("CopyMessageLink", { id: selectedId })).pipe(
                  Effect.matchCause({
                    onSuccess: () => notify({ text: t`Message link copied` }),
                    onFailure: (cause) => notify({ text: causeText(i18n, cause), tone: "error" }),
                  }),
                ),
              )
            }
          >{t`Copy link to message`}</MenuItem>
          <MenuItem
            icon={Printer}
            shortcut={shortcut("print")}
            onClick={() => print(selectedId, false, printOnly)}
          >
            {t`Print…`}
          </MenuItem>
          <MenuItem icon={FileDown} onClick={() => print(selectedId, true, printOnly)}>
            {t`Save as PDF…`}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={Plus}
            shortcut={shortcut("zoomIn")}
            onClick={() => setZoom(stepZoom(zoom, 1))}
          >
            {t`Bigger text`}
          </MenuItem>
          <MenuItem
            icon={Minus}
            shortcut={shortcut("zoomOut")}
            onClick={() => setZoom(stepZoom(zoom, -1))}
          >
            {t`Smaller text`}
          </MenuItem>
          <MenuItem
            icon={Type}
            shortcut={shortcut("zoomReset")}
            onClick={() => setZoom(100)}
            disabled={zoom === 100}
          >
            {t`Actual size`}
          </MenuItem>
        </DropdownMenu>
      </div>
      <MediaMatches chunks={derivedMatches} />
      <div className="divide-y divide-black/[0.07] dark:divide-white/[0.08]">
        {messages.map((m) =>
          open.has(m.id) ? (
            <Expanded
              key={m.id}
              message={m}
              zoom={zoom}
              defaultBackground={prefs.messageBackground}
              onZoomKey={onZoomKey}
              notify={notify}
              onShowOriginal={() => setRaw(m.id)}
              onPrint={(pdf) => print(m.id, pdf, m.id)}
              onCollapse={messages.length > 1 ? () => toggle(m.id) : undefined}
              onEditDraft={
                m.labels.includes("DRAFT") && onEditDraft
                  ? // The local draft id survives the provider replacing this message on save.
                    () => onEditDraft(m.draftId ?? m.id)
                  : undefined
              }
            />
          ) : (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              className="flex w-full gap-3 py-3 text-left"
            >
              <Avatar message={m} />
              <span className="min-w-0 flex-1">
                <MessageHead message={m} />
                <span className="mt-0.5 block truncate text-[13px] text-neutral-500 dark:text-neutral-400">
                  {m.snippet}
                </span>
              </span>
            </button>
          ),
        )}
      </div>
      {raw && <RawMessageDialog messageId={raw} onClose={() => setRaw(null)} />}
    </div>
  );
}

function Avatar({ message: m }: { message: Message }) {
  return (
    <span
      className={`flex size-10 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white ${avatarColor(m.from.address)}`}
    >
      {displayName(m.from).slice(0, 1).toUpperCase()}
    </span>
  );
}

function MessageHead({ message: m }: { message: Message }) {
  const { i18n } = useLingui();
  return (
    <span className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
        {displayName(m.from)}
      </span>
      {m.isStarred && (
        <Star className="size-3.5 shrink-0 self-center fill-amber-400 text-amber-400" />
      )}
      <span className="shrink-0 text-[12px] text-neutral-500 dark:text-neutral-400">
        {threadDate(m.date, i18n)}
      </span>
    </span>
  );
}

const noInline = Atom.make(AsyncResult.success<Record<string, string>>({}));

function Expanded({
  message: m,
  zoom,
  defaultBackground,
  onZoomKey,
  notify,
  onShowOriginal,
  onPrint,
  onCollapse,
  onEditDraft,
}: {
  message: Message;
  zoom: ReaderZoom;
  defaultBackground: "light" | "theme";
  onZoomKey: (e: KeyboardEvent) => void;
  notify: Notify;
  onShowOriginal: () => void;
  onPrint: (pdf: boolean) => void;
  onCollapse?: (() => void) | undefined;
  onEditDraft?: (() => void) | undefined;
}) {
  const { t } = useLingui();
  const dark = useDarkMode();
  const [override, setOverride] = useAtom(messageBackgroundAtom(m.id));
  const [loadedOnce, setLoadedOnce] = useAtom(imagesLoadedAtom(m.id));
  const senders: readonly string[] = AsyncResult.getOrElse(
    useAtomValue(imageSendersAtom),
    (): readonly string[] => [],
  );
  const setImageSender = useAtomSet(setImageSenderAtom);

  const address = m.from.address.toLowerCase();
  const domain = addressDomain(address);
  const bySender = senders.includes(address);
  const byDomain = domain !== "" && senders.includes(domain);
  const allowed = loadedOnce || imagesAllowed(address, senders);
  const hasCid = /\bcid:/i.test(m.bodyHtml);
  const inline = AsyncResult.getOrElse(
    useAtomValue(allowed && hasCid ? inlineImagesAtom(m.id) : noInline),
    () => ({}),
  );
  const prepared = prepareMessageHtml(m.bodyHtml, { inline });
  const needsImages = prepared.hasRemote || hasCid;
  const trackerCount = prepared.trackers.length + prepared.pixels;

  const background: MessageBackground =
    override ?? (defaultBackground === "theme" && dark ? "dark" : "light");
  const toggleBackground = () => setOverride(background === "dark" ? "light" : "dark");

  const allow = (entry: string, value: boolean) =>
    setImageSender({
      payload: { entry, allowed: value },
      reactivityKeys: [Keys.imageSenders],
    });

  const separator = t({ message: ", ", comment: "Separator between list items" });
  const to = m.to.map(displayName).join(separator) || "—";
  const cc = m.cc.map(displayName).join(separator);
  return (
    <article className="@container/message py-3">
      {onEditDraft && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-red-500/[0.06] px-3 py-1.5 text-[13px]">
          <span className="flex-1 text-red-600 dark:text-red-400">
            <Trans>Draft</Trans>
          </span>
          <button
            type="button"
            onClick={onEditDraft}
            className="h-6 rounded px-2 font-medium text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
          >
            <Trans>Continue editing</Trans>
          </button>
        </div>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          disabled={!onCollapse}
          onClick={onCollapse}
          className="flex min-w-0 flex-1 gap-3 text-left select-text"
        >
          <Avatar message={m} />
          <span className="min-w-0 flex-1">
            <MessageHead message={m} />
            <span
              className="mt-0.5 block truncate text-[13px] text-neutral-500 dark:text-neutral-400"
              title={m.from.address}
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
        </button>
        <DropdownMenu
          trigger={
            <button
              type="button"
              aria-label={t`Message actions`}
              className="size-7 shrink-0 self-start rounded-md p-1.5 text-neutral-400 outline-offset-0 outline-blue-500/60 hover:bg-black/5 hover:text-neutral-800 focus-visible:outline-[3px] data-popup-open:bg-black/5 dark:hover:bg-white/10 dark:hover:text-neutral-100 dark:data-popup-open:bg-white/10"
            >
              <MoreHorizontal className="size-4" />
            </button>
          }
        >
          <MenuItem icon={background === "dark" ? Sun : Moon} onClick={toggleBackground}>
            {background === "dark" ? t`Light background` : t`Dark background`}
          </MenuItem>
          <MenuItem icon={Code} onClick={onShowOriginal}>
            {t`Show original`}
          </MenuItem>
          <MenuItem icon={Printer} onClick={() => onPrint(false)}>
            {t`Print message…`}
          </MenuItem>
          <MenuItem icon={FileDown} onClick={() => onPrint(true)}>
            {t`Save message as PDF…`}
          </MenuItem>
          {address && (
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

      {shouldLoadInvitation(m) && <InviteBanner message={m} />}

      {m.attachments.length > 0 && <Attachments message={m} notify={notify} />}

      {((needsImages && !allowed) || trackerCount > 0) && (
        <div
          data-images-notice
          className="mt-3 flex flex-col items-start gap-3 rounded-md bg-neutral-100 px-3 py-2 text-[12px] text-neutral-600 @min-[600px]/message:flex-row @min-[600px]/message:items-center dark:bg-white/5 dark:text-neutral-400"
        >
          {needsImages && !allowed && (
            <>
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <ImageOff className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <Trans>
                    Remote images are blocked so the sender can't tell if you read this.
                  </Trans>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setLoadedOnce(true)}
                  className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  <Trans>Load images</Trans>
                </button>
                {address && (
                  <button
                    type="button"
                    onClick={() => allow(address, true)}
                    className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    <Trans>Always from this sender</Trans>
                  </button>
                )}
              </div>
            </>
          )}
          {trackerCount > 0 && (
            <TrackerBadge trackers={prepared.trackers} pixels={prepared.pixels} />
          )}
        </div>
      )}

      <div className="pt-4">
        {m.bodyCached === false ? (
          <output className="block px-4 text-neutral-500">
            <Trans>The body is not cached. Try opening this message again when connected.</Trans>
          </output>
        ) : m.bodyHtml ? (
          <EmailFrame
            html={prepared.html}
            remote={allowed}
            background={background}
            zoom={zoom}
            onKeyDown={onZoomKey}
          />
        ) : (
          <pre
            className={`rounded-lg p-4 font-sans leading-relaxed whitespace-pre-wrap ${
              background === "dark"
                ? "bg-black text-neutral-100 ring-1 ring-white/10"
                : "bg-white text-neutral-900 dark:ring-1 dark:ring-white/10"
            }`}
            style={{ fontSize: (14 * zoom) / 100 }}
          >
            {m.bodyText}
          </pre>
        )}
      </div>
    </article>
  );
}

/** "Blocked 2 trackers". Clicking it lists the services. */
function TrackerBadge({ trackers, pixels }: { trackers: readonly string[]; pixels: number }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const count = trackers.length + pixels;
  const unknown = plural(pixels, { one: "# tracking pixel", other: "# tracking pixels" });
  const list = [...trackers, ...(pixels > 0 ? [unknown] : [])];
  return (
    <PickerPopover
      open={open}
      onOpenChange={setOpen}
      className="w-56"
      trigger={
        <button
          type="button"
          className="flex shrink-0 cursor-default items-center gap-1 rounded text-emerald-700 outline-offset-1 outline-blue-500/60 focus-visible:outline-[3px] dark:text-emerald-400"
        >
          <ShieldCheck className="size-3.5" />
          {plural(count, { one: "Blocked # tracker", other: "Blocked # trackers" })}
        </button>
      }
    >
      <div className="px-3 py-2 text-[12px]">
        <span className="mb-1 block font-medium">{t`Blocked before loading:`}</span>
        {list.map((name) => (
          <span key={name} className="block text-neutral-600 dark:text-neutral-300">
            {name}
          </span>
        ))}
      </div>
    </PickerPopover>
  );
}
