import { useAtom, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import { MailClient } from "../state/rpc";
import { liveUpdatesAtom, syncProgressAtom, syncStateAtom } from "../state/events";
import { networkChanged, useRunMail } from "../state/mail";
import { useOnline } from "../lib/use-online";
import { useDesktopLabels } from "../state/desktop";
import { useAppMessages } from "./use-app-messages";
import { useLingui } from "@lingui/react/macro";
import { useMailLayout } from "../lib/responsive-layout";
import { editingProfileAtom } from "../features/accounts/profile-editing";
import { dialogAtom, openMessageAtom } from "../state/ui";
import {
  labelCreationAtom,
  labelPickerAtom,
  pickerModeAtom,
  snoozeIdsAtom,
} from "../features/organize/organize-state";
import { filterSeedAtom } from "../features/settings/filter-seed";
import { useCallback, useRef, useState } from "react";
import { useSettingsRequests } from "./use-settings-requests";
import { Toast, type ToastState } from "../ui/Toast";
import { useBatchUndo } from "../state/undo";
import { causeText, messageMissing } from "../lib/errors";
import {
  accountsAtom,
  labelPreferencesAtom,
  labelsAtom,
  profilesAtom,
  proposalsAtom,
  sendAsAtom,
  signaturesAtom,
  threadAtom,
  unreadCountsAtom,
} from "../state/queries";
import { AsyncResult } from "effect/reactivity";
import { useMailSelection } from "./use-mail-selection";
import { ALL, OVERVIEW, scopeAccountIds } from "../lib/view";
import { numberedFavorites } from "../features/sidebar/favorite-navigation";
import { readerThreadKey, type ReaderSelection } from "../features/reader/reader-selection";
import { useThreadPrint } from "../features/reader/use-thread-print";
import { focusedSenderMessage, threadStateFor, type ThreadState } from "../lib/focused-inbox";
import { useMailActions } from "./use-mail-actions";
import { useMailCompose } from "./use-mail-compose";
import { useNativeMenuBridge } from "./use-native-menu-bridge";
import { usePaneNavigation } from "./use-pane-navigation";
import { useMailShortcuts } from "./use-mail-shortcuts";
import { useViewTitle } from "./use-view-title";
import { usePanelLayout } from "./use-panel-layout";
import { ReaderToolbar, ResizeHandle, usePaneHost } from "./PaneLayout";
import { Composer } from "./LazyDialogs";
import { moveSourceLabel, providerCapabilities } from "@openmail/core/schema";
import type { Label, MailOp } from "../../../shared/api";
import { Sidebar, SidebarToggle } from "../features/sidebar/Sidebar";
import { NoAccounts } from "./NoAccounts";
import { Overview } from "../features/overview/Overview";
import { MailListPane } from "./MailListPane";
import { drawerActions } from "./drawer-actions";
import { Reader } from "../features/reader/Reader";
import { canCall, isDesktop } from "../lib/platform";
import { DefaultProfilesPrompt } from "../features/accounts/ProfileSettings";
import { FocusedInboxPermission } from "../features/organize/FocusedInboxActions";
import { FailedOpNotice } from "../features/sync-status/FailedOpNotice";
import { UpdateNotice } from "../features/updates/UpdateNotice";
import { RemoteImagesPrompt } from "../features/reader/RemoteImagesPrompt";
import { SidebarRail } from "../features/sidebar/SidebarRail";
import { Group, Panel } from "react-resizable-panels";
import { PANE_MIN } from "../../../shared/layout";
import { MailPanels } from "./MailPanels";
import { createPortal } from "react-dom";
import { Drawer } from "../ui/Dialog";
import { MailAlerts } from "./MailAlerts";
import { AppDialogs } from "./AppDialogs";

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
  const setEditing = useAtomSet(editingProfileAtom);
  const syncState = useAtomValue(syncStateAtom);
  const progress = useAtomValue(syncProgressAtom);
  const [dialog, setDialog] = useAtom(dialogAtom);
  const [labelPicker, setLabelPicker] = useAtom(labelPickerAtom);
  const pickerMode = useAtomValue(pickerModeAtom);
  const setLabelCreation = useAtomSet(labelCreationAtom);
  const setSnoozeIds = useAtomSet(snoozeIdsAtom);
  const setFilterSeed = useAtomSet(filterSeedAtom);
  const searchRef = useRef<HTMLInputElement>(null);

  const settingsRequest = useSettingsRequests(setDialog);
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
    accountsReady: accounts._tag === "Success",
    accountList,
    run,
  });
  const {
    view,
    query,
    setQuery,
    selection,
    selectedId,
    threads,
    deleteFolder,
    batchRows,
    selected,
    prefs,
    setReadTarget,
    switchSpace,
    changeView,
  } = navigation;

  const scope = scopeAccountIds(view, accountList);

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
  const { requestPermanentDelete, act } = mailActions;

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
    showUndo,
    sidebarShown: layout.mode === "wide" ? prefs.sidebarVisible : layout.drawerOpen,
    spaces: profileList.map((profile) => profile.name),
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
  const { viewAccount, title } = useViewTitle(view, accountList, labelMap);

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
  const { fromDrawer, viewFromDrawer, fromRail } = drawerActions(layout, navigation.focusList);
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
  // A layout with a docked sidebar or the mail panes is one main landmark, so its resize
  // handles sit inside a landmark.
  const layoutIsMain = !narrow && (paneMode === "mail" || docked);
  const sidebar = (
    <Sidebar
      landmark={!(docked && layoutIsMain)}
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
  const mainPane = !hasAccounts ? (
    <NoAccounts landmark={!layoutIsMain} adding={dialog === "add"} onAdd={() => setDialog("add")} />
  ) : (
    <Overview
      landmark={!layoutIsMain}
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
          everyLoaded: threads.threads.every((thread) => selection.ids.has(thread.id)),
          labelPicker,
          onLabelPicker: setLabelPicker,
        }
      : null;
  const listPane = (
    <MailListPane
      navigation={navigation}
      mailActions={mailActions}
      paneNav={paneNav}
      startCompose={startCompose}
      openSavedDraft={openSavedDraft}
      accountList={accountList}
      labels={labels}
      labelMap={labelMap}
      online={online}
      docked={docked}
      narrow={narrow}
      composeButton={!docked && !rail}
      leading={sidebarToggle}
      title={title}
      showAccount={!viewAccount && (scope?.length ?? accountList.length) > 1}
      batch={batch}
      batchToolbar={batchToolbar}
      say={say}
      undoHistory={undoHistory}
      onUndo={undoRestored}
      searchRef={searchRef}
    />
  );
  const readerPane = (
    <Reader
      landmark={!layoutIsMain}
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
      onEnterResults={navigation.enterResults}
      searchRef={searchRef}
      onComposeMessage={(id, mode, attachment) => startCompose(mode, attachment, id)}
      onEditDraft={openSavedDraft}
      notify={(next) => say(next)}
      onBack={narrow ? paneNav.back : undefined}
      renderToolbar={(threadMenu) => (
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
                selectedAccount && !providerCapabilities(selectedAccount.provider).rules
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
              threadMenu,
            }
          }
        />
      )}
    />
  );
  return (
    <div className="flex h-full flex-col text-body text-neutral-900 web:pr-[env(safe-area-inset-right)] web:pl-[env(safe-area-inset-left)] dark:text-neutral-100">
      {canCall("InitializeProfiles") && (
        <DefaultProfilesPrompt
          accounts={accountList}
          profiles={profileList}
          busy={Boolean(dialog || compose)}
        />
      )}
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
            role={layoutIsMain ? "main" : undefined}
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
            {docked && <ResizeHandle label={t`Resize sidebar`} />}
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
                {prefs.readingPaneVisible && (
                  <ResizeHandle label={t`Resize message list`} orientation={mailOrientation} />
                )}
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
      <MailAlerts mailActions={mailActions} composition={composition} navigation={navigation} />
      <AppDialogs
        profiles={profileList}
        view={view}
        labels={labels}
        proposals={proposals}
        switchSpace={switchSpace}
        changeView={changeView}
        startSnooze={mailActions.startSnooze}
        openProposal={openProposal}
        crashFeedback={crashFeedback}
        feedbackDraft={feedbackDraft}
        settingsRequest={settingsRequest}
        say={say}
      />
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
          closeRequested={closeRequested}
        />
      )}
      <Toast toast={toast} onDone={hideToast} />
    </div>
  );
}

/** Immutable query arrays own their lookup maps; WeakMap releases old results. */
const maps = new WeakMap<readonly Label[], Map<string, Label>>();
function labelsById(labels: readonly Label[]) {
  const cached = maps.get(labels);
  if (cached) return cached;
  const map = new Map(labels.map((label) => [`${label.accountId}/${label.id}`, label]));
  maps.set(labels, map);
  return map;
}
