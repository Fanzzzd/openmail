/**
 * Read atoms over the main process. Each is an `AsyncResult` that refetches
 * when a mutation or a `Changed` event invalidates its keys (see `keys.ts`).
 * Parameterised queries go through `MailClient.query`, which memoises one atom
 * per structurally equal payload, so calling these in render is cheap.
 */
import { Duration, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type { Message } from "../../../shared/api";
import type { AppError } from "../lib/errors";
import { MailClient } from "./rpc";
import { Keys } from "./keys";

/** Lists the whole app shows stay loaded for the life of the window. */
const always = { timeToLive: Duration.infinity };
/** Views you switch between stay cached a while, so going back is instant. */
const cached = { timeToLive: Duration.minutes(5) };
/** Bodies and base64 images are owned by the mounted reader, not its history. */
const readerContent = { timeToLive: Duration.zero };

export const accountsAtom = MailClient.query("Accounts", undefined, {
  reactivityKeys: [Keys.accounts],
  ...always,
});

export const profilesAtom = MailClient.query("Profiles", undefined, {
  reactivityKeys: [Keys.profiles],
  ...always,
});

export const unreadCountsAtom = MailClient.query("UnreadCounts", undefined, {
  reactivityKeys: [Keys.counts],
  ...always,
});

export const labelsAtom = (accountIds?: readonly string[]) =>
  MailClient.query("Labels", accountIds ? { accountIds } : {}, {
    reactivityKeys: [Keys.labels],
    ...cached,
  });

/** Unread count per label id, optionally only for mail that also carries `within`. */
export const unreadByLabelAtom = (
  accountIds?: readonly string[],
  within?: string,
  conversations = false,
) =>
  MailClient.query(
    "UnreadByLabel",
    { ...(accountIds ? { accountIds } : {}), ...(within ? { within } : {}), conversations },
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
const draftThread = Atom.make(AsyncResult.success<readonly Message[]>([]));

/** Null has no selection; local drafts belong to the draft store and have no message thread. */
export const threadAtom = (id: string | null) =>
  id === null
    ? noThread
    : id.startsWith("draft:")
      ? draftThread
      : MailClient.query(
          "Thread",
          { id },
          { reactivityKeys: { [Keys.thread]: [id] }, ...readerContent },
        );

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

export const failedOpsAtom = MailClient.query("FailedOps", undefined, {
  reactivityKeys: [Keys.failedOps],
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

/** Read again each time AI Access opens: other apps change their configs and call tools. */
export const aiClientsAtom = MailClient.query("AiClients", undefined, {
  reactivityKeys: [Keys.aiClients],
  timeToLive: Duration.zero,
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

export const namedSignaturesAtom = MailClient.query("NamedSignatures", undefined, {
  reactivityKeys: [Keys.signatures],
  ...always,
});
export const signatureDefaultsAtom = MailClient.query("SignatureDefaults", undefined, {
  reactivityKeys: [Keys.signatures],
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

export const contactAlternativesAtom = (address: string) =>
  MailClient.query(
    "ContactAlternatives",
    { address },
    { reactivityKeys: [Keys.contacts], ...cached },
  );
export const draftStatusAtom = (id: string) =>
  MailClient.query("DraftStatus", { id }, { reactivityKeys: [Keys.threads], ...cached });
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
  MailClient.query("InlineImages", { id }, { timeToLive: Duration.minutes(2) });

/** A message's original source, for View Original. */
export const rawMessageAtom = (id: string) => MailClient.query("RawMessage", { id }, readerContent);

export const knownSendersAtom = (accountId: string, addresses: readonly string[]) =>
  MailClient.query(
    "KnownSenders",
    { accountId, addresses },
    { reactivityKeys: [Keys.contacts], ...cached },
  );

/** Contact suggestions for recipient/search fields, optionally limited to selected accounts. */
export const suggestionsAtom = (
  query: string,
  from: string | undefined,
  accountIds?: readonly string[],
) =>
  MailClient.query(
    "SuggestContacts",
    {
      query,
      ...(from === undefined ? {} : { exclude: from }),
      ...(accountIds === undefined ? {} : { accountIds }),
    },
    {
      reactivityKeys: [Keys.contacts],
      timeToLive: Duration.seconds(30),
    },
  );

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
  MailClient.query(
    "Invitations",
    { messageId },
    { reactivityKeys: [Keys.threads, Keys.audit], timeToLive: Duration.minutes(10) },
  );
export const contactSyncAtom = MailClient.query("ContactSync", undefined, {
  reactivityKeys: [Keys.contacts],
  ...always,
});

export const cacheWindowsAtom = MailClient.query("CacheWindows", undefined, {
  reactivityKeys: [Keys.cache],
});
export const backfillStateAtom = MailClient.query("BackfillState", undefined, {
  reactivityKeys: [Keys.cache],
});

export const contactGroupsAtom = (query: string, accountIds?: readonly string[]) =>
  MailClient.query(
    "ContactGroups",
    { query, ...(accountIds ? { accountIds } : {}) },
    { reactivityKeys: [Keys.contacts], ...cached },
  );
export const contactPhotoAtom = (accountId: string, address: string) =>
  MailClient.query(
    "ContactPhoto",
    { accountId, address },
    { reactivityKeys: [Keys.contacts, Keys.prefs], ...cached },
  );
export const calendarEventsAtom = (messageId: string, key: string) =>
  MailClient.query("CalendarEvents", { messageId, key }, { timeToLive: Duration.minutes(1) });
export const detectedEventsAtom = (messageId: string) =>
  MailClient.query(
    "DetectedEvents",
    { messageId },
    { reactivityKeys: [Keys.threads], timeToLive: Duration.minutes(1) },
  );

export const updateStateAtom = MailClient.query("UpdateState", undefined, {
  reactivityKeys: [Keys.cache],
  ...always,
}).pipe(Atom.makeRefreshOnSignal(every10s));

export { appleContactsStatusAtom } from "./apple-contacts";
export const appleContactIdentifierAtom = (address: string) =>
  MailClient.query(
    "AppleContactIdentifier",
    { address },
    { reactivityKeys: [Keys.contacts, Keys.prefs], ...cached },
  );

export const nativeComposeCapabilitiesAtom = MailClient.query(
  "NativeComposeCapabilities",
  undefined,
  cached,
);
