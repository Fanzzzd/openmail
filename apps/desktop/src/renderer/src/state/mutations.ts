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
import { MailClient } from "../rpc";
import { Keys, MAIL_KEYS } from "./keys";
import { decideProposal, reauthAccount, saveDraft, withMail } from "./mail";

type ConnectInput = typeof ConnectInputSchema.Type;

export const setAgentModeAtom = MailClient.mutation("SetAgentWriteMode");
export const deleteProfileAtom = MailClient.mutation("DeleteProfile");
export const setPrefsAtom = MailClient.mutation("SetPrefs");
export const setSignatureAtom = MailClient.mutation("SetSignature");
export const saveTemplateAtom = MailClient.mutation("SaveTemplate");
export const deleteTemplateAtom = MailClient.mutation("DeleteTemplate");
export const setContactHiddenAtom = MailClient.mutation("SetContactHidden");

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

export type ClientInput =
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

export const reauthAtom = Atom.family((accountId: string) =>
  MailClient.runtime.fn(() => reauthAccount(accountId)),
);

export const removeAccountAtom = Atom.family((accountId: string) =>
  MailClient.runtime.fn(() =>
    withMail((call) => call("RemoveAccount", { accountId })).pipe(Reactivity.mutation(MAIL_KEYS)),
  ),
);

/** Approves (true) or rejects (false) one proposal. */
export const decideAtom = Atom.family((id: number) =>
  MailClient.runtime.fn((approve: boolean) => decideProposal(id, approve)),
);

export interface ProfileSave {
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
