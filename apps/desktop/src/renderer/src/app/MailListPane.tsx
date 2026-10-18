import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { moveSourceLabel } from "@openmail/core/schema";
import { SquarePen } from "lucide-react";
import { useContext, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { Account, Label } from "../../../shared/api";
import { Downloads } from "../features/downloads/Downloads";
import { BatchActions, BatchMenuItems } from "../features/mail-list/BatchActions";
import { MessageList } from "../features/mail-list/MessageList";
import { FolderActions } from "../features/organize/FolderActions";
import { labelCreationAtom, snoozeIdsAtom } from "../features/organize/organize-state";
import { SearchField } from "../features/search/SearchField";
import { filterSeedAtom } from "../features/settings/filter-seed";
import { MailStatusNotice } from "../features/sync-status/MailStatusNotice";
import { UndoHistory } from "../features/undo/UndoHistory";
import { useShortcutText } from "../i18n/use-shortcut-text";
import { supportsInInboxFilter } from "../lib/folder-actions";
import { accountName } from "../lib/format";
import { isDesktop } from "../lib/platform";
import { spaceAccounts } from "../lib/view";
import { syncStateAtom } from "../state/events";
import { syncNow, useRunMail } from "../state/mail";
import { recentSearches } from "../state/recent-searches";
import { serverList } from "../state/threads";
import { iconButton } from "../ui/styles";
import type { ToastState } from "../ui/Toast";
import { Tip } from "../ui/Tip";
import type { useMailActions } from "./use-mail-actions";
import type { useMailCompose } from "./use-mail-compose";
import type { useMailSelection } from "./use-mail-selection";
import type { usePaneNavigation } from "./use-pane-navigation";

/** The message list pane with its notices, search, folder actions and row actions. */
export function MailListPane({
  navigation,
  mailActions,
  paneNav,
  startCompose,
  openSavedDraft,
  accountList,
  labels,
  labelMap,
  online,
  docked,
  narrow,
  composeButton,
  leading,
  title,
  showAccount,
  batch,
  batchToolbar,
  say,
  undoHistory,
  onUndo,
  searchRef,
}: {
  navigation: ReturnType<typeof useMailSelection>;
  mailActions: ReturnType<typeof useMailActions>;
  paneNav: ReturnType<typeof usePaneNavigation>;
  startCompose: ReturnType<typeof useMailCompose>["startCompose"];
  openSavedDraft: ReturnType<typeof useMailCompose>["openSavedDraft"];
  accountList: readonly Account[];
  labels: readonly Label[];
  labelMap: ComponentProps<typeof MessageList>["labels"];
  online: boolean;
  docked: boolean;
  narrow: boolean;
  /** No docked sidebar or rail shows New message, so the list header offers it. */
  composeButton: boolean;
  leading: ReactNode;
  title: string;
  showAccount: boolean;
  batch: ComponentProps<typeof BatchMenuItems>;
  batchToolbar: ComponentProps<typeof BatchActions> | null;
  say: (toast: Omit<ToastState, "id">) => void;
  undoHistory: ComponentProps<typeof UndoHistory>["entries"];
  onUndo: ComponentProps<typeof UndoHistory>["onUndo"];
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useLingui();
  const run = useRunMail();
  const shortcutText = useShortcutText();
  const syncState = useAtomValue(syncStateAtom);
  const registry = useContext(RegistryContext);
  const setLabelCreation = useAtomSet(labelCreationAtom);
  const setSnoozeIds = useAtomSet(snoozeIdsAtom);
  const setFilterSeed = useAtomSet(filterSeedAtom);
  const {
    view,
    query,
    setQuery,
    search,
    filters,
    setFilters,
    selection,
    setSelectedId,
    listRef,
    selectionSource,
    threads,
    loadMore,
    list,
    listQuery,
    deleteFolder,
    folderAccountIds,
    prefs,
  } = navigation;
  const { rowState, act, requestPermanentDelete } = mailActions;
  return (
    <MessageList
      leading={leading}
      notice={
        <MailStatusNotice
          accounts={accountList}
          space={spaceAccounts(view.space, accountList)}
          online={online}
          syncState={syncState}
          accountIssues={!docked}
          onReauth={mailActions.reauth}
          onFocusList={() => navigation.focusList(selection.focus)}
        />
      }
      emptyActions={{
        onClearSearch: () => setQuery(""),
        onCompose: () => startCompose("new"),
        onSync: () => run(syncNow),
        syncing: syncState.running,
      }}
      onRetrySearch={() => {
        if (listQuery?.search) registry.refresh(serverList(listQuery));
      }}
      accountLabel={(id) => {
        const account = accountList.find((a) => a.id === id);
        return account ? accountName(account) : id;
      }}
      searchBar={
        !prefs.readingPaneVisible || narrow ? (
          <SearchField
            value={query}
            onChange={setQuery}
            onEnterResults={navigation.enterResults}
            inputRef={searchRef}
          />
        ) : undefined
      }
      // One pane at a time leaves no reader toolbar, so selected rows get their actions above the
      // list. Only while the list shows, so the reader's bar and this one never share a label picker.
      selectionBar={
        narrow && !paneNav.shown.reader && batchToolbar ? (
          <BatchActions {...batchToolbar} />
        ) : undefined
      }
      resetKey={JSON.stringify([view, search, filters])}
      title={title}
      threads={list}
      loading={threads.loading}
      loadingMore={threads.loadingMore}
      loadError={threads.loadError}
      exhausted={threads.exhausted}
      showAccount={showAccount}
      searching={search !== ""}
      searchingServer={threads.searchingServer}
      searchTruncated={threads.searchTruncated}
      searchErrorAccounts={threads.searchErrorAccounts}
      searchReauthAccounts={threads.searchReauthAccounts}
      searchInputInvalid={threads.searchInputInvalid}
      searchIgnored={threads.searchIgnored}
      searchQuery={listQuery ?? undefined}
      filters={filters}
      inLabel={supportsInInboxFilter(view, accountList)}
      onFilters={setFilters}
      folderActions={
        <>
          {composeButton && (
            <Tip label={t`New message`} shortcut={shortcutText("compose")}>
              <button
                type="button"
                aria-label={t`New message`}
                onClick={() => startCompose("new")}
                className={`no-drag text-a11y-muted ${iconButton}`}
              >
                <SquarePen className="size-4.5" />
              </button>
            </Tip>
          )}
          {/* Downloads land on the Mac; the browser keeps its own list. */}
          {isDesktop() && <Downloads />}
          <UndoHistory entries={undoHistory} onUndo={onUndo} />
          <FolderActions
            folder={{
              mailbox: view.mailbox,
              ...(folderAccountIds ? { accountIds: folderAccountIds } : {}),
              ...(view.label ? { label: view.label.id } : {}),
            }}
            notify={(text, error) => say({ text, ...(error ? { tone: "error" as const } : {}) })}
          />
        </>
      }
      labels={labelMap}
      selectedId={selection.focus}
      selectedIds={selection.ids}
      listRef={listRef}
      selectionSource={selectionSource}
      rowActions={{
        batchMenu: <BatchMenuItems {...batch} />,
        grouped: prefs.threadGrouping,
        currentLabel: view.label?.id,
        mailbox: view.mailbox,
        labels,
        stateOf: rowState,
        onOp: (m, state, op) => act(op, {}, { id: m.id, state }),
        onSwipeOp: (m, state, op) =>
          act(op, { confirmedIds: new Set([m.id]) }, { id: m.id, state }),
        onCompose: (m, mode, asAttachment) => startCompose(mode, asAttachment, m.id),
        onPermanentDelete: deleteFolder
          ? (thread) => requestPermanentDelete([thread.id])
          : undefined,
        onCreate: (thread, move) =>
          setLabelCreation({
            accountId: thread.accountId,
            move,
            threads: [thread.id],
            flat: !prefs.threadGrouping,
            removeLabelId: moveSourceLabel(view.mailbox, view.label?.id),
          }),
        onSnooze: (thread) => setSnoozeIds([thread.id]),
        onFilter: (thread) =>
          setFilterSeed({ accountId: thread.accountId, from: thread.from.address }),
        onOpenWindow: (m) =>
          view.mailbox === "drafts" ? openSavedDraft(m.id) : navigation.openWindow(m.id),
      }}
      onSelect={(id, modifiers) => {
        if (threads.loading) return;
        // Opening a result keeps its search in Recent.
        if (search) recentSearches.add(search);
        if (view.mailbox !== "drafts") {
          navigation.selectRow(id, modifiers);
          if (!modifiers.toggle && !modifiers.range) paneNav.openReader();
          return;
        }
        // Drafts open in the compose window.
        setSelectedId(id);
        openSavedDraft(id);
      }}
      onEndReached={() => {
        loadMore();
      }}
    />
  );
}
