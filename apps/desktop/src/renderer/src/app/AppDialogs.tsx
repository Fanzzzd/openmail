import { constVoid } from "effect/Function";
import { providerCapabilities } from "@openmail/core/schema";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState, type ComponentProps } from "react";
import type { Label, Profile, Proposal } from "../../../shared/api";
import { ProfileEditor } from "../features/accounts/lazy";
import { editingProfileAtom } from "../features/accounts/profile-editing";
import { Assistant } from "../features/ai/AiPanel";
import { Proposals } from "../features/ai/lazy";
import { GoToFolder } from "../features/organize/GoToFolder";
import { labelCreationAtom, snoozeIdsAtom } from "../features/organize/organize-state";
import { SnoozeDialog } from "../features/organize/SnoozeDialog";
import { filterSeedAtom } from "../features/settings/filter-seed";
import { goToFolderAtom } from "../features/sidebar/go-to-folder";
import { canCall, isDesktop, isTouchWeb } from "../lib/platform";
import { ALL, type SpaceId, type View } from "../lib/view";
import { accountsAtom } from "../state/queries";
import { dialogAtom, signInAgainAtom } from "../state/ui";
import type { ToastState } from "../ui/Toast";
import {
  AddAccountDialog,
  CreateLabelDialog,
  Feedback,
  FilterEditor,
  FirstRunDone,
  Settings,
  ShortcutHelp,
} from "./LazyDialogs";
import type { useSettingsRequests } from "./use-settings-requests";
import { browserClock } from "../state/view-warming";

/** The main window's dialogs. Which one is open lives in atoms, so menus and shortcuts can open them. */
export function AppDialogs({
  profiles: profileList,
  view,
  labels,
  proposals,
  switchSpace,
  changeView,
  startSnooze,
  openProposal,
  crashFeedback,
  feedbackDraft,
  settingsRequest,
  say,
}: {
  profiles: readonly Profile[];
  view: View;
  labels: readonly Label[];
  proposals: readonly Proposal[];
  switchSpace: (space: SpaceId) => void;
  changeView: (view: View) => void;
  startSnooze: ComponentProps<typeof SnoozeDialog>["onStart"];
  openProposal: ComponentProps<typeof Assistant>["onOpenDraft"];
  crashFeedback: ComponentProps<typeof Feedback>["crash"];
  feedbackDraft: ComponentProps<typeof Feedback>["onDraft"];
  settingsRequest: ReturnType<typeof useSettingsRequests>;
  say: (toast: Omit<ToastState, "id">) => void;
}) {
  const accounts = useAtomValue(accountsAtom);
  const { t } = useLingui();
  const accountList = AsyncResult.getOrElse(accounts, () => []);
  const hasAccounts = accountList.length > 0;
  const [dialog, setDialog] = useAtom(dialogAtom);
  const [editing, setEditing] = useAtom(editingProfileAtom);
  const [goToFolder, setGoToFolder] = useAtom(goToFolderAtom);
  const [labelCreation, setLabelCreation] = useAtom(labelCreationAtom);
  const [snoozeIds, setSnoozeIds] = useAtom(snoozeIdsAtom);
  const [filterSeed, setFilterSeed] = useAtom(filterSeedAtom);
  const filterAccount = filterSeed
    ? accountList.find((a) => a.id === filterSeed.accountId)
    : undefined;
  // Closing the first-run dialog leaves an empty window that still offers Add account.
  const [firstRunClosed, setFirstRunClosed] = useState(false);
  // After the first account, one short step with the keys to start with. A touch screen skips it.
  const [firstRunDone, setFirstRunDone] = useState(false);
  const [signInAgainId, setSignInAgain] = useAtom(signInAgainAtom);
  const signInAgain =
    dialog === "add" ? accountList.find((a) => a.id === signInAgainId) : undefined;
  useEffect(() => {
    if (dialog !== "add" && signInAgainId !== null) setSignInAgain(null);
  }, [dialog, signInAgainId, setSignInAgain]);
  // The first Settings open spent 1.5 s importing and evaluating its chunk. The window imports it
  // while idle after mail shows, so Settings paints on the first open as fast as on later ones.
  useEffect(
    () => (hasAccounts ? browserClock.idle(() => Settings.preload()) : constVoid),
    [hasAccounts],
  );
  return (
    <>
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
            {...(signInAgain && providerCapabilities(signInAgain.provider).signIn === "password"
              ? { signInAgain }
              : {})}
            onClose={() => {
              setDialog(null);
              setFirstRunClosed(true);
            }}
            onAdded={(a) => {
              setDialog(null);
              const email = a.email;
              say({ text: t`Added ${email}. Syncing…` });
              if (!hasAccounts && !isTouchWeb()) setFirstRunDone(true);
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
          onStart={startSnooze}
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
      {firstRunDone && !dialog && (
        <FirstRunDone
          onClose={() => setFirstRunDone(false)}
          // AI Access lives on the Mac; the web build has no such settings page.
          onAiAccess={
            isDesktop()
              ? () => {
                  setFirstRunDone(false);
                  settingsRequest.setSettingsTab("ai");
                  setDialog("settings");
                }
              : undefined
          }
        />
      )}
      {dialog === "settings" && (
        <Settings
          accounts={accountList}
          initialTab={
            settingsRequest.optionalAccountId
              ? "accounts"
              : (settingsRequest.settingsTab ?? "general")
          }
          optionalAccountId={settingsRequest.optionalAccountId}
          onClose={() => {
            setDialog(null);
            settingsRequest.setOptionalAccountId(null);
            settingsRequest.setSettingsTab(null);
          }}
          onAddAccount={(account) => {
            setSignInAgain(account?.id ?? null);
            setDialog("add");
          }}
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
    </>
  );
}
