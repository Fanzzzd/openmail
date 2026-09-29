/**
 * Reactivity keys. Query atoms register the keys of the data they read;
 * mutations invalidate the keys of the data they change, and every mounted
 * query registered under one of those keys refetches.
 *
 * One thread is registered as `{ thread: [id] }`, which listens on both
 * "thread" and "thread:<id>". A mutation invalidates `threadKey(id)` for one
 * thread, or "thread" for all of them.
 */
export const Keys = {
  accounts: "accounts",
  /** Thread lists: mailboxes, filters, search, the overview. */
  threads: "threads",
  /** Every open thread. */
  thread: "thread",
  labels: "labels",
  /** Unread counts per account and per label. */
  counts: "counts",
  profiles: "profiles",
  proposals: "proposals",
  audit: "audit",
  agentMode: "agent-mode",
  /** Which OAuth clients are configured. */
  setup: "setup",
} as const;

export const threadKey = (id: string) => `${Keys.thread}:${id}`;

/** What a change to threads touches: the lists, counts, the log, and the threads themselves. */
export const threadChangeKeys = (ids: readonly string[]) => [
  Keys.threads,
  Keys.counts,
  Keys.audit,
  ...ids.map(threadKey),
];

/** Everything the main process can change behind the app's back. */
export const MAIL_KEYS = [
  Keys.accounts,
  Keys.threads,
  Keys.thread,
  Keys.labels,
  Keys.counts,
  Keys.profiles,
  Keys.proposals,
  Keys.audit,
  Keys.agentMode,
  Keys.setup,
];
