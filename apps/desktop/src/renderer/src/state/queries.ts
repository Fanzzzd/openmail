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
