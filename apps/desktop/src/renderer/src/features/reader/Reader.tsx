import type { DerivedChunk } from "../../../../shared/api";
import { DEFAULT_PREFS, searchHighlightTerms, type SearchMatch } from "@openmail/core/schema";
import type { ReactNode, RefObject } from "react";
import type { Notify } from "./notify";
import { ThreadView, type ComposeMessage } from "./ThreadView";
import type { ReaderActionDone } from "./use-thread-mail-actions";
import { Trans, useLingui } from "@lingui/react/macro";
import { useAtomValue } from "@effect/atom-react";
import { prefsAtom, threadAtom } from "../../state/queries";
import { AsyncResult } from "effect/reactivity";
import { useReaderMessages } from "./reader-selection";
import { messageMissing } from "../../lib/errors";
import { useThreadPrint } from "./use-thread-print";
import { ThreadViewMenuItems } from "./ThreadViewMenu";
import { iconButton, titlebarRow } from "../../ui/styles";
import { TrafficLightSpace } from "../../ui/TrafficLights";
import { Tip } from "../../ui/Tip";
import { BACK_SHORTCUT } from "../../lib/responsive-layout";
import { ChevronLeft, Mail } from "lucide-react";
import { TOOLBAR_MIN_WIDTH } from "../../lib/toolbar-fit";
import { SearchField } from "../search";
import { isDesktop } from "../../lib/platform";

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
  renderToolbar?: (threadMenu: ReactNode) => ReactNode;
  /** Opens a draft of the thread in the compose window, by local draft id or message id. */
  onEditDraft: (messageId: string) => void;
  notify: Notify;
  onSelectMessage: (id: string) => void;
  onMarkUnread: () => void;
  onActionDone: ReaderActionDone;
  onComposeMessage: ComposeMessage;
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
  const print = useThreadPrint(notify);
  // With the toolbar showing, the thread's commands join its menu instead of a second "…".
  const menuInToolbar = prefs.toolbarVisible && renderToolbar !== undefined;
  const threadMenu =
    messageId && messages ? (
      <ThreadViewMenuItems
        messages={messages}
        selectedId={messageId}
        single={!grouping}
        notify={notify}
        print={print}
      />
    ) : null;

  return (
    <main className="flex h-full w-full min-w-0 flex-col bg-surface">
      <header data-reader-toolbar className={`${titlebarRow} @container/bar gap-3 pr-4 pl-4`}>
        <TrafficLightSpace />
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
            {renderToolbar?.(threadMenu)}
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
          // Lexical matches only: a related (semantic) result has no words to mark.
          searchTerms={searchMatches?.length ? searchHighlightTerms({ search: query }) : []}
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
          canOpenWindow={isDesktop()}
          onBack={onBack}
          menuInToolbar={menuInToolbar}
        />
      )}
    </main>
  );
}
