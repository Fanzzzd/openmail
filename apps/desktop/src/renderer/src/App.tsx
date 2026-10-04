import { Separator, Group, Panel } from "react-resizable-panels";
import { useCallback, useState, type ComponentProps, useEffect } from "react";
import type { Label, MailOp } from "../../shared/api";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { moveSourceLabel } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { createPortal } from "react-dom";
import { PANE_MIN } from "../../shared/layout";
import { useAppPanels, usePanelLayout } from "./app/use-app-panels";
import { useMailActions } from "./app/use-mail-actions";
import { useMailCompose } from "./app/use-mail-compose";
import { useMailSelection } from "./app/use-mail-selection";
import { useMailShortcuts } from "./app/use-mail-shortcuts";
import { useNativeMenuBridge } from "./app/use-native-menu-bridge";
import { usePaneNavigation } from "./app/use-pane-navigation";
import { Assistant } from "./components/AiPanel";
import { FolderActions } from "./components/FolderActions";
import {
  AddAccountDialog,
  Composer,
  CreateLabelDialog,
  Feedback,
  FilterEditor,
  ProfileEditor,
  Proposals,
  Settings,
  ShortcutHelp,
} from "./components/LazyDialogs";
import { PermanentDeletePermission } from "./components/PermanentDeletePermission";
import { FailedOpNotice } from "./components/FailedOpNotice";
import { UpdateNotice } from "./components/UpdateNotice";
import { numberedFavorites } from "./favorite-navigation";
import { supportsInInboxFilter } from "./folder-actions";
import { readerThreadKey, type ReaderSelection } from "./reader-selection";

import { BatchActions, BatchMenuItems } from "./components/BatchActions";
import { MailPanels } from "./components/MailPanels";
import { MessageList } from "./components/MessageList";
import { Overview } from "./components/Overview";
import { DefaultProfilesPrompt, ProfileSwitcher } from "./components/ProfileSettings";
import { Reader, useThreadPrint } from "./components/Reader";
import { Sidebar, SidebarToggle } from "./components/Sidebar";
import { SidebarRail } from "./components/SidebarRail";
import { railTrafficLightInset, trafficLightInset } from "./components/ui/styles";
import { ThreadActions, type ThreadState } from "./components/ThreadActions";
import { Toast, type ToastState } from "./components/Toast";
import {
  Alert,
  alertButton,
  AlertCancel,
  alertDanger,
  alertPrimary,
  Drawer,
} from "./components/ui/Dialog";
import { SearchField } from "./components/ui/SearchField";
import { UndoHistory } from "./components/UndoHistory";
import { messageMissing, causeText } from "./errors";
import { MailClient } from "./rpc";
import { useDesktopLabels } from "./state/desktop";
import { liveUpdatesAtom } from "./state/events";
import { networkChanged, useRunMail } from "./state/mail";
import {
  accountsAtom,
  labelPreferencesAtom,
  labelsAtom,
  profilesAtom,
  proposalsAtom,
  signaturesAtom,
  threadAtom,
  unreadCountsAtom,
} from "./state/queries";
import { useBatchUndo } from "./state/undo";
import { ALL, CATEGORY_NAMES, MAILBOX_NAMES, OVERVIEW, scopeAccountIds } from "./view";

import { GoToFolder } from "./components/GoToFolder";
import { SnoozeDialog } from "./components/SnoozeDialog";

export function App({ composeId }: { composeId?: string }) {
  // The one subscription to the main process's events, and the RPC runtime,
  // live as long as the window.
  useAtomMount(MailClient.runtime);
  useAtomMount(liveUpdatesAtom);
  const run = useRunMail();
  useEffect(() => {
    const onOnline = () => {
      run(networkChanged);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [run]);
  useDesktopLabels();
  const strings = useAppMessages();
  const { t, i18n } = useLingui();

  const panels = useAppPanels();
  const {
    editing,
    setEditing,
    syncState,
    progress,
    dialog,
    setDialog,
    labelPicker,
    setLabelPicker,
    pickerMode,
    goToFolder,
    setGoToFolder,
    labelCreation,
    setLabelCreation,
    snoozeIds,
    setSnoozeIds,
    filterSeed,
    setFilterSeed,
    searchRef,
  } = panels;

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
  const accountList = AsyncResult.getOrElse(accounts, () => []);
  const profileList = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const counts = AsyncResult.getOrElse(useAtomValue(unreadCountsAtom), () => ({}));
  const navigation = useMailSelection({
    messages: strings,
    setLabelPicker,
    accountsReady: accounts._tag === "Success",
    accountList,
    run,
    composeId,
    say,
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

  const [readerSelection, setReaderSelection] = useState<ReaderSelection | null>(null);
  const threadResult = useAtomValue(threadAtom(selectedId));
  const openThread = AsyncResult.value(threadResult);
  const messages =
    !messageMissing(threadResult) && openThread._tag === "Some" ? openThread.value : undefined;
  const currentReaderThreadKey = readerThreadKey(selected ?? messages?.[0]);
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
  const threadState: ThreadState | null =
    selectedAccount && stateMessages
      ? {
          provider: selectedAccount.provider,
          isUnread: stateMessages.some((m) => m.isUnread),
          isStarred: stateMessages.some((m) => m.isStarred),
          isImportant: stateMessages.some((m) => m.labels.includes("IMPORTANT")),
          labels: [...new Set(stateMessages.flatMap((m) => m.labels))],
        }
      : null;
  const threadLabels = labels.filter((l) => l.accountId === selectedAccount?.id);

  const mailActions = useMailActions({
    messages: strings,
    navigation,
    panels,
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
    panels,
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
    panels,
    navigation,
    composition,
    run,
    threadState,
    say,
    accountList,
    undoRef,
    openExternal: navigation.openExternal,
  });

  const { layout } = panels;
  const paneNav = usePaneNavigation({ layout, navigation, run });
  useMailShortcuts({
    panels,
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
  const category = view.label ? CATEGORY_NAMES[view.label.id] : undefined;
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
      <div className="h-screen bg-white dark:bg-neutral-900">
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
          <p className="p-8 text-sm text-a11y-muted">{toast?.text ?? t`Loading draft…`}</p>
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
  const leadingInset = rail ? railTrafficLightInset : docked ? undefined : trafficLightInset;
  /** A view or space picked in the rail hands focus to its list. */
  const fromRail =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      action(...args);
      navigation.focusList(null);
    };
  const mainPane = !hasAccounts ? (
    <main className="h-full w-full bg-white dark:bg-neutral-900">
      <div className="drag h-13" />
    </main>
  ) : (
    <Overview
      leading={sidebarToggle}
      inset={leadingInset}
      accounts={accountList}
      profiles={profileList}
      unread={counts}
      syncState={syncState}
      onOpen={switchSpace}
      onEditProfile={setEditing}
    />
  );
  const listPane = (
    <MessageList
      leading={sidebarToggle}
      inset={leadingInset}
      searchBar={
        !prefs.readingPaneVisible || narrow ? (
          <SearchField value={query} onChange={setQuery} inputRef={searchRef} />
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
        if (currentReaderThreadKey) setReaderSelection({ threadKey: currentReaderThreadKey, id });
      }}
      derivedMatches={selected?.derivedMatches}
      query={query}
      onQuery={setQuery}
      searchRef={searchRef}
      onComposeMessage={(id, mode, attachment) => startCompose(mode, attachment, id)}
      onEditDraft={openSavedDraft}
      notify={(next) => say(next)}
      onBack={narrow ? paneNav.back : undefined}
      renderToolbar={(compact) => (
        <ReaderToolbar
          compact={compact}
          batch={
            selection.ids.size > 1
              ? {
                  ...batch,
                  canLoadMore: threads.canLoadMore,
                  moreNotLoaded: threads.moreNotLoaded,
                  labelPicker,
                  onLabelPicker: setLabelPicker,
                }
              : null
          }
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
    <div className="flex h-full flex-col text-[13px] text-neutral-900 dark:text-neutral-100">
      <DefaultProfilesPrompt
        accounts={accountList}
        profiles={profileList}
        busy={Boolean(dialog || compose)}
      />
      <ProfileSwitcher profiles={profileList} value={view.space} onChange={switchSpace} />
      <FailedOpNotice onOpenDraft={openSavedDraft} />
      <UpdateNotice onSettings={() => setDialog("settings")} />
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
                  className="flex min-w-0 flex-1"
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
      {(dialog === "add" || (!hasAccounts && accounts._tag !== "Initial")) && (
        <AddAccountDialog
          {...(hasAccounts ? { onClose: () => setDialog(null) } : {})}
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
          onPopOut={popOut}
          popOutRequested={popOutRequested}
        />
      )}
      <Toast toast={toast} onDone={hideToast} />
    </div>
  );
}

/** The reader's actions: for the selected rows when several are selected, otherwise for the open thread. */
function ReaderToolbar({
  compact,
  batch,
  thread,
}: {
  compact: boolean;
  batch: ComponentProps<typeof BatchActions> | null;
  thread: Omit<ComponentProps<typeof ThreadActions>, "limit"> | null;
}) {
  if (batch) return <BatchActions {...batch} />;
  return thread && <ThreadActions {...thread} limit={compact ? 2 : undefined} />;
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
  copy: () => msg`Copied to folders`,
  label: (op) => (op.kind === "label" && op.value ? msg`Label added` : msg`Label removed`),
};

/** Keep catalog origins here; behaviour modules receive this text adapter. */
export function useAppMessages() {
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
    outlookSize: t`This app supports Outlook attachments up to 3 MB in total. Large attachment uploads are not supported yet. Remove attachments before sending.`,
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
