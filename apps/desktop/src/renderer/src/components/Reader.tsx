import { useAtomValue, RegistryContext, useAtom, useAtomSet } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  DEFAULT_PREFS,
  senderSpoofed,
  addressDomain,
  type BatchResult,
  type MailOp,
  orderThread,
  READER_ZOOMS,
  senderName,
  shouldLoadRemote,
  threadExpansion,
  type ReaderZoom,
  type SearchMatch,
} from "@openmail/core/schema";
import {
  useState,
  type ReactNode,
  type RefObject,
  useContext,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Message, DerivedChunk } from "../../../shared/api";
import { letterAvatarColor, displayName, threadDate } from "../format";
import {
  contactPhotoAtom,
  prefsAtom,
  accountsAtom,
  knownSendersAtom,
  imageSendersAtom,
  threadAtom,
} from "../state/queries";
import { UnsubscribeButton } from "./UnsubscribeButton";
import { MailClient } from "../rpc";
import { AppleContactActions } from "./AppleContactActions";
import { InviteBanner, RawMessageDialog } from "./LazyDialogs";
import { ThreadSummary } from "./AiPanel";
import { TriageChip } from "./TriageChip";
import { matchesShortcut, shortcutAction, type ShortcutSet } from "../../../shared/shortcuts";
import { readerMessageId, readerThreadKey, useReaderMessages } from "../reader-selection";
import { readerSelectedText } from "../quote-selection";
import { jumpReaderSelection } from "../jump-selection";
import { readerFindAction } from "../reader-shortcuts";
import { SearchField } from "./ui/SearchField";
import { iconButton, trafficLightInset } from "./ui/styles";
import { Tip } from "./ui/Tip";
import { BACK_SHORTCUT, isBackKey } from "../responsive-layout";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import {
  AppWindow,
  Code,
  ChevronDown,
  ChevronLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  FileDown,
  Images,
  Mail,
  Minus,
  MoreHorizontal,
  Moon,
  Plus,
  Printer,
  Star,
  Sun,
  Type,
} from "lucide-react";

import { messageMissing, causeText } from "../errors";
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
import { imagesLoadedAtom, messageBackgroundAtom } from "../state/ui";
import { attachmentMatches } from "./SearchSnippet";
import { MediaMatches } from "./MediaMatches";
import { Attachments } from "./Attachments";
import { LazyMessageBody, useMessageBodyState, type MessageBackground } from "./MessageBodyShell";
import { MeetingLinks } from "./MeetingLinks";

import { useShortcutText } from "../use-shortcut-text";

import { useSaveMessage } from "./reader-actions";
import { TOOLBAR_MIN_WIDTH } from "../toolbar-fit";
import { isTypingTarget } from "../typing-target";
import { DropdownMenu, MenuItem, MenuSeparator } from "./ui/Menu";

/** Shows a one-line notice, the app's toast. */
export type Notify = (toast: { text: string; tone?: "error" }) => void;
type ReaderActionDone = (action: {
  result: BatchResult;
  ids: readonly string[];
  op: MailOp;
}) => void;

interface Props {
  messageId: string | null;
  threadKey: string | null;
  derivedMatches?: readonly DerivedChunk[] | undefined;
  searchMatches?: readonly SearchMatch[] | undefined;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /**
   * Actions for the open thread, left of the search field. They fill the room
   * the search field leaves and fold into their menu when it runs out.
   */
  renderToolbar?: () => ReactNode;
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
  /** Single-pane layout: returns to the list, which then holds the search field. */
  onBack?: (() => void) | undefined;
}

export function Reader({
  messageId,
  threadKey,
  derivedMatches,
  searchMatches,
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
  onBack,
}: Props) {
  const { t } = useLingui();
  const result = useAtomValue(threadAtom(messageId));
  const thread = AsyncResult.value(result);
  const messages = useReaderMessages(
    threadKey,
    thread._tag === "Some" ? thread.value : undefined,
    messageMissing(result),
  );
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const grouping = prefs.threadGrouping;

  return (
    <main className="flex h-full w-full min-w-0 flex-col bg-white dark:bg-neutral-900">
      <header
        data-reader-toolbar
        className={`drag @container/bar flex min-h-13 shrink-0 items-center gap-3 py-3 pr-4 ${onBack ? trafficLightInset : "pl-4"}`}
      >
        {onBack && (
          <Tip label={t`Back to messages`} shortcut={BACK_SHORTCUT}>
            <button
              type="button"
              aria-label={t`Back to messages`}
              onClick={onBack}
              className={`no-drag -ml-1 shrink-0 text-a11y-muted ${iconButton}`}
            >
              <ChevronLeft className="size-5" />
            </button>
          </Tip>
        )}
        {prefs.toolbarVisible && (
          <div className="flex flex-1" style={{ minWidth: TOOLBAR_MIN_WIDTH }}>
            {renderToolbar?.()}
          </div>
        )}
        {/* Beside the toolbar, search starts at 14rem: room for a query with the scope as an
            icon. A header of 960 px leaves every default action room beside 20rem of search. */}
        {!onBack && (
          <div
            className={`flex min-w-0 ${prefs.toolbarVisible ? "flex-[0_1_14rem] @min-[960px]/bar:basis-80" : "flex-1"}`}
          >
            <SearchField value={query} onChange={onQuery} inputRef={searchRef} />
          </div>
        )}
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
          searchMatches={searchMatches}
          // Grouping off lists messages on their own; the reader shows just that one.
          single={!grouping}
          onEditDraft={onEditDraft}
          notify={notify}
          canOpenWindow
          onBack={onBack}
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
  searchMatches = [],
  selectedId,
  single,
  onEditDraft,
  notify,
  canOpenWindow,
  onSelectMessage,
  onMarkUnread,
  onActionDone,
  onComposeMessage,
  onBack,
}: {
  messages: readonly Message[];
  derivedMatches?: readonly DerivedChunk[] | undefined;
  searchMatches?: readonly SearchMatch[] | undefined;
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
  onBack?: Props["onBack"];
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
  const shown = single ? stored.filter((m) => m.id === selectedId) : stored;
  const messages = orderThread(shown, prefs.threadOrder);
  const addresses = [
    ...new Set(messages.map((m) => m.from.address.trim().toLowerCase())),
  ].toSorted();
  const known = AsyncResult.getOrElse(
    useAtomValue(knownSendersAtom(stored[0]?.accountId ?? "", addresses)),
    (): readonly string[] => [],
  );
  const imageSenders = AsyncResult.getOrElse(
    useAtomValue(imageSendersAtom),
    (): readonly string[] => [],
  );
  const isKnown = (m: Message) => known.includes(m.from.address.trim().toLowerCase());
  const [imagesLoaded, setImagesLoaded] = useAtom(
    imagesLoadedAtom((single ? selectedId : readerThreadKey(stored[0])) ?? selectedId),
  );
  // Only messages on screen at the click load; later arrivals ask again.
  const loadImages = () =>
    setImagesLoaded(new Set([...imagesLoaded, ...messages.map((m) => m.id)]));
  const loadsRemote = (m: Message) =>
    imagesLoaded.has(m.id) ||
    shouldLoadRemote(m, {
      remoteImages: prefs.remoteImages,
      imageSenders,
      knownSender: isKnown(m),
    });
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
  const matchedIds = [
    ...new Set(attachmentMatches(searchMatches).map((match) => match.messageId)),
  ].toSorted();
  const [open, setOpen] = useState(
    () => new Set([selectedId, newest?.id ?? selectedId, ...matchedIds]),
  );
  const matchedKey = JSON.stringify(matchedIds);
  const [expandedMatchKey, setExpandedMatchKey] = useState(matchedKey);
  if (expandedMatchKey !== matchedKey) {
    setExpandedMatchKey(matchedKey);
    setOpen(new Set([...open, ...matchedIds]));
  }
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
  // One notice per conversation, on the first open message still blocking remote images.
  // Finding remote content needs the body chunk's parser.
  const body = useMessageBodyState();
  const imageNoticeId =
    body && !(body instanceof Error)
      ? messages.find(
          (m) =>
            open.has(m.id) &&
            m.bodyCached !== false &&
            !loadsRemote(m) &&
            body.preparedHtml(m).hasRemote,
        )?.id
      : undefined;
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
    // The helper is duck-typed, so form fields inside a message frame count as typing too.
    const typingFind = isTypingTarget(e.target);
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
      (isTypingTarget(e.target) ||
        (e.target instanceof Element && e.target.closest('[role="menu"]')))
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
        loadImages();
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
    // The frame's keys do not reach the window, where the list's back keys live.
    if (onBack && !e.defaultPrevented && isBackKey(e)) {
      e.preventDefault();
      onBack();
      return;
    }
    if (!e.defaultPrevented && !e.repeat) {
      const action = shortcutAction(prefs.shortcutSet, e, isTypingTarget(e.target));
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
          // Wider than typing: clicks on any control or the message frame keep their own focus.
          !event.target.closest("button,a,input,textarea,select,iframe,[contenteditable]")
        )
          event.currentTarget.focus({ preventScroll: true });
      }}
      className="selectable @container/thread flex-1 overflow-y-auto px-4 pb-10 focus-visible:-outline-offset-2 @min-[520px]/thread:px-7"
    >
      <SelectedMessageAnnouncement message={messages.find((m) => m.id === activeId)} />
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
        <h2 className="min-w-0 flex-1 text-[20px] leading-tight font-bold break-words @min-[520px]/thread:text-[24px]">
          {newest?.subject || t`(No subject)`}
        </h2>
        {messages.length > 1 && (
          <div className="hidden shrink-0 gap-2 pt-1 text-[12px] text-a11y-accent @min-[520px]/thread:flex dark:text-blue-400">
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
          {messages.length > 1 && (
            <>
              <MenuItem
                icon={ChevronsUpDown}
                shortcut={shortcut("expandAll")}
                disabled={messages.every((m) => open.has(m.id))}
                onClick={() => expand(true)}
              >
                {t`Expand all`}
              </MenuItem>
              <MenuItem
                icon={ChevronsDownUp}
                shortcut={shortcut("collapseAll")}
                disabled={open.size === 0}
                onClick={() => expand(false)}
              >
                {t`Collapse all`}
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          {canOpenWindow && (
            <MenuItem icon={AppWindow} onClick={() => run(openThreadWindow(selectedId))}>
              {t`Open in New Window`}
            </MenuItem>
          )}
          {canOpenWeb && (
            <MenuItem
              onClick={() =>
                run(
                  withMail((call) => call("CopyMessageLink", { id: selectedId, kind: "web" })).pipe(
                    Effect.matchCause({
                      onSuccess: () => notify({ text: t`Webmail link copied` }),
                      onFailure: (cause) => notify({ text: causeText(i18n, cause), tone: "error" }),
                    }),
                  ),
                )
              }
            >{t`Copy webmail link`}</MenuItem>
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
              searchMatches={searchMatches.filter((match) => match.messageId === m.id)}
              onActivate={() => activate(m.id)}
              active={m.id === activeId}
              onMessageOp={(op) => messageAction(m.id, op)}
              onUnreadFrom={() => unreadFrom(m.id)}
              onOpenSingle={() => run(openMessageWindow(m.id))}
              thread={stored}
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
              remote={loadsRemote(m)}
              imageNotice={m.id === imageNoticeId}
              onLoadImages={loadImages}
              imageSenders={imageSenders}
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
              className={`@container/message flex w-full gap-3 py-3 text-left ${m.id === activeId ? "border-l-2 border-blue-400 pl-2" : ""}`}
            >
              <Avatar message={m} />
              <span className="min-w-0 flex-1">
                <MessageHead message={m} />
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
        <span className="min-w-0 text-[14px] font-semibold @min-[520px]/message:flex-1">
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
        <span className="flex min-w-0 items-baseline gap-x-2 text-[12px] @max-[420px]/message:flex-wrap @min-[520px]/message:max-w-[65%]">
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
          className="block text-[12px] text-a11y-danger"
        >{t`Sender authentication failed (DMARC)`}</span>
      )}
      {senderSpoofed(m.from) && (
        <span
          role="alert"
          className="block text-[12px] text-a11y-danger"
        >{t`The sender name contains a different email address.`}</span>
      )}
    </span>
  );
}

function Expanded({
  message: m,
  searchMatches,
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
  onPrint: (pdf: boolean) => void;
  onCollapse?: (() => void) | undefined;
  onEditDraft?: (() => void) | undefined;
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
  /** Every stored message of the thread, for folding repeated quotes. */
  thread: readonly Message[];
  findQuery: string;
  findIndex: number;
  onMatches: ((count: number) => void) | undefined;
}) {
  const { t } = useLingui();
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
            <MessageHead message={m} onSearchSender={onSearchSender} />
            <span
              className="mt-0.5 block truncate text-[13px] text-a11y-muted"
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
    </article>
  );
}

/** Mount the live region empty before announcing a newly opened thread. */
function SelectedMessageAnnouncement({ message }: { message: Message | undefined }) {
  const { t } = useLingui();
  const text = message
    ? `${t`Selected message`}: ${displayName(message.from)}, ${message.subject || t`(No subject)`}`
    : "";
  const region = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (region.current) region.current.textContent = text;
  }, [text]);
  return <output ref={region} aria-live="polite" aria-atomic="true" className="sr-only" />;
}

const noPhoto = Atom.make(AsyncResult.success(null));
function Avatar({ message: m }: { message: Message }) {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const photo = AsyncResult.getOrElse(
    useAtomValue(prefs.contactPhotos ? contactPhotoAtom(m.accountId, m.from.address) : noPhoto),
    () => null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-[15px] font-semibold text-white"
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
