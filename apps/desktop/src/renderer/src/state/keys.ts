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
  ai: "ai",
  cache: "cache",
  /** Disk scans refresh on focus/interval and explicit cache mutations. */
  storage: "storage",
  accounts: "accounts",
  organization: "organization",
  sendAs: "send-as",
  serverSettings: "server-settings",
  /** Thread lists: mailboxes, filters, search, the overview. */
  threads: "threads",
  thread: "thread",
  labels: "labels",
  counts: "counts",
  profiles: "profiles",
  proposals: "proposals",
  audit: "audit",
  failedOps: "failed-ops",
  agentMode: "agent-mode",
  /** AI apps' MCP configs and their recent tool calls. */
  aiClients: "ai-clients",
  setup: "setup",
  prefs: "prefs",
  signatures: "signatures",
  templates: "templates",
  /** Recipient suggestions and the addresses hidden from them. */
  contacts: "contacts",
  /** Senders and domains allowed to load remote images. */
  imageSenders: "image-senders",
} as const;

const threadKey = (id: string) => `${Keys.thread}:${id}`;

/** What a change to threads touches: the lists, counts, the log, and the threads themselves. */
export const threadChangeKeys = (ids: readonly string[]) => [
  Keys.threads,
  Keys.counts,
  Keys.audit,
  ...ids.map(threadKey),
];

/** Everything the main process can change behind the app's back. */
export const MAIL_KEYS = [
  Keys.ai,
  Keys.cache,
  Keys.accounts,
  Keys.organization,
  Keys.sendAs,
  Keys.serverSettings,
  Keys.threads,
  Keys.thread,
  Keys.labels,
  Keys.counts,
  Keys.profiles,
  Keys.proposals,
  Keys.audit,
  Keys.failedOps,
  Keys.agentMode,
  Keys.setup,
  Keys.prefs,
  Keys.signatures,
  Keys.templates,
  Keys.contacts,
  Keys.imageSenders,
];
