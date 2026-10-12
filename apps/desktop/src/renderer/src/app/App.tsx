import { canCall, isDesktop } from "../lib/platform";
import { focusedSenderMessage, threadStateFor } from "../lib/focused-inbox";
import { Separator, Group, Panel } from "react-resizable-panels";
import { useCallback, useRef, useState, type ComponentProps, useEffect } from "react";
import type { Label, MailOp } from "../../../shared/api";
import { useAtom, useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { moveSourceLabel } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { createPortal } from "react-dom";
import { PANE_MIN } from "../../../shared/layout";
import { usePanelLayout } from "./use-panel-layout";
import { useMailLayout } from "../lib/responsive-layout";
import { editingProfileAtom } from "../features/accounts/profile-editing";
import {
  labelCreationAtom,
  labelPickerAtom,
  pickerModeAtom,
  snoozeIdsAtom,
} from "../features/organize/organize-state";
import { filterSeedAtom } from "../features/settings/filter-seed";
import { goToFolderAtom } from "../features/sidebar/go-to-folder";
import { useMailActions } from "./use-mail-actions";
import { useMailCompose } from "./use-mail-compose";
import { useMailSelection } from "./use-mail-selection";
import { useMailShortcuts } from "./use-mail-shortcuts";
import { useNativeMenuBridge } from "./use-native-menu-bridge";
import { usePaneNavigation } from "./use-pane-navigation";
import { Assistant } from "../features/ai/AiPanel";
import { FolderActions } from "../features/organize/FolderActions";
import {
  AddAccountDialog,
  Composer,
  CreateLabelDialog,
  Feedback,
  FilterEditor,
  Settings,
  ShortcutHelp,
} from "./LazyDialogs";
import { ProfileEditor } from "../features/accounts/lazy";
import { Proposals } from "../features/ai/lazy";
import { PermanentDeletePermission } from "../features/organize/PermanentDeletePermission";
import { FailedOpNotice } from "../features/sync-status/FailedOpNotice";
import { UpdateNotice } from "../features/updates/UpdateNotice";
import { RemoteImagesPrompt } from "../features/reader/RemoteImagesPrompt";
import { Downloads } from "../features/downloads/Downloads";
import { numberedFavorites } from "../features/sidebar/favorite-navigation";
import { supportsInInboxFilter } from "../lib/folder-actions";
import { readerThreadKey, type ReaderSelection } from "../features/reader/reader-selection";

import { BatchActions, BatchMenuItems } from "../features/mail-list/BatchActions";
import { MailPanels } from "./MailPanels";
import { MessageList } from "../features/mail-list/MessageList";
import { Overview } from "../features/overview/Overview";
import { DefaultProfilesPrompt, ProfileSwitcher } from "../features/accounts/ProfileSettings";
import { Reader, useThreadPrint } from "../features/reader/Reader";
import { Sidebar, SidebarToggle } from "../features/sidebar/Sidebar";
import { SidebarRail } from "../features/sidebar/SidebarRail";
import { buttonPrimary, buttonSecondary } from "../ui/styles";
import { FocusedInboxPermission } from "../features/organize/FocusedInboxActions";
import { ThreadActions } from "../features/organize/ThreadActions";
import type { ThreadState } from "../lib/focused-inbox";
import { Toast, type ToastState } from "../ui/Toast";
import { Alert, alertButton, AlertCancel, alertDanger, alertPrimary, Drawer } from "../ui/Dialog";
import { recentSearches } from "../state/recent-searches";
import { SearchField } from "../features/search/SearchField";
import { UndoHistory } from "../features/undo/UndoHistory";
import { messageMissing, causeText } from "../lib/errors";
import { MailClient } from "../state/rpc";
import { useDesktopLabels } from "../state/desktop";
import { liveUpdatesAtom, syncProgressAtom, syncStateAtom } from "../state/events";
import { networkChanged, syncNow, useRunMail } from "../state/mail";
import { MailStatusNotice } from "../features/sync-status/MailStatusNotice";
import { useOnline } from "../lib/use-online";
import { accountName } from "../lib/format";
import {
  accountsAtom,
  labelPreferencesAtom,
  labelsAtom,
  profilesAtom,
  proposalsAtom,
  signaturesAtom,
  sendAsAtom,
  threadAtom,
  unreadCountsAtom,
} from "../state/queries";
import { useBatchUndo } from "../state/undo";
import { dialogAtom, openMessageAtom, signInAgainAtom } from "../state/ui";
import {
  ALL,
  inboxCategoryNames,
  categoryAccounts,
  MAILBOX_NAMES,
  OVERVIEW,
  scopeAccountIds,
  spaceAccounts,
} from "../lib/view";

import { GoToFolder } from "../features/organize/GoToFolder";
import { SnoozeDialog } from "../features/organize/SnoozeDialog";

export function App({ composeId }: { composeId?: string }) {
  // The one subscription to the main process's events, and the RPC runtime,
  // live as long as the window.
  useAtomMount(MailClient.runtime);
  useAtomMount(liveUpdatesAtom);
  const run = useRunMail();
  const online = useOnline(() => run(networkChanged));
  useDesktopLabels();
  const strings = useAppMessages();
  const { t, i18n } = useLingui();

  const layout = useMailLayout();
  const [editing, setEditing] = useAtom(editingProfileAtom);
  const syncState = useAtomValue(syncStateAtom);
  const progress = useAtomValue(syncProgressAtom);
  const [dialog, setDialog] = useAtom(dialogAtom);
  const [labelPicker, setLabelPicker] = useAtom(labelPickerAtom);
  const pickerMode = useAtomValue(pickerModeAtom);
  const [goToFolder, setGoToFolder] = useAtom(goToFolderAtom);
  const [labelCreation, setLabelCreation] = useAtom(labelCreationAtom);
  const [snoozeIds, setSnoozeIds] = useAtom(snoozeIdsAtom);
  const [filterSeed, setFilterSeed] = useAtom(filterSeedAtom);
  const searchRef = useRef<HTMLInputElement>(null);

  const [optionalAccountId, setOptionalAccountId] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") {
        setOptionalAccountId(event.detail);
        setDialog("settings");
      }
    };
    window.addEventListener("openmail:optional-services", open);
    return () => window.removeEventListener("openmail:optional-services", open);
  }, [setDialog]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const hideToast = useCallback(() => setToast(null), [setToast]);
  const say = useCallback(
    (next: Omit<ToastState, "id">) => setToast({ ...next, id: Date.now() }),
    [setToast],
  );
  const {
    undoRef,
    showUndo,
    history: undoHistory,
    undoRestored,
  } = useBatchUndo({
    notify: say,
    clearToast: hideToast,
    label: t`Undo`,
    failureText: (cause) => {
      const reason = causeText(i18n, cause);
      return t`Action failed: ${reason}`;
    },
  });

  const accounts = useAtomValue(accountsAtom);
  const refreshAccounts = useAtomRefresh(accountsAtom);
  const accountList = AsyncResult.getOrElse(accounts, () => []);
  // Closing the first-run dialog leaves an empty window that still offers Add account.
  const [firstRunClosed, setFirstRunClosed] = useState(false);
  const [signInAgainId, setSignInAgain] = useAtom(signInAgainAtom);
  const signInAgain =
    dialog === "add" ? accountList.find((a) => a.id === signInAgainId) : undefined;
  useEffect(() => {
    if (dialog !== "add" && signInAgainId !== null) setSignInAgain(null);
  }, [dialog, signInAgainId, setSignInAgain]);
  const profileList = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const counts = AsyncResult.getOrElse(useAtomValue(unreadCountsAtom), () => ({}));
  const navigation = useMailSelection({
    accountsReady: accounts._tag === "Success",
    accountList,
    run,
  });
  const {
    view,
    query,
    setQuery,
    search,
    filters,
    setFilters,
    selection,
    selectedId,
    setSelectedId,
    deleteRequest,
    setDeleteRequest,
    listRef,
    selectionSource,
    threads,
    loadMore,
    list,
    listQuery,
    deleteFolder,
    folderAccountIds,
    scopeKey,
    batchRows,
    selected,
    prefs,
    setReadTarget,
    switchSpace,
    changeView,
  } = navigation;

  const scope = scopeAccountIds(view, accountList);
  const filterAccount = filterSeed
    ? accountList.find((a) => a.id === filterSeed.accountId)
    : undefined;

  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom()), () => []);
  const labelPreferences = AsyncResult.getOrElse(useAtomValue(labelPreferencesAtom), () => []);
  const favorites = numberedFavorites(view, accountList, labels, labelPreferences);
  const labelMap = labelsById(labels);

  const [openMessage, setOpenMessage] = useAtom(openMessageAtom);
  const threadResult = useAtomValue(threadAtom(selectedId));
  const openThread = AsyncResult.value(threadResult);
  const messages =
    !messageMissing(threadResult) && openThread._tag === "Some" ? openThread.value : undefined;
  const currentReaderThreadKey = readerThreadKey(selected ?? messages?.[0]);
  // The route's message belongs to the open thread: opening another thread drops it.
  const readerSelection: ReaderSelection | null =
    openMessage && currentReaderThreadKey
      ? { threadKey: currentReaderThreadKey, id: openMessage }
      : null;
  const proposals = AsyncResult.getOrElse(useAtomValue(proposalsAtom), () => []);
  const signatures = AsyncResult.getOrElse(useAtomValue(signaturesAtom), () => []);
  /** The unread thread just opened with select(); it is marked read after the delay in preferences. */
  const print = useThreadPrint((next) => say(next));

  const selectedAccount = accountList.find(
    (a) => a.id === (selected?.accountId ?? messages?.[0]?.accountId),
  );
  const stateMessages = prefs.threadGrouping
    ? messages
    : messages?.filter((message) => message.id === selectedId);
  const aliasResult = useAtomValue(sendAsAtom);
  const aliases = AsyncResult.getOrElse(aliasResult, () => []);
  const focusedMessage = AsyncResult.isSuccess(aliasResult)
    ? focusedSenderMessage(
        stateMessages,
        [...accountList.map((account) => account.email), ...aliases.map((alias) => alias.address)],
        readerSelection?.threadKey === currentReaderThreadKey ? readerSelection.id : undefined,
      )
    : undefined;
  const threadState: ThreadState | null =
    selectedAccount && stateMessages
      ? threadStateFor(selectedAccount.provider, stateMessages, focusedMessage)
      : null;
  const threadLabels = labels.filter((l) => l.accountId === selectedAccount?.id);

  const mailActions = useMailActions({
    messages: strings,
    navigation,
    accountList,
    labels,
    run,
    say,
    showUndo,
    selectedAccount,
  });
  const {
    deleteKeyPrompt,
    setDeleteKeyPrompt,
    permanentRequest,
    setPermanentRequest,
    permissionAccount,
    setPermissionAccount,
    requestPermanentDelete,
    rowState,
    act,
    applyDeleteKey,
  } = mailActions;

  const composition = useMailCompose({
    messages: strings,
    navigation,
    composeId,
    run,
    accountList,
    signatures,
    say,
    readerSelection,
    currentReaderThreadKey,
    undoRef,
    setToast,
  });
  const {
    compose,
    popOutRequested,
    closeRequested,
    crashFeedback,
    signatureFor,
    quotePrompt,
    setQuotePrompt,
    sendAgain,
    startCompose,
    openSavedDraft,
    openProposal,
    popOut,
    feedbackDraft,
    closeCompose,
    discard,
    send,
  } = composition;

  useNativeMenuBridge({
    messages: strings,
    searchRef,
    navigation,
    composition,
    run,
    threadState,
    say,
    accountList,
    undoRef,
  });

  const paneNav = usePaneNavigation({ layout, navigation, run });
  useMailShortcuts({
    searchRef,
    navigation,
    panes: paneNav,
    mailActions,
    composition,
    run,
    profileList,
    favorites,
    undoRef,
    openWindow: navigation.openWindow,
    threadState,
    print,
  });

  const hasAccounts = accountList.length > 0;
  const viewAccount = accountList.find((a) => a.id === (view.label?.accountId ?? view.accountId));
  const categorized = categoryAccounts(view, accountList);
  const category = view.label
    ? inboxCategoryNames(
        categorized.length > 0 && categorized.every((a) => a.provider === "outlook"),
      )[view.label.id]
    : undefined;
  const baseTitle = view.label
    ? category
      ? i18n._(category)
      : (labelMap.get(`${view.label.accountId}/${view.label.id}`)?.name ?? t`Label`)
    : i18n._(MAILBOX_NAMES[view.mailbox]);
  const user = viewAccount?.email.split("@")[0];
  const title = viewAccount ? t`${baseTitle}: ${user}` : baseTitle;

  const { docked, paneMode, savedLayout, mailOrientation } = usePanelLayout({
    prefs,
    hasAccounts,
    view,
    mode: layout.mode,
  });
  const { host: listHost, slot: listSlot } = usePaneHost();
  const { host: readerHost, slot: readerSlot } = usePaneHost();
  if (composeId)
    return (
      <div className="h-screen bg-surface">
        {compose && (
          <Composer
            key={compose.id}
            draft={compose}
            accounts={accountList}
            signatureFor={signatureFor}
            onClose={closeCompose}
            onDiscard={discard}
            onSend={send}
            standalone
            closeRequested={closeRequested}
          />
        )}
        {!compose && (
          <p className="p-8 text-callout text-a11y-muted">{toast?.text ?? t`Loading draft…`}</p>
        )}
        <Toast toast={toast} onDone={hideToast} />
      </div>
    );
  const narrow = layout.mode === "narrow";
  /** Sidebar actions also close the drawer the sidebar sits in when it is not docked. */
  const fromDrawer =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      layout.setDrawerOpen(false);
      action(...args);
    };
  /** A view picked in the drawer hands focus to its list, not back to the drawer toggle. */
  const viewFromDrawer =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      const fromOpenDrawer = layout.drawerOpen;
      fromDrawer(action)(...args);
      if (fromOpenDrawer) navigation.focusList(null);
    };
  const deleteBatch = deleteFolder
    ? () => requestPermanentDelete(batchRows.map((row) => row.id))
    : undefined;
  const createBatchLabel = (accountId: string, move: boolean) =>
    setLabelCreation({
      accountId,
      move,
      threads: batchRows.filter((row) => row.accountId === accountId).map((row) => row.id),
      flat: !prefs.threadGrouping,
      removeLabelId: moveSourceLabel(view.mailbox, view.label?.id),
    });
  const batch = {
    rows: batchRows,
    accounts: accountList,
    labels,
    currentLabel: view.label?.id,
    mailbox: view.mailbox,
    onOp: (op: MailOp, accountId?: string) => act(op, accountId ? { accountId } : {}),
    onPermanentDelete: deleteBatch,
    onCreate: createBatchLabel,
  };
  const sidebar = (
    <Sidebar
      view={view}
      // The overview has no list; picking a mailbox there opens it in All.
      onView={viewFromDrawer((v) => changeView(v.space === OVERVIEW ? { ...v, space: ALL } : v))}
      onSpace={viewFromDrawer(switchSpace)}
      onEditProfile={fromDrawer(setEditing)}
      accounts={accountList}
      profiles={profileList}
      unread={counts}
      syncState={syncState}
      progress={progress}
      proposals={proposals.length}
      onAddAccount={fromDrawer(() => setDialog("add"))}
      onCompose={fromDrawer(() => startCompose("new"))}
      onReauth={fromDrawer(mailActions.reauth)}
      onProposals={fromDrawer(() => setDialog("proposals"))}
      onSettings={fromDrawer(() => setDialog("settings"))}
    />
  );
  // The medium layout docks the sidebar as a rail of icons, with the full sidebar in a drawer.
  const rail = layout.mode === "medium" && hasAccounts;
  const sidebarToggle =
    docked || rail ? undefined : <SidebarToggle onClick={paneNav.toggleSidebar} />;
  /** A view or space picked in the rail hands focus to its list. */
  const fromRail =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      action(...args);
      navigation.focusList(null);
    };
  const mainPane = !hasAccounts ? (
    <main className="flex h-full w-full flex-col bg-surface">
      <div className="drag h-13 shrink-0" />
      {accounts._tag === "Failure" ? (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-13 text-center"
        >
          <p className="max-w-80 text-a11y-muted">
            {t`Couldn't load your accounts.`} {causeText(i18n, accounts.cause)}
          </p>
          <button type="button" className={buttonSecondary} onClick={refreshAccounts}>
            {t`Retry`}
          </button>
        </div>
      ) : accounts._tag === "Success" && dialog !== "add" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-13 text-center">
          <p className="text-a11y-muted">{t`No email accounts yet.`}</p>
          {canCall("Connect") ? (
            <button type="button" className={buttonPrimary} onClick={() => setDialog("add")}>
              {t`Add account`}
            </button>
          ) : (
            <p className="text-a11y-muted">{t`Add an account on your Mac.`}</p>
          )}
        </div>
      ) : null}
    </main>
  ) : (
    <Overview
      leading={sidebarToggle}
      accounts={accountList}
      profiles={profileList}
      unread={counts}
      syncState={syncState}
      onOpen={switchSpace}
      onEditProfile={setEditing}
    />
  );
  const batchToolbar =
    selection.ids.size > 1
      ? {
          ...batch,
          canLoadMore: threads.canLoadMore,
          moreNotLoaded: threads.moreNotLoaded,
          labelPicker,
          onLabelPicker: setLabelPicker,
        }
      : null;
  const listPane = (
    <MessageList
      leading={sidebarToggle}
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
      accountLabel={(id) => {
        const account = accountList.find((a) => a.id === id);
        return account ? accountName(account) : id;
      }}
      searchBar={
        !prefs.readingPaneVisible || narrow ? (
          <SearchField value={query} onChange={setQuery} inputRef={searchRef} />
        ) : undefined
      }
      // One pane at a time leaves no reader toolbar, so selected rows get their actions above the
      // list. Only while the list shows, so the reader's bar and this one never share a label picker.
      selectionBar={
        narrow && !paneNav.shown.reader && batchToolbar ? (
          <BatchActions {...batchToolbar} />
        ) : undefined
      }
      key={JSON.stringify([view, search, filters])}
      title={title}
      threads={list}
      loading={threads.loading}
      loadingMore={threads.loadingMore}
      loadError={threads.loadError}
      exhausted={threads.exhausted}
      showAccount={!viewAccount && (scope?.length ?? accountList.length) > 1}
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
          {/* Downloads land on the Mac; the browser keeps its own list. */}
          {isDesktop() && <Downloads />}
          <UndoHistory entries={undoHistory} onUndo={undoRestored} />
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
  const readerPane = (
    <Reader
      messageId={selectedId}
      threadKey={currentReaderThreadKey}
      onMarkUnread={() => setReadTarget(null)}
      onActionDone={({ result, ids, op }) => mailActions.actionDone(result, ids, op)}
      onSelectMessage={(id) => {
        if (currentReaderThreadKey) setOpenMessage(id);
      }}
      derivedMatches={selected?.derivedMatches}
      searchMatches={selected?.searchMatches}
      query={query}
      onQuery={setQuery}
      searchRef={searchRef}
      onComposeMessage={(id, mode, attachment) => startCompose(mode, attachment, id)}
      onEditDraft={openSavedDraft}
      notify={(next) => say(next)}
      onBack={narrow ? paneNav.back : undefined}
      renderToolbar={() => (
        <ReaderToolbar
          batch={batchToolbar}
          thread={
            threadState && {
              currentLabel: view.label?.id,
              pickerMode,
              organizationTarget: batchRows[0]
                ? {
                    accountId: batchRows[0].accountId,
                    threads: [batchRows[0].id],
                    flat: !prefs.threadGrouping,
                  }
                : undefined,
              state: threadState,
              mailbox: view.mailbox,
              labels: threadLabels,
              onOp: (op) => act(op),
              onPermanentDelete: deleteFolder
                ? () => {
                    if (selectedId) requestPermanentDelete([selectedId]);
                  }
                : undefined,
              onCompose: startCompose,
              onSendAgain: stateMessages?.some((m) => m.labels.includes("SENT"))
                ? () => sendAgain(stateMessages.filter((m) => m.labels.includes("SENT")).at(-1)?.id)
                : undefined,
              onSnooze: () => {
                if (selectedId) setSnoozeIds([selectedId]);
              },
              onFilter:
                selectedAccount?.provider === "imap"
                  ? undefined
                  : () => {
                      if (selectedAccount && selected)
                        setFilterSeed({
                          accountId: selectedAccount.id,
                          from: selected.from.address,
                        });
                    },
              onOpenWindow: () => {
                if (selectedId) navigation.openWindow(selectedId);
              },
              labelPicker,
              onLabelPicker: setLabelPicker,
            }
          }
        />
      )}
    />
  );
  return (
    <div className="flex h-full flex-col text-body text-neutral-900 dark:text-neutral-100">
      {canCall("InitializeProfiles") && (
        <DefaultProfilesPrompt
          accounts={accountList}
          profiles={profileList}
          busy={Boolean(dialog || compose)}
        />
      )}
      <ProfileSwitcher profiles={profileList} value={view.space} onChange={switchSpace} />
      <FocusedInboxPermission />
      <FailedOpNotice onOpenDraft={openSavedDraft} />
      <UpdateNotice onSettings={() => setDialog("settings")} />
      <RemoteImagesPrompt hasAccounts={hasAccounts} />
      {narrow ? (
        // One pane at a time.
        <div className="flex min-h-0 flex-1">
          {paneMode !== "mail" ? (
            mainPane
          ) : (
            <>
              <div
                ref={listSlot}
                data-mail-pane={paneNav.shown.list ? "list" : undefined}
                hidden={!paneNav.shown.list}
                className="flex min-w-0 flex-1"
              />
              {paneNav.shown.reader && (
                <div
                  ref={readerSlot}
                  data-mail-pane="reader"
                  tabIndex={-1}
                  // The pane fills the window, so a ring outside it would be off screen.
                  className="flex min-w-0 flex-1 focus-visible:-outline-offset-2"
                />
              )}
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {rail && (
            <SidebarRail
              view={view}
              accounts={accountList}
              profiles={profileList}
              unread={counts}
              onView={fromRail((v) => changeView(v.space === OVERVIEW ? { ...v, space: ALL } : v))}
              onSpace={fromRail(switchSpace)}
              onOpenSidebar={paneNav.toggleSidebar}
              onCompose={() => startCompose("new")}
            />
          )}
          <Group
            key={`${paneMode}:${docked}`}
            className="min-w-0 flex-1"
            defaultLayout={savedLayout.defaultLayout}
            onLayoutChanged={savedLayout.onLayoutChanged}
            resizeTargetMinimumSize={{ fine: 9, coarse: 24 }}
          >
            {docked && (
              <Panel
                id="sidebar"
                data-mail-pane="sidebar"
                defaultSize={232}
                minSize={PANE_MIN.sidebar}
                maxSize={380}
                groupResizeBehavior="preserve-pixel-size"
              >
                {sidebar}
              </Panel>
            )}
            {docked && <ResizeHandle />}
            {paneMode !== "mail" ? (
              <Panel id="main" minSize={360}>
                {mainPane}
              </Panel>
            ) : (
              <MailPanels
                position={prefs.readingPanePosition}
                readerVisible={prefs.readingPaneVisible}
              >
                <Panel
                  id="list"
                  data-mail-pane="list"
                  defaultSize={380}
                  minSize={mailOrientation === "vertical" ? 120 : PANE_MIN.list}
                  maxSize={
                    !prefs.readingPaneVisible || mailOrientation === "vertical" ? undefined : 720
                  }
                  groupResizeBehavior="preserve-pixel-size"
                >
                  <div ref={listSlot} className="flex h-full" />
                </Panel>
                {prefs.readingPaneVisible && <ResizeHandle orientation={mailOrientation} />}
                {prefs.readingPaneVisible && (
                  <Panel
                    id="reader"
                    data-mail-pane="reader"
                    tabIndex={-1}
                    minSize={mailOrientation === "vertical" ? 150 : PANE_MIN.reader}
                  >
                    <div ref={readerSlot} className="flex h-full" />
                  </Panel>
                )}
              </MailPanels>
            )}
          </Group>
        </div>
      )}
      {/* The list and reader live outside the layout, so changing layouts keeps their state. */}
      {paneMode === "mail" && createPortal(listPane, listHost)}
      {paneMode === "mail" && paneNav.shown.reader && createPortal(readerPane, readerHost)}
      {layout.mode !== "wide" && (
        <Drawer
          open={layout.drawerOpen}
          onOpenChange={layout.setDrawerOpen}
          aria-label={t`Sidebar`}
        >
          {sidebar}
        </Drawer>
      )}
      <Alert
        open={deleteKeyPrompt}
        onOpenChange={setDeleteKeyPrompt}
        title={t`Choose Delete key action`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        {(["trash", "archive", "removeLabel"] as const).map((action) => (
          <button
            type="button"
            key={action}
            className={alertButton}
            onClick={() => {
              setDeleteKeyPrompt(false);
              applyDeleteKey(action);
            }}
          >
            {action === "trash"
              ? t`Move to Trash`
              : action === "archive"
                ? t`Archive`
                : t`Remove current label`}
          </button>
        ))}
      </Alert>
      <Alert
        open={quotePrompt !== null}
        onOpenChange={(open) => {
          if (!open) setQuotePrompt(null);
        }}
        title={t`Quote only the selected text?`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertButton}
          onClick={() => {
            quotePrompt?.(false);
            setQuotePrompt(null);
          }}
        >{t`Whole message`}</button>
        <button
          type="button"
          className={alertPrimary}
          onClick={() => {
            quotePrompt?.(true);
            setQuotePrompt(null);
          }}
        >{t`Selected text`}</button>
      </Alert>
      <Alert
        open={deleteRequest !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRequest(null);
        }}
        title={t`Delete ${deleteRequest?.ids.size ?? 0} conversations?`}
        description={t`These loaded conversations will be moved to Trash. You can undo this batch.`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertDanger}
          onClick={() => {
            const request = deleteRequest;
            setDeleteRequest(null);
            if (request && request.scopeKey === scopeKey)
              act({ kind: "trash" }, { confirmedIds: request.ids });
          }}
        >{t`Delete`}</button>
      </Alert>
      <Alert
        open={permanentRequest !== null}
        onOpenChange={(open) => {
          if (!open) setPermanentRequest(null);
        }}
        title={t`Permanently delete selected mail?`}
        description={
          permanentRequest?.flat
            ? t`Only the selected messages in this Trash or Spam folder will be permanently deleted. This cannot be undone.`
            : t`Only messages in this Trash or Spam folder from the selected conversations will be permanently deleted. Inbox and Sent copies will remain. This cannot be undone.`
        }
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertDanger}
          onClick={() => {
            mailActions.confirmPermanentDelete();
          }}
        >{t`Permanently delete`}</button>
      </Alert>
      {permissionAccount && (
        <PermanentDeletePermission
          key={permissionAccount}
          accountId={permissionAccount}
          onClose={() => setPermissionAccount(null)}
        />
      )}
      {editing && (
        <ProfileEditor
          profile={editing === "new" ? undefined : editing}
          accounts={accountList}
          profiles={profileList}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            if (editing === "new") switchSpace(p.id);
          }}
          onDeleted={() => {
            if (editing !== "new" && view.space === editing.id) switchSpace(ALL);
          }}
        />
      )}
      {canCall("Connect") &&
        (dialog === "add" || (!hasAccounts && accounts._tag === "Success" && !firstRunClosed)) && (
          <AddAccountDialog
            firstRun={!hasAccounts}
            {...(signInAgain?.provider === "imap" ? { signInAgain } : {})}
            onClose={() => {
              setDialog(null);
              setFirstRunClosed(true);
            }}
            onAdded={(a) => {
              setDialog(null);
              const email = a.email;
              say({ text: t`Added ${email}. Syncing…` });
            }}
          />
        )}
      {goToFolder && (
        <GoToFolder
          labels={labels}
          accounts={accountList}
          view={view}
          onView={changeView}
          onClose={() => setGoToFolder(false)}
        />
      )}
      {labelCreation && (
        <CreateLabelDialog
          target={labelCreation}
          labels={labels}
          onClose={() => setLabelCreation(null)}
        />
      )}
      {snoozeIds && (
        <SnoozeDialog
          threads={snoozeIds}
          onClose={() => setSnoozeIds(null)}
          onStart={mailActions.startSnooze}
        />
      )}
      {filterSeed && filterAccount && (
        <FilterEditor
          account={filterAccount}
          from={filterSeed.from}
          onClose={() => setFilterSeed(null)}
        />
      )}
      <Assistant accounts={accountList} proposals={proposals} onOpenDraft={openProposal} />
      {dialog === "help" && <ShortcutHelp onClose={() => setDialog(null)} />}
      {dialog === "settings" && (
        <Settings
          accounts={accountList}
          initialTab={optionalAccountId ? "accounts" : "general"}
          optionalAccountId={optionalAccountId}
          onClose={() => {
            setDialog(null);
            setOptionalAccountId(null);
          }}
          onAddAccount={() => setDialog("add")}
        />
      )}
      {dialog === "proposals" && (
        <Proposals
          proposals={proposals}
          accounts={accountList}
          onClose={() => setDialog(null)}
          onOpenDraft={openProposal}
        />
      )}
      {dialog === "feedback" && (
        <Feedback crash={crashFeedback} onClose={() => setDialog(null)} onDraft={feedbackDraft} />
      )}
      {compose && (
        <Composer
          key={compose.id}
          draft={compose}
          accounts={accountList}
          signatureFor={signatureFor}
          onClose={closeCompose}
          onDiscard={discard}
          onSend={send}
          onPopOut={isDesktop() ? popOut : undefined}
          popOutRequested={popOutRequested}
        />
      )}
      <Toast toast={toast} onDone={hideToast} />
    </div>
  );
}

/** The reader's actions: for the selected rows when several are selected, otherwise for the open thread. */
function ReaderToolbar({
  batch,
  thread,
}: {
  batch: ComponentProps<typeof BatchActions> | null;
  thread: ComponentProps<typeof ThreadActions> | null;
}) {
  if (batch) return <BatchActions {...batch} />;
  return thread && <ThreadActions {...thread} />;
}

const OP_DONE: Record<MailOp["kind"], (op: MailOp) => MessageDescriptor> = {
  read: (op) => (op.kind === "read" && op.value ? msg`Marked as read` : msg`Marked as unread`),
  star: (op) => (op.kind === "star" && op.value ? msg`Added star` : msg`Removed star`),
  important: (op) =>
    op.kind === "important" && op.value ? msg`Marked as important` : msg`Marked as not important`,
  archive: () => msg`Archived`,
  inbox: () => msg`Moved to Inbox`,
  trash: () => msg`Deleted`,
  spam: () => msg`Reported as spam`,
  move: () => msg`Moved`,
  categories: () => msg`Categories updated`,
  classification: (op) =>
    op.kind === "classification" && op.value === "focused"
      ? msg`Moved to Focused`
      : msg`Moved to Other`,
  copy: () => msg`Copied to folders`,
  label: (op) => (op.kind === "label" && op.value ? msg`Label added` : msg`Label removed`),
};

/** Keep catalog origins here; behaviour modules receive this text adapter. */
function useAppMessages() {
  const { t, i18n } = useLingui();
  return {
    cantOpenTheMessage: (reason: string) => t`Can't open the message: ${reason}`,
    opDone: (op: MailOp) => i18n._(OP_DONE[op.kind](op)),
    couldNotLoadTheNextMessage: t`Could not load the next message`,
    actionFailed: (reason: string) => t`Action failed: ${reason}`,
    noCurrentLabelAppliesMovingToTrash: t`No current label applies. Moving to Trash.`,
    finishSigningInInYourBrowser: t`Finish signing in in your browser`,
    isSignedInAgain: (email: string) => t`${email} is signed in again`,
    signInFailed: (reason: string) => t`Sign-in failed: ${reason}`,
    snoozed: t`Snoozed`,
    permanentlyDeletedMessages: (count: number) => t`Permanently deleted ${count} messages`,
    couldntDelete: (reason: string) => t`Couldn't delete: ${reason}`,
    cantOpenTheDraft: (reason: string) => t`Can't open the draft: ${reason}`,
    couldNotOpenTheComposeWindow: t`Could not open the compose window`,
    connectAnAccountToSendFeedback: t`Connect an account to send feedback`,
    couldNotOpenTheFeedbackDraft: t`Could not open the feedback draft`,
    couldNotOpenTheDraft: t`Could not open the draft`,
    couldntSaveTheDraft: (reason: string) => t`Couldn't save the draft: ${reason}`,
    draftDiscarded: t`Draft discarded`,
    couldntDiscard: (reason: string) => t`Couldn't discard: ${reason}`,
    sentAndArchived: t`Sent and archived`,
    sent: t`Sent`,
    couldntSend: (reason: string) => t`Couldn't send: ${reason}`,
    sending: t`Sending…`,
    undo: t`Undo`,
    gmailSize: t`Gmail attachments exceed 25 MB in total. Remove attachments before sending.`,
    gmailBlocked: (filename: string) =>
      t`Gmail blocks ${filename}. Remove this attachment before sending.`,
    outlookSize: t`Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.`,
    outlookItemSize: t`Outlook cannot upload attached messages of 3 MB or more. Remove this attachment before sending.`,
  };
}
export type AppMessages = ReturnType<typeof useAppMessages>;

/** Immutable query arrays own their lookup maps; WeakMap releases old results. */
const maps = new WeakMap<readonly Label[], Map<string, Label>>();
function labelsById(labels: readonly Label[]) {
  const cached = maps.get(labels);
  if (cached) return cached;
  const map = new Map(labels.map((label) => [`${label.accountId}/${label.id}`, label]));
  maps.set(labels, map);
  return map;
}

/**
 * A pane that keeps its React state when the layout moves it. The caller
 * portals the pane into `host` at one fixed place in the tree, and each
 * layout gives the host a slot through the `slot` ref. Changing layouts then
 * moves one DOM node instead of remounting the list or the reader.
 */
function usePaneHost() {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex h-full min-w-0 flex-1";
    return element;
  });
  const slot = useCallback(
    (element: HTMLElement | null) => {
      element?.append(host);
    },
    [host],
  );
  return { host, slot };
}

/**
 * The line between two panes. It draws the 1 px border the panes used to
 * carry themselves; the group's resizeTargetMinimumSize widens what the
 * pointer can grab without widening the line.
 */
function ResizeHandle({ orientation = "horizontal" }: { orientation?: "horizontal" | "vertical" }) {
  return (
    <Separator
      className={`no-drag ${orientation === "vertical" ? "h-px" : "w-px"} bg-black/5 transition-colors outline-none data-[separator=active]:bg-blue-500 data-[separator=focus]:bg-blue-500 data-[separator=hover]:bg-blue-500/60 dark:bg-white/5`}
    />
  );
}
