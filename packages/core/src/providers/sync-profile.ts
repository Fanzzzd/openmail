/**
 * How each provider's sync state is laid out, as plain data that sync health
 * and sync reset read instead of comparing provider names. Unlike
 * `providerCapabilities`, these are protocol details no UI asks about: which
 * scopes a server reports counts for, the initial header window, and what a
 * presence probe returns.
 */
import type { Provider } from "../domain/account.js";
import { isOutlookClassification } from "../domain/message.js";
import { INITIAL_LIMIT as GMAIL_INITIAL_LIMIT } from "./gmail/api.js";
import { WINDOW_KEY as OUTLOOK_WINDOW_KEY } from "./outlook/graph.js";

/** Local state a location-only probe cannot see: read, starred, important and categories. */
export const stateLabel = (label: string) =>
  ["UNREAD", "STARRED", "IMPORTANT"].includes(label) || label.startsWith("category:");
/** Outlook probes also miss Focused/Other. */
export const outlookStateLabel = (label: string) =>
  stateLabel(label) || isOutlookClassification(label);

export const RESET_VERIFICATION_LIMIT = 500;
/**
 * Outlook verifies 20 ids per $batch request, so 2000 is 100 requests. A bulk delete on the
 * server reaches the local store within a few syncs; a throttled batch still defers the rest.
 */
export const OUTLOOK_RESET_VERIFICATION_LIMIT = 2000;

export interface SyncProfile {
  /**
   * Scopes are the folder paths the sync cursor tracks (IMAP). Local rows are
   * looked up by path and the cursor's UID sets bound what should be cached.
   */
  readonly folderPaths: boolean;
  /** System scopes a health report always checks. Labels seen on messages are added to them. */
  readonly systemScopes: readonly string[];
  /** The first sync caches headers for at most this many messages from the last 90 days. */
  readonly initialHeaderLimit: number;
  /**
   * The cursor key that marks a bounded first sync. Null when every first
   * sync is bounded until backfill finishes.
   */
  readonly windowMarker: string | null;
  /** Scopes whose server count lags, so an excess is checked once more before it counts. */
  readonly recount: (scope: string) => boolean;
  /** An excess in Drafts gets a sampled verification diagnostic. */
  readonly draftExcessDiagnostic: boolean;
  /** Message ids one sync may verify during a reset. */
  readonly resetVerificationLimit: number;
  /**
   * Labels a presence probe does not report, so the local values are kept.
   * Null when the probe returns every label.
   */
  readonly probeMisses: ((label: string) => boolean) | null;
}

const GMAIL_SCOPES = [
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "STARRED",
  "IMPORTANT",
  "UNREAD",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];
const OUTLOOK_SCOPES = ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "ARCHIVE"];

const TABLE: Record<Provider, SyncProfile> = {
  gmail: {
    folderPaths: false,
    systemScopes: GMAIL_SCOPES,
    initialHeaderLimit: GMAIL_INITIAL_LIMIT,
    windowMarker: null,
    recount: (scope) => scope === "DRAFT" || scope.startsWith("CATEGORY_"),
    draftExcessDiagnostic: false,
    resetVerificationLimit: RESET_VERIFICATION_LIMIT,
    probeMisses: null,
  },
  outlook: {
    folderPaths: false,
    systemScopes: OUTLOOK_SCOPES,
    initialHeaderLimit: 5000,
    windowMarker: OUTLOOK_WINDOW_KEY,
    recount: (scope) => scope === "DRAFT",
    draftExcessDiagnostic: true,
    resetVerificationLimit: OUTLOOK_RESET_VERIFICATION_LIMIT,
    probeMisses: outlookStateLabel,
  },
  imap: {
    folderPaths: true,
    systemScopes: [],
    initialHeaderLimit: 1000,
    windowMarker: null,
    recount: () => false,
    draftExcessDiagnostic: false,
    resetVerificationLimit: RESET_VERIFICATION_LIMIT,
    probeMisses: stateLabel,
  },
};

export const syncProfile = (provider: Provider): SyncProfile => TABLE[provider];

/** System scope names across providers. Health exports keep these and number the rest. */
export const SYSTEM_SCOPES: ReadonlySet<string> = new Set(
  Object.values(TABLE).flatMap((profile) => profile.systemScopes),
);
