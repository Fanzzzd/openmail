import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { moveSourceLabel } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import type { MailOp } from "../../shared/api";
import { useAppPanels, usePanelLayout } from "./app/use-app-panels";
import { useMailActions } from "./app/use-mail-actions";
import { useMailCompose } from "./app/use-mail-compose";
import { useMailSelection } from "./app/use-mail-selection";
import { useMailShortcuts } from "./app/use-mail-shortcuts";
import { useNativeMenuBridge } from "./app/use-native-menu-bridge";
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
import { UpdateNotice } from "./components/UpdateNotice";
import { numberedFavorites } from "./favorite-navigation";
import { supportsInInboxFilter } from "./folder-actions";
import { labelsById } from "./label-map";
import { readerThreadKey, type ReaderSelection } from "./reader-selection";

import { BatchActions, BatchMenuItems } from "./components/BatchActions";
import { MailPanels } from "./components/MailPanels";
import { MessageList } from "./components/MessageList";
import { Overview } from "./components/Overview";
import { DefaultProfilesPrompt, ProfileSwitcher } from "./components/ProfileSettings";
import { Reader, useThreadPrint } from "./components/Reader";
import { ResizeHandle } from "./components/ResizeHandle";
import { Sidebar } from "./components/Sidebar";
import { ThreadActions, type ThreadState } from "./components/ThreadActions";
import { Toast, type ToastState } from "./components/Toast";
import { Alert, alertButton, AlertCancel, alertDanger, alertPrimary } from "./components/ui/Dialog";
import { SearchField } from "./components/ui/SearchField";
import { UndoHistory } from "./components/UndoHistory";
import { causeText } from "./errors";
import { MailClient } from "./rpc";
import { useDesktopLabels } from "./state/desktop";
import { liveUpdatesAtom } from "./state/events";
import { useRunMail } from "./state/mail";
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
  const openThread = AsyncResult.value(useAtomValue(threadAtom(selectedId)));
  const messages = openThread._tag === "Some" ? openThread.value : undefined;
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

  useMailShortcuts({
    panels,
    navigation,
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

  const { narrow, readingPosition, paneMode, panes, mailOrientation } = usePanelLayout({
    prefs,
    hasAccounts,
    view,
  });
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
  return (
    <div className="flex h-full flex-col text-[13px] text-neutral-900 dark:text-neutral-100">
      <DefaultProfilesPrompt
        accounts={accountList}
        profiles={profileList}
        busy={Boolean(dialog || compose)}
      />
      <ProfileSwitcher profiles={profileList} value={view.space} onChange={switchSpace} />
      <UpdateNotice onSettings={() => setDialog("settings")} />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Group
          key={`${paneMode}:${prefs.sidebarVisible}`}
          orientation={narrow ? "vertical" : "horizontal"}
          className={narrow ? "min-h-[640px] flex-1" : "min-h-0 flex-1"}
          defaultLayout={panes.defaultLayout}
          onLayoutChanged={panes.onLayoutChanged}
          resizeTargetMinimumSize={{ fine: 9, coarse: 24 }}
        >
          {prefs.sidebarVisible && (
            <Panel
              id="sidebar"
              data-mail-pane="sidebar"
              defaultSize={narrow ? 160 : 232}
              minSize={narrow ? 120 : 190}
              maxSize={narrow ? 240 : 380}
              groupResizeBehavior="preserve-pixel-size"
            >
              <Sidebar
                view={view}
                // The overview has no list; picking a mailbox there opens it in All.
                onView={(v) => changeView(v.space === OVERVIEW ? { ...v, space: ALL } : v)}
                onSpace={switchSpace}
                onEditProfile={setEditing}
                accounts={accountList}
                profiles={profileList}
                unread={counts}
                syncState={syncState}
                progress={progress}
                proposals={proposals.length}
                onAddAccount={() => setDialog("add")}
                onCompose={() => startCompose("new")}
                onReauth={mailActions.reauth}
                onProposals={() => setDialog("proposals")}
                onSettings={() => setDialog("settings")}
              />
            </Panel>
          )}
          {prefs.sidebarVisible && (
            <ResizeHandle orientation={narrow ? "vertical" : "horizontal"} />
          )}
          {!hasAccounts ? (
            <Panel id="main" minSize={360}>
              <main className="h-full bg-white dark:bg-neutral-900">
                <div className="drag h-13" />
              </main>
            </Panel>
          ) : view.space === OVERVIEW ? (
            <Panel id="main" minSize={360}>
              <Overview
                accounts={accountList}
                profiles={profileList}
                unread={counts}
                syncState={syncState}
                onOpen={switchSpace}
                onEditProfile={setEditing}
              />
            </Panel>
          ) : (
            <MailPanels position={readingPosition} readerVisible={prefs.readingPaneVisible}>
              <Panel
                id="list"
                data-mail-pane="list"
                defaultSize={380}
                minSize={mailOrientation === "vertical" ? 120 : 280}
                maxSize={
                  !prefs.readingPaneVisible || mailOrientation === "vertical" ? undefined : 720
                }
                groupResizeBehavior="preserve-pixel-size"
              >
                <MessageList
                  searchBar={
                    !prefs.readingPaneVisible ? (
                      <div className="drag flex h-13 shrink-0 items-center px-4">
                        <SearchField value={query} onChange={setQuery} inputRef={searchRef} />
                      </div>
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
                  searchErrors={threads.searchErrors}
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
                        notify={(text, error) =>
                          say({ text, ...(error ? { tone: "error" as const } : {}) })
                        }
                      />
                    </>
                  }
                  labels={labelMap}
                  selectedId={selection.focus}
                  selectedIds={selection.ids}
                  listRef={listRef}
                  selectionSource={selectionSource}
                  rowActions={{
                    batchMenu: (
                      <BatchMenuItems
                        onPermanentDelete={
                          deleteFolder
                            ? () => requestPermanentDelete(batchRows.map((row) => row.id))
                            : undefined
                        }
                        onCreate={(accountId, move) =>
                          setLabelCreation({
                            accountId,
                            move,
                            threads: batchRows
                              .filter((row) => row.accountId === accountId)
                              .map((row) => row.id),
                            flat: !prefs.threadGrouping,
                            removeLabelId: moveSourceLabel(view.mailbox, view.label?.id),
                          })
                        }
                        currentLabel={view.label?.id}
                        mailbox={view.mailbox}
                        rows={batchRows}
                        accounts={accountList}
                        labels={labels}
                        onOp={(op, accountId) => act(op, accountId ? { accountId } : {})}
                      />
                    ),
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
                      view.mailbox === "drafts"
                        ? openSavedDraft(m.id)
                        : navigation.openWindow(m.id),
                  }}
                  onSelect={(id, modifiers) => {
                    if (threads.loading) return;
                    if (view.mailbox !== "drafts") {
                      navigation.selectRow(id, modifiers);
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
              </Panel>
              {prefs.readingPaneVisible && <ResizeHandle orientation={mailOrientation} />}
              {prefs.readingPaneVisible && (
                <Panel
                  id="reader"
                  data-mail-pane="reader"
                  tabIndex={-1}
                  minSize={mailOrientation === "vertical" ? 150 : 360}
                >
                  <Reader
                    messageId={selectedId}
                    threadKey={currentReaderThreadKey}
                    onMarkUnread={() => setReadTarget(null)}
                    onActionDone={({ result, ids, op }) => mailActions.actionDone(result, ids, op)}
                    onSelectMessage={(id) => {
                      if (currentReaderThreadKey)
                        setReaderSelection({ threadKey: currentReaderThreadKey, id });
                    }}
                    derivedMatches={selected?.derivedMatches}
                    query={query}
                    onQuery={setQuery}
                    searchRef={searchRef}
                    onComposeMessage={(id, mode, attachment) => startCompose(mode, attachment, id)}
                    onEditDraft={openSavedDraft}
                    notify={(next) => say(next)}
                    renderToolbar={(compact) =>
                      selection.ids.size > 1 ? (
                        <BatchActions
                          onPermanentDelete={
                            deleteFolder
                              ? () => requestPermanentDelete(batchRows.map((row) => row.id))
                              : undefined
                          }
                          onCreate={(accountId, move) =>
                            setLabelCreation({
                              accountId,
                              move,
                              threads: batchRows
                                .filter((row) => row.accountId === accountId)
                                .map((row) => row.id),
                              flat: !prefs.threadGrouping,
                              removeLabelId: moveSourceLabel(view.mailbox, view.label?.id),
                            })
                          }
                          currentLabel={view.label?.id}
                          mailbox={view.mailbox}
                          rows={batchRows}
                          canLoadMore={threads.canLoadMore}
                          moreNotLoaded={threads.moreNotLoaded}
                          accounts={accountList}
                          labels={labels}
                          onOp={(op, accountId) => act(op, accountId ? { accountId } : {})}
                          labelPicker={labelPicker}
                          onLabelPicker={setLabelPicker}
                        />
                      ) : (
                        threadState && (
                          <ThreadActions
                            currentLabel={view.label?.id}
                            pickerMode={pickerMode}
                            organizationTarget={
                              batchRows[0]
                                ? {
                                    accountId: batchRows[0].accountId,
                                    threads: [batchRows[0].id],
                                    flat: !prefs.threadGrouping,
                                  }
                                : undefined
                            }
                            compact={compact}
                            state={threadState}
                            mailbox={view.mailbox}
                            labels={threadLabels}
                            onOp={(op) => act(op)}
                            onPermanentDelete={
                              deleteFolder
                                ? () => {
                                    if (selectedId) requestPermanentDelete([selectedId]);
                                  }
                                : undefined
                            }
                            onCompose={startCompose}
                            onSendAgain={
                              stateMessages?.some((m) => m.labels.includes("SENT"))
                                ? () =>
                                    sendAgain(
                                      stateMessages.filter((m) => m.labels.includes("SENT")).at(-1)
                                        ?.id,
                                    )
                                : undefined
                            }
                            onSnooze={() => {
                              if (selectedId) setSnoozeIds([selectedId]);
                            }}
                            onFilter={
                              selectedAccount?.provider === "imap"
                                ? undefined
                                : () => {
                                    if (selectedAccount && selected)
                                      setFilterSeed({
                                        accountId: selectedAccount.id,
                                        from: selected.from.address,
                                      });
                                  }
                            }
                            onOpenWindow={() => {
                              if (selectedId) navigation.openWindow(selectedId);
                            }}
                            labelPicker={labelPicker}
                            onLabelPicker={setLabelPicker}
                          />
                        )
                      )
                    }
                  />
                </Panel>
              )}
            </MailPanels>
          )}
        </Group>
      </div>
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
          onClose={() => setDialog(null)}
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
