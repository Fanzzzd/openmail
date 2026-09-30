/**
 * Read atoms over the main process. Each is an `AsyncResult` that refetches
 * when a mutation or a `Changed` event invalidates its keys (see `keys.ts`).
 * Parameterised queries go through `MailClient.query`, which memoises one atom
 * per structurally equal payload, so calling these in render is cheap.
 */
import { Duration, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type { Message } from "../../../shared/api";
import type { AppError } from "../errors";
import { MailClient } from "../rpc";
import { Keys } from "./keys";

/** Lists the whole app shows stay loaded for the life of the window. */
const always = { timeToLive: Duration.infinity };
/** Views you switch between stay cached a while, so going back is instant. */
const cached = { timeToLive: Duration.minutes(5) };

export const accountsAtom = MailClient.query("Accounts", undefined, {
  reactivityKeys: [Keys.accounts],
  ...always,
});

export const profilesAtom = MailClient.query("Profiles", undefined, {
  reactivityKeys: [Keys.profiles],
  ...always,
});

/** Unread count per account id. */
export const unreadCountsAtom = MailClient.query("UnreadCounts", undefined, {
  reactivityKeys: [Keys.counts],
  ...always,
});

/** Labels and folders, limited to `accountIds` when given. */
export const labelsAtom = (accountIds?: readonly string[]) =>
  MailClient.query("Labels", accountIds ? { accountIds } : {}, {
    reactivityKeys: [Keys.labels],
    ...cached,
  });

/** Unread count per label id, optionally only for mail that also carries `within`. */
export const unreadByLabelAtom = (accountIds?: readonly string[], within?: string) =>
  MailClient.query(
    "UnreadByLabel",
    { ...(accountIds ? { accountIds } : {}), ...(within ? { within } : {}) },
    { reactivityKeys: [Keys.counts], ...cached },
  );

/** The newest unread inbox threads of a group of accounts, for the overview. */
export const unreadInboxAtom = (accountIds: readonly string[]) =>
  MailClient.query(
    "Threads",
    { query: { mailbox: "inbox", accountIds, unreadOnly: true, limit: 5 } },
    { reactivityKeys: [Keys.threads], ...cached },
  );

const noThread = Atom.make(AsyncResult.initial<readonly Message[], AppError>());

/** The messages of the thread containing message `id`; stays `Initial` for null. */
export const threadAtom = (id: string | null) =>
  id === null
    ? noThread
    : MailClient.query("Thread", { id }, { reactivityKeys: { [Keys.thread]: [id] }, ...cached });

/** Ticks every 10 s while something depends on it. */
const every10s = Atom.make(Stream.fromSchedule(Schedule.spaced("10 seconds")));

/**
 * Proposals waiting for a person. Agents add them from the MCP process, which
 * the main process does not hear about, so this also refetches every 10 s.
 */
export const proposalsAtom = MailClient.query("Proposals", undefined, {
  reactivityKeys: [Keys.proposals],
  ...always,
}).pipe(Atom.makeRefreshOnSignal(every10s));

export const auditAtom = MailClient.query(
  "Audit",
  { limit: 200 },
  { reactivityKeys: [Keys.audit], ...cached },
);

export const agentModeAtom = MailClient.query("AgentWriteMode", undefined, {
  reactivityKeys: [Keys.agentMode],
  ...cached,
});

export const clientSetupAtom = MailClient.query("ClientSetup", undefined, {
  reactivityKeys: [Keys.setup],
  ...cached,
});

/** Server settings and notes for the IMAP providers core knows. Never changes. */
export const imapPresetsAtom = MailClient.query("ImapPresets", undefined, always);

export const prefsAtom = MailClient.query("Prefs", undefined, {
  reactivityKeys: [Keys.prefs],
  ...always,
});

export const signaturesAtom = MailClient.query("Signatures", undefined, {
  reactivityKeys: [Keys.signatures],
  ...always,
});

export const templatesAtom = MailClient.query("Templates", undefined, {
  reactivityKeys: [Keys.templates],
  ...cached,
});

export const hiddenContactsAtom = MailClient.query("HiddenContacts", undefined, {
  reactivityKeys: [Keys.contacts],
  ...cached,
});

export const imageSendersAtom = MailClient.query("ImageSenders", undefined, {
  reactivityKeys: [Keys.imageSenders],
  ...always,
});

/** A message's inline (cid:) images as data: URLs. Fetched from the provider, so cached a while. */
export const inlineImagesAtom = (id: string) =>
  MailClient.query("InlineImages", { id }, { timeToLive: Duration.minutes(10) });

/** A message's original source, for View Original. */
export const rawMessageAtom = (id: string) =>
  MailClient.query("RawMessage", { id }, { timeToLive: Duration.minutes(2) });

/** Recipient suggestions for what is typed in a To, Cc or Bcc field, sending from `from`. */
export const suggestionsAtom = (query: string, from: string | undefined) =>
  MailClient.query("SuggestContacts", from === undefined ? { query } : { query, exclude: from }, {
    reactivityKeys: [Keys.contacts],
    timeToLive: Duration.seconds(30),
  });

export const labelPreferencesAtom = MailClient.query("LabelPreferences", undefined, {
  reactivityKeys: [Keys.organization],
  ...always,
});
export const organizationAtom = MailClient.query("Organization", undefined, {
  reactivityKeys: [Keys.organization],
  ...always,
});
export const sendAsAtom = MailClient.query("SendAs", undefined, {
  reactivityKeys: [Keys.sendAs],
  ...always,
});
export const filtersListAtom = (accountId: string) =>
  MailClient.query("Filters", { accountId }, { reactivityKeys: [Keys.serverSettings], ...cached });
export const vacationAtom = (accountId: string) =>
  MailClient.query("Vacation", { accountId }, { reactivityKeys: [Keys.serverSettings], ...cached });

export const indexingProgressAtom = MailClient.query("IndexingProgress", undefined, {
  reactivityKeys: ["indexing"],
  ...always,
}).pipe(Atom.makeRefreshOnSignal(every10s));
export const mediaImageAtom = (chunk: import("../../../shared/api").DerivedChunk) =>
  MailClient.query("MediaImage", { chunk }, { timeToLive: Duration.minutes(2) });
export const invitationsAtom = (messageId: string) =>
  MailClient.query("Invitations", { messageId }, { timeToLive: Duration.minutes(10) });
export const contactSyncAtom = MailClient.query("ContactSync", undefined, {
  reactivityKeys: [Keys.contacts],
  ...always,
});
