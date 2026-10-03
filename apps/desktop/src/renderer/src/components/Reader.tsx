import { MailClient } from "../rpc";
import { AppleContactActions } from "./AppleContactActions";
import { InviteBanner, RawMessageDialog } from "./LazyDialogs";
import { ThreadSummary } from "./AiPanel";
import { TriageChip } from "./TriageChip";
import { ContactAvatar as Avatar } from "./ContactAvatar";
import { matchesShortcut, shortcutAction, type ShortcutSet } from "../../../shared/shortcuts";
import { readerMessageId, useReaderMessages } from "../reader-selection";
import { readerSelectedText } from "../quote-selection";
import { jumpReaderSelection } from "../jump-selection";
import { readerFindAction } from "../reader-shortcuts";
import { SearchField } from "./ui/SearchField";
import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  addressDomain,
  DEFAULT_PREFS,
  imagesAllowed,
  htmlToText,
  normalizeQuote,
  EMPTY_QUOTE_HISTORY,
  type QuoteHistory,
  type BatchResult,
  type MailOp,
  splitRepeatedQuote,
  orderThread,
  prepareMessageHtml,
  READER_ZOOMS,
  senderLabel,
  threadExpansion,
  type ReaderZoom,
} from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  AppWindow,
  Code,
  ChevronDown,
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
  useContext,
  useCallback,
  useMemo,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { Message, DerivedChunk } from "../../../shared/api";
import { causeText } from "../errors";
import { displayName, threadDate } from "../format";
import { Keys } from "../state/keys";
import {
  openThreadWindow,
  openMessageWindow,
  modifyMessages,
  markUnreadFrom,
  printThread,
  useRunMail,
  withMail,
} from "../state/mail";
import { setImageSenderAtom, setPrefsAtom } from "../state/mutations";
import {
  accountsAtom,
  knownSendersAtom,
  imageSendersAtom,
  inlineImagesAtom,
  prefsAtom,
  threadAtom,
} from "../state/queries";
import { imagesLoadedAtom, messageBackgroundAtom } from "../state/ui";
import { MediaMatches } from "./MediaMatches";
import { Attachments } from "./Attachments";
import { EmailFrame, type MessageBackground } from "./EmailFrame";
import { MeetingLinks } from "./MeetingLinks";
import { highlightBody } from "./body-text";

import { useShortcutText } from "../use-shortcut-text";

import { useSaveMessage } from "./reader-actions";
import { DropdownMenu, MenuItem, MenuSeparator } from "./ui/Menu";
import { PickerPopover } from "./ui/Picker";

/** Shows a one-line notice, the app's toast. */
export type Notify = (toast: { text: string; tone?: "error" }) => void;
export type ReaderActionDone = (action: {
  result: BatchResult;
  ids: readonly string[];
  op: MailOp;
}) => void;

interface Props {
  messageId: string | null;
  threadKey: string | null;
  derivedMatches?: readonly DerivedChunk[] | undefined;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Actions for the open thread, left of the search field. */
  renderToolbar?: (compact: boolean) => ReactNode;
  /** Opens a draft of the thread in the compose window, by local draft id or message id. */
  onEditDraft: (messageId: string) => void;
  notify: Notify;
  onSelectMessage: (id: string) => void;
  onMarkUnread: () => void;
  onActionDone: ReaderActionDone;
  onComposeMessage: (
    id: string,
    mode: "reply" | "replyAll" | "forward",
    attachment?: boolean,
  ) => void;
}

export function Reader({
  messageId,
  threadKey,
  derivedMatches,
  query,
  onQuery,
  searchRef,
  renderToolbar,
  onSelectMessage,
  onMarkUnread,
  onActionDone,
  onComposeMessage,
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
  const messages = useReaderMessages(threadKey, thread._tag === "Some" ? thread.value : undefined);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const grouping = prefs.threadGrouping;

  return (
    <main className="flex h-full w-full min-w-0 flex-col bg-white dark:bg-neutral-900">
      <header
        ref={headerRef}
        data-reader-toolbar
        className="drag flex min-h-13 shrink-0 items-center gap-3 px-4 py-3"
      >
        {prefs.toolbarVisible && (
          <div className="no-drag shrink-0">{renderToolbar?.(width < 900)}</div>
        )}
        <SearchField value={query} onChange={onQuery} inputRef={searchRef} />
      </header>
      {!messageId || !messages ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-a11y-muted dark:text-neutral-600">
          <Mail className="size-10 stroke-1" />
          <p className="text-a11y-muted">
            <Trans>Select a message</Trans>
          </p>
        </div>
      ) : (
        // A newly synced representative keeps selection, expansion and find state.
        <ThreadView
          key={threadKey}
          messages={messages}
          selectedId={messageId}
          onSelectMessage={onSelectMessage}
          onMarkUnread={onMarkUnread}
          onActionDone={onActionDone}
          onComposeMessage={onComposeMessage}
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
  onSelectMessage,
  onMarkUnread,
  onActionDone,
  onComposeMessage,
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
  onSelectMessage?: ((id: string) => void) | undefined;
  onMarkUnread?: (() => void) | undefined;
  onActionDone?: ReaderActionDone | undefined;
  onComposeMessage?: Props["onComposeMessage"] | undefined;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const shortcut = useShortcutText();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  const print = useThreadPrint(notify);
  const [raw, setRaw] = useState<string | null>(null);
  const save = useSaveMessage(notify);
  const [activeSelection, setActiveId] = useState(selectedId);
  const activeId = readerMessageId(stored, activeSelection, selectedId, single);
  const registry = useContext(RegistryContext);
  const readerDark = useDarkMode();
  const [finding, setFinding] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const selectInitial = useEffectEvent((id: string) => onSelectMessage?.(id));
  useEffect(() => {
    selectInitial(activeId);
  }, [activeId]);
  const activate = (id: string) => {
    if (id !== activeId) {
      setActiveId(id);
      onSelectMessage?.(id);
      setFindIndex(0);
      setFindCount(0);
    }
  };
  const reportMatches = useCallback((count: number) => {
    setFindCount(count);
  }, []);
  const findNext = (direction: number) =>
    setFindIndex((index) => (findCount ? (index + direction + findCount) % findCount : 0));
  const beginFind = (id = activeId) => {
    activate(id);
    setFinding(true);
    setOpen((previous) => new Set([...previous, id]));
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  };
  const closeFind = () => {
    setFinding(false);
    scroller.current?.focus({ preventScroll: true });
  };
  const messageAction = (id: string, op: Parameters<typeof modifyMessages>[1]) => {
    if (op.kind === "read" && !op.value) onMarkUnread?.();
    return run(
      modifyMessages([id], op).pipe(
        Effect.tap((result) => Effect.sync(() => onActionDone?.({ result, ids: [id], op }))),
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );
  };
  const unreadFrom = (id: string) => {
    onMarkUnread?.();
    return run(
      markUnreadFrom(id).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            onActionDone?.({ result, ids: [id], op: { kind: "read", value: false } }),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );
  };
  const previousBodies = useMemo(() => {
    const chronological = orderThread(stored, "oldest");
    const bodies = chronological.map((prior) =>
      normalizeQuote(prior.bodyText || htmlToText(prior.bodyHtml)),
    );
    return new Map(chronological.map((message, index) => [message.id, { bodies, before: index }]));
  }, [stored]);
  const shown = single ? stored.filter((m) => m.id === selectedId) : stored;
  const messages = orderThread(shown, prefs.threadOrder);
  const addresses = [
    ...new Set(messages.map((m) => m.from.address.trim().toLowerCase())),
  ].toSorted();
  const known = AsyncResult.getOrElse(
    useAtomValue(knownSendersAtom(stored[0]?.accountId ?? "", addresses)),
    (): readonly string[] => [],
  );
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const provider = accounts.find((account) => account.id === stored[0]?.accountId)?.provider;
  const webLabel = provider === "gmail" ? t`Open in Gmail` : t`Open in Outlook`;
  const canShare = AsyncResult.getOrElse(
    useAtomValue(MailClient.query("AttachmentCapabilities", undefined)),
    () => ({ share: false }),
  ).share;
  const shareLink = (id: string, kind: "message" | "thread" | "web") =>
    run(
      withMail((call) => call("ShareMessageLink", { id, kind })).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );
  const canOpenWeb = provider === "gmail" || provider === "outlook";
  const searchSender = (m: Message) =>
    run(withMail((call) => call("SearchSender", { address: m.from.address })));
  const openWeb = (id: string) =>
    run(
      withMail((call) => call("OpenMessageWeb", { id })).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );

  const newest = messages.reduce<Message | undefined>(
    (a, m) => (!a || m.date >= a.date ? m : a),
    undefined,
  );
  const [open, setOpen] = useState(() => new Set([selectedId, newest?.id ?? selectedId]));
  if (activeSelection !== activeId) {
    setActiveId(activeId);
    setFinding(false);
    setFindQuery("");
    setFindIndex(0);
    setFindCount(0);
    setOpen(new Set([...open, activeId]));
  }
  const expand = (expanded: boolean) => {
    if (!expanded) setFinding(false);
    setOpen(
      threadExpansion(
        messages.map((m) => m.id),
        expanded,
      ),
    );
  };
  const toggle = (id: string) => {
    if (id === activeId && open.has(id)) setFinding(false);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
  const zoomKeys = useEffectEvent((e: KeyboardEvent) => onZoomKey(e));
  const onReaderKey = (e: KeyboardEvent, messageId = activeId) => {
    if (
      e.defaultPrevented ||
      document.querySelector('[role="dialog"],[role="alertdialog"]') ||
      (e.target instanceof Element && e.target.closest('[role="menu"]'))
    )
      return;
    const insideReader =
      e.currentTarget !== window ||
      (e.target instanceof Element && !!e.target.closest("[data-reader-text]"));
    const targetMessageId =
      (e.target instanceof Element
        ? e.target.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
        : undefined) ?? messageId;
    if (insideReader && e.isTrusted) activate(targetMessageId);
    const typingFind =
      e.target instanceof Element &&
      Boolean(e.target.closest("input,textarea,select,[contenteditable]"));
    if (insideReader && (!typingFind || e.target === findRef.current)) {
      const findAction = readerFindAction(prefs.shortcutSet, e, finding);
      if (findAction === "jump") {
        e.preventDefault();
        jumpReaderSelection(document, targetMessageId);
        return;
      }
      if (findAction === "find") {
        e.preventDefault();
        beginFind(targetMessageId);
        return;
      }
      if (findAction === "selection") {
        e.preventDefault();
        const text = readerSelectedText(document, targetMessageId);
        if (text) {
          setFindQuery(text);
          setFindIndex(0);
          beginFind(targetMessageId);
        }
        return;
      }
      if (findAction === "previous") {
        e.preventDefault();
        findNext(-1);
        return;
      }
      if (findAction === "next") {
        e.preventDefault();
        findNext(1);
        return;
      }
    }
    if (insideReader && finding && e.key === "Escape") {
      e.preventDefault();
      closeFind();
      return;
    }
    const action = shortcutAction(prefs.shortcutSet, e);
    const findCommand =
      e.target === findRef.current &&
      (e.metaKey || e.ctrlKey) &&
      (action === "forward" || action === "forwardAttachment" || action === "openMessageWeb");
    if (
      !findCommand &&
      e.target instanceof Element &&
      e.target.closest('input,textarea,select,[contenteditable],[role="menu"]')
    )
      return;
    const active = messages.find((m) => m.id === targetMessageId);
    if (!active) return;
    switch (action) {
      case "reply":
      case "replyAll":
      case "forward":
      case "forwardAttachment":
        if (insideReader && onComposeMessage) {
          e.preventDefault();
          onComposeMessage(
            active.id,
            action === "forwardAttachment" ? "forward" : action,
            action === "forwardAttachment",
          );
        }
        break;
      case "expandAll":
        e.preventDefault();
        expand(true);
        break;
      case "collapseAll":
        e.preventDefault();
        expand(false);
        break;
      case "showOriginal":
        e.preventDefault();
        setRaw(active.id);
        break;
      case "loadRemoteContent":
        e.preventDefault();
        registry.set(imagesLoadedAtom(active.id), true);
        break;
      case "toggleMessageBackground":
        e.preventDefault();
        registry.set(
          messageBackgroundAtom(active.id),
          (registry.get(messageBackgroundAtom(active.id)) ??
            (prefs.messageBackground === "theme" && readerDark ? "dark" : "light")) === "dark"
            ? "light"
            : "dark",
        );
        break;
      case "saveMessage":
        e.preventDefault();
        save(active.id);
        break;
      case "searchSender":
        e.preventDefault();
        searchSender(active);
        break;
      case "openMessageWeb":
        if (canOpenWeb) {
          e.preventDefault();
          openWeb(active.id);
        }
        break;
    }
  };
  const readerKeys = useEffectEvent((e: KeyboardEvent) => onReaderKey(e));
  const frameKeys = (id: string, e: KeyboardEvent) => {
    // A key in a frame targets that message even before React processes focus.
    activate(id);
    onZoomKey(e);
    onReaderKey(e, id);
    if (!e.defaultPrevented && !e.repeat) {
      const typing = Boolean(
        e.target &&
        "closest" in e.target &&
        typeof e.target.closest === "function" &&
        e.target.closest("input,textarea,select,[contenteditable]"),
      );
      const action = shortcutAction(prefs.shortcutSet, e, typing);
      if (
        action === "nextWindow" ||
        action === "previousWindow" ||
        action === "focusMainWindow" ||
        action === "toggleFullScreen" ||
        action === "nextTab" ||
        action === "previousTab"
      ) {
        e.preventDefault();
        run(withMail((call) => call("SwitchWindow", { action })));
      }
      if (action === "compose" || action === "newWindow" || action === "settings") {
        e.preventDefault();
        run(
          withMail((call) =>
            action === "compose"
              ? call("ComposeNew", undefined)
              : action === "newWindow"
                ? call("NewWindow", undefined)
                : call("OpenSettings", undefined),
          ),
        );
      }
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => readerKeys(e);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return constVoid;
    const listener = (e: KeyboardEvent) => zoomKeys(e);
    el.addEventListener("keydown", listener);
    return () => el.removeEventListener("keydown", listener);
  }, [scroller]);

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
      {newest && (
        <TriageChip
          id={newest.id}
          accountId={newest.accountId}
          labels={messages.flatMap((message) => message.labels)}
        />
      )}
      {newest && (
        <ThreadSummary
          key={`${newest.accountId}/${newest.threadId}`}
          id={newest.id}
          accountId={newest.accountId}
        />
      )}
      <div className="flex items-start gap-2 pt-2 pb-4">
        <h2 className="min-w-0 flex-1 text-[24px] leading-tight font-bold">
          {newest?.subject || t`(No subject)`}
        </h2>
        {messages.length > 1 && (
          <div className="flex shrink-0 gap-2 pt-1 text-[12px] text-a11y-accent dark:text-blue-400">
            <button
              type="button"
              onClick={() => expand(true)}
              title={shortcut("expandAll")}
              disabled={messages.every((m) => open.has(m.id))}
            >{t`Expand all`}</button>
            <button
              type="button"
              onClick={() => expand(false)}
              title={shortcut("collapseAll")}
              disabled={open.size === 0}
            >{t`Collapse all`}</button>
          </div>
        )}
        <DropdownMenu
          trigger={
            <button
              type="button"
              aria-label={t`More actions`}
              className="mt-1 rounded-md p-1.5 text-a11y-muted outline-offset-0 outline-a11y-focus hover:bg-black/5 hover:text-neutral-800 focus-visible:outline-[3px] data-popup-open:bg-black/5 dark:hover:bg-white/10 dark:hover:text-neutral-100 dark:data-popup-open:bg-white/10"
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
            onClick={() =>
              run(
                withMail((call) =>
                  call("CopyMessageLink", { id: selectedId, kind: "thread" }),
                ).pipe(
                  Effect.matchCause({
                    onSuccess: () => notify({ text: t`Thread link copied` }),
                    onFailure: (cause) => notify({ text: causeText(i18n, cause), tone: "error" }),
                  }),
                ),
              )
            }
          >{t`Copy link to thread`}</MenuItem>
          {canShare && (
            <>
              <MenuItem
                onClick={() => shareLink(selectedId, "message")}
              >{t`Send message link to…`}</MenuItem>
              <MenuItem
                onClick={() => shareLink(selectedId, "thread")}
              >{t`Send thread link to…`}</MenuItem>
              {canOpenWeb && (
                <MenuItem
                  onClick={() => shareLink(selectedId, "web")}
                >{t`Send web mail link to…`}</MenuItem>
              )}
            </>
          )}
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
      {finding && (
        <search
          className="sticky top-0 z-10 mb-3 flex items-center gap-2 rounded border border-neutral-200 bg-white p-2 dark:bg-neutral-900"
          aria-label={t`Find in message`}
        >
          <input
            ref={findRef}
            aria-label={t`Find in message`}
            placeholder={t`Find in message`}
            className="min-w-0 flex-1 outline-none"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                findNext(event.shiftKey ? -1 : 1);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <output aria-live="polite">
            {findCount ? `${(findIndex % findCount) + 1}/${findCount}` : t`No matches`}
          </output>
          <button
            type="button"
            disabled={!findCount}
            onClick={() => findNext(-1)}
          >{t`Previous match`}</button>
          <button
            type="button"
            disabled={!findCount}
            onClick={() => findNext(1)}
          >{t`Next match`}</button>
          <button type="button" onClick={closeFind}>{t`Close find`}</button>
        </search>
      )}
      <MediaMatches chunks={derivedMatches} />
      <div className="divide-y divide-black/[0.07] dark:divide-white/[0.08]">
        {messages.map((m) =>
          open.has(m.id) ? (
            <Expanded
              key={m.id}
              message={m}
              known={known.includes(m.from.address.trim().toLowerCase())}
              onActivate={() => activate(m.id)}
              active={m.id === activeId}
              onMessageOp={(op) => messageAction(m.id, op)}
              onUnreadFrom={() => unreadFrom(m.id)}
              onOpenSingle={() => run(openMessageWindow(m.id))}
              previous={previousBodies.get(m.id) ?? EMPTY_QUOTE_HISTORY}
              findQuery={finding && activeId === m.id ? findQuery : ""}
              findIndex={findIndex}
              onMatches={activeId === m.id ? reportMatches : undefined}
              onSave={() => save(m.id)}
              onSearchSender={() => searchSender(m)}
              onShare={canShare ? (kind) => shareLink(m.id, kind) : undefined}
              onOpenWeb={canOpenWeb ? () => openWeb(m.id) : undefined}
              webLabel={webLabel}
              zoom={zoom}
              defaultBackground={prefs.messageBackground}
              onZoomKey={(e) => frameKeys(m.id, e)}
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
              data-message-id={m.id}
              type="button"
              onClick={() => {
                activate(m.id);
                toggle(m.id);
              }}
              onFocus={() => activate(m.id)}
              className={`flex w-full gap-3 py-3 text-left ${m.id === activeId ? "border-l-2 border-blue-400 pl-2" : ""}`}
            >
              <Avatar message={m} />
              <span className="min-w-0 flex-1">
                <MessageHead
                  message={m}
                  known={known.includes(m.from.address.trim().toLowerCase())}
                />
                <span className="mt-0.5 block truncate text-[13px] text-a11y-muted">
                  {m.snippet}
                </span>
              </span>
            </button>
          ),
        )}
      </div>
      {raw && <RawMessageDialog messageId={raw} notify={notify} onClose={() => setRaw(null)} />}
    </div>
  );
}

function MessageHead({
  message: m,
  known,
  onSearchSender,
}: {
  message: Message;
  known: boolean;
  onSearchSender?: (() => void) | undefined;
}) {
  const { t, i18n } = useLingui();
  const shortcut = useShortcutText();
  return (
    <span className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 break-all text-[14px] font-semibold">
        {onSearchSender ? (
          <DropdownMenu
            trigger={
              <button type="button" className="text-left hover:text-blue-600">
                {senderLabel(m.from, known)}
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
          senderLabel(m.from, known)
        )}
      </span>
      {m.isStarred && (
        <Star className="size-3.5 shrink-0 self-center fill-amber-600 text-amber-600 dark:fill-amber-400 dark:text-amber-400" />
      )}
      <span className="shrink-0 text-[12px] text-a11y-muted">{threadDate(m.date, i18n)}</span>
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
  known,
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
  previous,
  findQuery,
  findIndex,
  onMatches,
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
  known: boolean;
  onActivate: () => void;
  onSave: () => void;
  onSearchSender: () => void;
  onShare: ((kind: "message" | "thread" | "web") => void) | undefined;
  onOpenWeb: (() => void) | undefined;
  webLabel: string;
  active: boolean;
  onMessageOp: (op: Parameters<typeof modifyMessages>[1]) => void;
  onUnreadFrom: () => void;
  onOpenSingle: () => void;
  previous: QuoteHistory;
  findQuery: string;
  findIndex: number;
  onMatches: ((count: number) => void) | undefined;
}) {
  const { t } = useLingui();
  const shortcut = useShortcutText();
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
    <article
      data-message-id={m.id}
      onMouseDownCapture={onActivate}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isTrusted) onActivate();
      }}
      aria-label={active ? t`Selected message` : t`Message`}
      className={`@container/message py-3 ${active ? "border-l-2 border-blue-400 pl-2" : ""}`}
    >
      <h3 className="sr-only">{m.subject || t`(No subject)`}</h3>
      {onEditDraft && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-red-500/[0.06] px-3 py-1.5 text-[13px]">
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
          <span className="min-w-0 flex-1">
            <MessageHead message={m} known={known} onSearchSender={onSearchSender} />
            <span
              className="mt-0.5 block truncate text-[13px] text-a11y-muted"
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
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t`Collapse message`}
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
              className="size-7 shrink-0 self-start rounded-md p-1.5 text-a11y-muted outline-offset-0 outline-a11y-focus hover:bg-black/5 hover:text-neutral-800 focus-visible:outline-[3px] data-popup-open:bg-black/5 dark:hover:bg-white/10 dark:hover:text-neutral-100 dark:data-popup-open:bg-white/10"
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
          <MenuItem
            icon={AppWindow}
            onClick={onOpenSingle}
          >{t`Open only this message in a new window`}</MenuItem>
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
          <MenuItem
            icon={FileDown}
            onClick={onSave}
            shortcut={shortcut("saveMessage")}
          >{t`Save message as EML…`}</MenuItem>
          <MenuItem
            onClick={onSearchSender}
            shortcut={shortcut("searchSender")}
          >{t`Search messages from this sender`}</MenuItem>
          {onShare && (
            <>
              <MenuItem onClick={() => onShare("message")}>{t`Send message link to…`}</MenuItem>
              <MenuItem onClick={() => onShare("thread")}>{t`Send thread link to…`}</MenuItem>
              {onOpenWeb && (
                <MenuItem onClick={() => onShare("web")}>{t`Send web mail link to…`}</MenuItem>
              )}
            </>
          )}
          {onOpenWeb && (
            <MenuItem onClick={onOpenWeb} shortcut={shortcut("openMessageWeb")}>
              {webLabel}
            </MenuItem>
          )}
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

      <MeetingLinks sources={[m.bodyText, m.bodyHtml]} />
      <InviteBanner message={m} />

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
                  className="font-medium text-a11y-accent hover:underline dark:text-blue-400"
                >
                  <Trans>Load images</Trans>
                </button>
                {address && (
                  <button
                    type="button"
                    onClick={() => allow(address, true)}
                    className="font-medium text-a11y-accent hover:underline dark:text-blue-400"
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
          <output className="block px-4 text-a11y-muted">
            <Trans>The body is not cached. Try opening this message again when connected.</Trans>
          </output>
        ) : m.bodyHtml ? (
          <EmailFrame
            html={prepared.html}
            remote={allowed}
            background={background}
            zoom={zoom}
            onKeyDown={onZoomKey}
            onActivate={onActivate}
            previous={previous}
            findQuery={findQuery}
            findIndex={findIndex}
            onMatches={onMatches}
          />
        ) : (
          <PlainBody
            text={m.bodyText}
            previous={previous}
            background={background}
            zoom={zoom}
            findQuery={findQuery}
            findIndex={findIndex}
            onMatches={onMatches}
          />
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
          className="flex shrink-0 cursor-default items-center gap-1 rounded text-emerald-700 outline-offset-1 outline-a11y-focus focus-visible:outline-[3px] dark:text-emerald-400"
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

function PlainBody({
  text,
  previous,
  background,
  zoom,
  findQuery,
  findIndex,
  onMatches,
}: {
  text: string;
  previous: QuoteHistory;
  background: MessageBackground;
  zoom: ReaderZoom;
  findQuery: string;
  findIndex: number;
  onMatches: ((count: number) => void) | undefined;
}) {
  const { t } = useLingui();
  const [showQuotes, setShowQuotes] = useState(false);
  const parts = useMemo(() => splitRepeatedQuote(text, previous), [text, previous]);
  const root = useRef<HTMLPreElement>(null);
  const visible = parts.body + (showQuotes || findQuery ? parts.quote : "");
  useEffect(() => {
    if (!root.current) return constVoid;
    root.current.textContent = visible;
    const highlights = highlightBody(root.current, findQuery);
    onMatches?.(highlights.count);
    highlights.select(highlights.count ? findIndex % highlights.count : 0);
    return () => highlights.dispose();
  }, [visible, findQuery, findIndex, onMatches]);
  return (
    <>
      <pre
        ref={root}
        className={`rounded-lg p-4 font-sans leading-relaxed whitespace-pre-wrap ${background === "dark" ? "bg-black text-neutral-100" : "bg-white text-neutral-900"}`}
        style={{ fontSize: (14 * zoom) / 100 }}
      />
      {parts.quote && (
        <button
          type="button"
          className="px-4 text-a11y-accent"
          onClick={() => setShowQuotes(!showQuotes)}
        >
          {showQuotes ? t`Hide quoted text` : t`Show quoted text`}
        </button>
      )}
    </>
  );
}
