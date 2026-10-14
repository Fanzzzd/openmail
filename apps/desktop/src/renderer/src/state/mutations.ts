import type { AuthorizationFeature } from "@openmail/core/schema";
/**
 * Mutation atoms for forms that show pending and error state. Write one with
 * `useAtom(atom, { mode: "promiseExit" })`; its value is the `AsyncResult` of
 * the last call. Calls that one screen can make for several rows at once are
 * families keyed by the row, so rows never share or cancel each other's state.
 */
import { Effect } from "effect";
import { Atom, Reactivity } from "effect/reactivity";

import type { Account, DraftInput, Profile, ProfileInput } from "../../../shared/api";
import type { ConnectInput as ConnectInputSchema } from "../../../shared/rpc";
import { MailClient } from "./rpc";
import { Keys, MAIL_KEYS } from "./keys";
import { decideProposal, reauthAccount, saveDraft, withMail } from "./mail";
import { recentSearches } from "./recent-searches";

type ConnectInput = typeof ConnectInputSchema.Type;

export const setAgentModeAtom = MailClient.mutation("SetAgentWriteMode");
export const deleteProfileAtom = MailClient.mutation("DeleteProfile");
export const setAccountSettingsAtom = Atom.family((_id: string) =>
  MailClient.mutation("SetAccountSettings"),
);
export const moveAccountAtom = MailClient.mutation("MoveAccount");
export const setAppleContactsAtom = MailClient.mutation("SetAppleContacts");
export const setPrefsAtom = MailClient.mutation("SetPrefs");
export const chooseAttachmentFolderAtom = MailClient.mutation("ChooseAttachmentFolder");
export const saveNamedSignatureAtom = MailClient.mutation("SaveNamedSignature");
export const deleteNamedSignatureAtom = MailClient.mutation("DeleteNamedSignature");
export const setSignatureDefaultAtom = MailClient.mutation("SetSignatureDefault");
export const saveTemplateAtom = MailClient.mutation("SaveTemplate");
export const deleteTemplateAtom = MailClient.mutation("DeleteTemplate");
export const setContactHiddenAtom = MailClient.mutation("SetContactHidden");
export const setImageSenderAtom = MailClient.mutation("SetImageSender");

/** Autosave of one compose window, keyed by draft id; its value shows the save state. */
export const saveDraftAtom = Atom.family((_draftId: string) =>
  MailClient.runtime.fn((draft: DraftInput) => saveDraft(draft)),
);

/**
 * Connects a Gmail, Outlook or IMAP account. One atom per provider choice, so
 * going back and picking another provider starts without the last error.
 */
export const connectAtom = Atom.family((_choice: string) =>
  MailClient.runtime.fn((input: ConnectInput) =>
    withMail((call) => call("Connect", { input })).pipe(Reactivity.mutation(MAIL_KEYS)),
  ),
);

type ClientInput =
  | { provider: "gmail"; clientId: string; clientSecret: string }
  | { provider: "outlook"; clientId: string };

/** Saves the OAuth client the person registered with Google or Microsoft. */
export const saveClientAtom = MailClient.runtime.fn((c: ClientInput) =>
  withMail((call) =>
    c.provider === "gmail"
      ? call("SetGoogleClient", { clientId: c.clientId, clientSecret: c.clientSecret })
      : call("SetMicrosoftClient", { clientId: c.clientId }),
  ).pipe(Reactivity.mutation([Keys.setup])),
);

/** Removes the person's own client, so new sign-ins use the built-in one. */
export const clearClientAtom = MailClient.runtime.fn((provider: "gmail" | "outlook") =>
  withMail((call) => call("ClearClient", { provider })).pipe(Reactivity.mutation([Keys.setup])),
);

export const reauthAtom = Atom.family((accountId: string) =>
  MailClient.runtime.fn((feature?: AuthorizationFeature) => reauthAccount(accountId, feature)),
);
export const authorizePermanentDeleteAtom = Atom.family((accountId: string) =>
  MailClient.runtime.fn(() => reauthAccount(accountId, "permanentDelete")),
);

export const removeAccountAtom = Atom.family((accountId: string) =>
  MailClient.runtime.fn(() =>
    withMail((call) => call("RemoveAccount", { accountId })).pipe(
      // Recent searches can name the removed account's people; they go with it.
      Effect.tap(() => Effect.sync(() => recentSearches.clear())),
      Reactivity.mutation(MAIL_KEYS),
    ),
  ),
);

export const decideAtom = Atom.family((id: number) =>
  MailClient.runtime.fn((approve: boolean) => decideProposal(id, approve)),
);

interface ProfileSave {
  /** The profile being edited; unset to create one. */
  profile?: Profile;
  input: ProfileInput;
  /** Accounts that should end up in the profile. */
  members: ReadonlySet<string>;
  accounts: readonly Account[];
}

/**
 * Creates or updates a profile, then moves accounts in or out of it. An
 * account sits in at most one profile, so assigning it here moves it.
 */
export const saveProfileAtom = MailClient.runtime.fn(
  ({ profile, input, members, accounts }: ProfileSave) =>
    Effect.gen(function* () {
      const call = yield* MailClient;
      let saved: Profile;
      if (profile) {
        yield* call("UpdateProfile", { id: profile.id, input });
        saved = { ...profile, ...input };
      } else {
        saved = yield* call("CreateProfile", { input });
      }
      for (const a of accounts) {
        if (members.has(a.id) && a.profileId !== saved.id) {
          yield* call("AssignProfile", { accountId: a.id, profileId: saved.id });
        } else if (!members.has(a.id) && a.profileId === saved.id) {
          yield* call("AssignProfile", { accountId: a.id, profileId: null });
        }
      }
      return saved;
    }).pipe(Reactivity.mutation([Keys.profiles, Keys.accounts])),
);

export const changeLabelAtom = MailClient.mutation("ChangeLabel");
export const setLabelPreferenceAtom = MailClient.mutation("SetLabelPreference");
export const setOrganizationAtom = MailClient.mutation("SetOrganization");
export const snoozeAtom = MailClient.mutation("Snooze");
export const updateFilterAtom = MailClient.mutation("UpdateFilter");
export const restoreFilterAtom = MailClient.mutation("RestoreFilter");
export const prepareFilterRestorationAtom = MailClient.mutation("PrepareFilterRestoration");
export const discardFilterRestorationAtom = MailClient.mutation("DiscardFilterRestoration");
export const applyFilterAtom = MailClient.mutation("ApplyFilter");
export const prepareFilterAtom = MailClient.mutation("PrepareFilter");
export const createLabelAndApplyAtom = MailClient.mutation("CreateLabelAndApply");
export const createFilterAtom = MailClient.mutation("CreateFilter");
export const deleteFilterAtom = MailClient.mutation("DeleteFilter");
export const setVacationAtom = MailClient.mutation("SetVacation");
export const syncSendAsAtom = MailClient.mutation("SyncSendAs");

export const respondInviteAtom = MailClient.mutation("RespondInvite");
export const refreshContactsAtom = MailClient.mutation("RefreshContacts");
export const setCacheWindowAtom = MailClient.mutation("SetCacheWindow");
export const pauseBackfillAtom = MailClient.mutation("PauseBackfill");

export const createCalendarEventAtom = MailClient.mutation("CreateCalendarEvent");
