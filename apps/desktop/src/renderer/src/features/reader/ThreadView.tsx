import {
  DEFAULT_PREFS,
  orderThread,
  remoteImageMode,
  threadExpansion,
  type ReaderZoom,
  type SearchMatch,
} from "@openmail/core/schema";
import { matchesShortcut, shortcutAction, type ShortcutSet } from "../../../../shared/shortcuts";
import type { DerivedChunk, Message } from "../../../../shared/api";
import type { Notify } from "./notify";
import { useLingui } from "@lingui/react/macro";
import { openMessageWindow, openThreadWindow, useRunMail } from "../../state/mail";
import { useShortcutText } from "../../i18n/use-shortcut-text";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { prefsAtom } from "../../state/queries";
import { AsyncResult } from "effect/reactivity";
import { setPrefsAtom } from "../../state/mutations";
import { useThreadPrint } from "./use-thread-print";
import { FindBar } from "./FindBar";
import { useCallback, useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { useSaveMessage } from "./reader-actions";
import { readerMessageId } from "./reader-selection";
import { useDarkMode } from "./use-dark-mode";
import { messageBackgroundAtom } from "../../state/ui";
import { isDesktop } from "../../lib/platform";
import { useMessageBodyState } from "./body/MessageBodyShell";
import { Keys } from "../../state/keys";
import { THREAD_EXPANSION_EVENT, ThreadViewMenuItems, stepZoom } from "./ThreadViewMenu";
import { isTypingTarget } from "../../lib/typing-target";
import { readerFindAction } from "./reader-shortcuts";
import { jumpReaderSelection } from "../../lib/jump-selection";
import { readerSelectedText } from "./quote-selection";
import { isBackKey } from "../../lib/responsive-layout";
import { forwardFrameKey } from "./frame/forward-frame-key";
import { constVoid } from "effect/Function";
import {
  Avatar,
  Expanded,
  MessageHead,
  ReplyBar,
  SelectedMessageAnnouncement,
} from "./ThreadMessage";
import { ThreadSummary, TriageChip } from "../ai";
import { DropdownMenu, MenuItem, MenuSeparator } from "../../ui/Menu";
import { touchIcon } from "../../ui/styles";
import { AppWindow, MoreHorizontal } from "lucide-react";
import { NO_SEARCH_HITS, SearchHitBar } from "../search";
import { MediaMatches } from "./MediaMatches";
import { RawMessageDialog } from "./lazy";
import { runWindowShortcut } from "./frame/window-shortcut.js";
import { useRemoteImages } from "./use-remote-images.js";
import { type ReaderActionDone, useThreadMailActions } from "./use-thread-mail-actions.js";

/** Opens the composer to reply to or forward one message of the thread. */
export type ComposeMessage = (
  id: string,
  mode: "reply" | "replyAll" | "forward",
  attachment?: boolean,
) => void;

/** ⌘+ / ⌘= bigger, ⌘- smaller, ⌘0 normal. */
function zoomStep(e: KeyboardEvent, set: ShortcutSet): -1 | 0 | 1 | null {
  if (matchesShortcut(set, "zoomIn", e)) return 1;
  if (matchesShortcut(set, "zoomOut", e)) return -1;
  if (matchesShortcut(set, "zoomReset", e)) return 0;
  return null;
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
  searchTerms = [],
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
  menuInToolbar = false,
}: {
  messages: readonly Message[];
  derivedMatches?: readonly DerivedChunk[] | undefined;
  searchMatches?: readonly SearchMatch[] | undefined;
  /** Words of the search that opened the thread, marked in each body. */
  searchTerms?: readonly string[];
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
  onComposeMessage?: ComposeMessage | undefined;
  onBack?: (() => void) | undefined;
  /** The toolbar's Conversation actions menu holds the thread's commands, so the subject row has no menu. */
  menuInToolbar?: boolean;
}) {
  const { t } = useLingui();
  const run = useRunMail();
  const shortcut = useShortcutText();
  const prefsResult = useAtomValue(prefsAtom);
  const prefs = AsyncResult.getOrElse(prefsResult, () => DEFAULT_PREFS);
  // Images wait for the stored mode; the default would load them for people who chose "ask".
  const imageMode = remoteImageMode(AsyncResult.isSuccess(prefsResult) ? prefsResult.value : null);
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
  const [hitIndex, setHitIndex] = useState(0);
  const [hitCount, setHitCount] = useState(0);
  const reportHits = useCallback((count: number) => setHitCount(count), []);
  const nextHit = (direction: number) =>
    setHitIndex((index) => (hitCount ? (index + direction + hitCount) % hitCount : 0));
  const hits = searchTerms.length > 0 && hitCount > 0;
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
      setHitIndex(0);
      setHitCount(0);
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
  const shown = single ? stored.filter((m) => m.id === selectedId) : stored;
  const messages = orderThread(shown, prefs.threadOrder);
  const { imageSenders, loadImages, loadsRemote } = useRemoteImages({
    stored,
    messages,
    single,
    selectedId,
    imageMode,
  });
  const {
    messageAction,
    unreadFrom,
    webLabel,
    canShare,
    shareLink,
    canOpenWeb,
    searchSender,
    openWeb,
  } = useThreadMailActions({ accountId: stored[0]?.accountId, notify, onMarkUnread, onActionDone });

  const newest = messages.reduce<Message | undefined>(
    (a, m) => (!a || m.date >= a.date ? m : a),
    undefined,
  );
  // The reply bar answers the newest message someone sent, not a draft of a reply.
  const replyTarget =
    messages
      .filter((m) => !m.labels.includes("DRAFT"))
      .reduce<Message | undefined>((a, m) => (!a || m.date >= a.date ? m : a), undefined) ?? newest;
  const matchedIds = [
    ...new Set(
      searchMatches
        .filter((match) => match.source === "body" || match.source === "attachment")
        .map((match) => match.messageId),
    ),
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
    setHitIndex(0);
    setHitCount(0);
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
      const findAction = readerFindAction(prefs.shortcutSet, e, finding, hits);
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
      if (findAction === "previous" || findAction === "next") {
        e.preventDefault();
        (finding ? findNext : nextHit)(findAction === "next" ? 1 : -1);
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
        if (isDesktop()) {
          e.preventDefault();
          save(active.id);
        }
        break;
      case "searchSender":
        e.preventDefault();
        searchSender(active);
        break;
      case "openMessageWeb":
        if (canOpenWeb && isDesktop()) {
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
    if (!e.defaultPrevented && !e.repeat && isDesktop())
      runWindowShortcut(e, prefs.shortcutSet, run);
    // List and mail keys such as archive, J/K and star listen on the window.
    forwardFrameKey(e);
  };
  const expandFromMenu = useEffectEvent((expanded: boolean) => expand(expanded));
  useEffect(() => {
    const listener = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "boolean")
        expandFromMenu(event.detail);
    };
    window.addEventListener(THREAD_EXPANSION_EVENT, listener);
    return () => window.removeEventListener(THREAD_EXPANSION_EVENT, listener);
  }, []);
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
      // Nothing in the thread is wider than the pane, but scrollIntoView (find
      // hits, selection jumps) can still scroll its hidden x axis.
      onScroll={(event) => {
        if (event.currentTarget.scrollLeft !== 0) event.currentTarget.scrollLeft = 0;
      }}
      className="selectable @container/thread min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-x-none [scrollbar-gutter:stable] px-4 pb-10 focus-visible:-outline-offset-2 @min-[520px]/thread:px-7"
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
          <div className="hidden shrink-0 gap-2 pt-1 text-footnote text-a11y-accent @min-[520px]/thread:flex dark:text-blue-400">
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
        {!menuInToolbar && (
          <DropdownMenu
            trigger={
              <button
                type="button"
                aria-label={t`More actions`}
                className={`mt-1 rounded-control p-1.5 ${touchIcon} text-a11y-muted outline-offset-0 outline-a11y-focus hover:bg-fill-hover hover:text-neutral-800 focus-visible:outline-[3px] data-popup-open:bg-fill-pressed dark:hover:text-neutral-100`}
              >
                <MoreHorizontal className="size-4" />
              </button>
            }
          >
            {canOpenWindow && (
              <>
                <MenuItem icon={AppWindow} onClick={() => run(openThreadWindow(selectedId))}>
                  {t`Open in new window`}
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <ThreadViewMenuItems
              messages={messages}
              selectedId={selectedId}
              single={single}
              notify={notify}
              print={print}
            />
          </DropdownMenu>
        )}
      </div>
      {finding && (
        <FindBar
          inputRef={findRef}
          query={findQuery}
          onQuery={(query) => {
            setFindQuery(query);
            setFindIndex(0);
          }}
          index={findIndex}
          count={findCount}
          onStep={findNext}
          onClose={closeFind}
        />
      )}
      {!finding && hits && <SearchHitBar index={hitIndex} count={hitCount} onStep={nextHit} />}
      <MediaMatches chunks={derivedMatches} />
      <div className="divide-y divide-separator">
        {messages.map((m) =>
          open.has(m.id) ? (
            <Expanded
              key={m.id}
              message={m}
              searchMatches={searchMatches.filter((match) => match.messageId === m.id)}
              searchHits={
                searchTerms.length
                  ? {
                      terms: searchTerms,
                      index: activeId === m.id && !finding ? hitIndex : -1,
                      onCount: activeId === m.id ? reportHits : undefined,
                    }
                  : NO_SEARCH_HITS
              }
              onActivate={() => activate(m.id)}
              active={m.id === activeId}
              onMessageOp={(op) => messageAction(m.id, op)}
              onUnreadFrom={() => unreadFrom(m.id)}
              onOpenSingle={isDesktop() ? () => run(openMessageWindow(m.id)) : undefined}
              thread={stored}
              findQuery={finding && activeId === m.id ? findQuery : ""}
              findIndex={findIndex}
              onMatches={activeId === m.id ? reportMatches : undefined}
              onSave={isDesktop() ? () => save(m.id) : undefined}
              onSearchSender={() => searchSender(m)}
              onShare={canShare ? (kind) => shareLink(m.id, kind) : undefined}
              onOpenWeb={canOpenWeb && isDesktop() ? () => openWeb(m.id) : undefined}
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
              onPrint={isDesktop() ? (pdf) => print(m.id, pdf, m.id) : undefined}
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
                <span className="mt-0.5 block truncate text-body text-a11y-muted">{m.snippet}</span>
              </span>
            </button>
          ),
        )}
      </div>
      {onComposeMessage && replyTarget && (
        <ReplyBar
          onCompose={(mode, attachment) => onComposeMessage(replyTarget.id, mode, attachment)}
        />
      )}
      {raw && <RawMessageDialog messageId={raw} notify={notify} onClose={() => setRaw(null)} />}
    </div>
  );
}
