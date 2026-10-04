import {
  type Deferred,
  type Duration,
  Effect,
  type Fiber,
  FiberSet,
  Option,
  PubSub,
  Ref,
  Schedule,
  Schema,
  type Scope,
  Semaphore,
} from "effect";
import { AttachmentCache } from "./attachment-cache.js";
import {
  type inlineImagesFromRaw as unboundInlineImagesFromRaw,
  type inlineMediaFromRaw as unboundInlineMediaFromRaw,
} from "./attachments.js";
import {
  type Actor,
  type IncomingMessage,
  type MailOp,
  type Outcome,
  type OutgoingMessage,
  type Provider,
  type SyncResult,
} from "./domain.js";
import { type parseRawDraft as unboundParseRawDraft } from "./drafts.js";
import { type ImapIdle } from "./imap-idle.js";
import { applyOpToLabels } from "./mail-ops.js";
import { type Mailbox, type MailboxEvent, type PerformError, type SyncState } from "./mailbox.js";
import { type ModelRuntime, type Vision } from "./media.js";
import { type QueuedSend } from "./mobile-outbox.js";
import { type Model } from "./model.js";
import { type PlatformCrypto } from "./platform/crypto.js";
import { type MailCodec } from "./platform/mail-codec.js";
import { type AppVerifier, type AttachmentFiles, type ImageNetwork } from "./platform/runtime.js";
import { type AppConfig, type Providers, type Secrets, type Store } from "./services.js";
import { type UnsubscribeNetwork } from "./unsubscribe.js";
export const isAiProposalActor = (actor: Actor): boolean =>
  actor.kind === "agent" &&
  (actor.surface === "mcp" || actor.surface === "assistant" || actor.name === "openmail-assistant");

export const withAgentOrigin = (message: OutgoingMessage, actor: Actor): OutgoingMessage =>
  isAiProposalActor(actor)
    ? {
        ...message,
        agentOrigin: {
          recipients: [...message.to, ...message.cc, ...message.bcc].map((a) => a.address),
          ...(message.inReplyTo ? { replyTo: message.inReplyTo } : {}),
        },
      }
    : message;

export const isSpecialAgentLabel = (value: string) => {
  const name = value
    .trim()
    .replace(/[\s_\-\\]/g, "")
    .toUpperCase();
  return (
    /^(INBOX|TRASH|SPAM|DRAFTS?|SENT|JUNK(EMAIL)?|DELETED(ITEMS|MESSAGES)?|ARCHIVE|OUTBOX|ALLMAIL|IMPORTANT|STARRED|UNREAD)$/.test(
      name,
    ) ||
    /^CATEGORY(PERSONAL|SOCIAL|PROMOTIONS|UPDATES|FORUMS)$/.test(name) ||
    value.startsWith("category:") ||
    value.startsWith("mailbox:")
  );
};

export class PendingOpClaimLost extends Schema.TaggedError<PendingOpClaimLost>()(
  "PendingOpClaimLost",
  {
    message: Schema.String,
  },
) {}

export const WRITE_RECOVERY_WINDOW_MS = 2 * 60_000;

export const isWaitingSend = (item: QueuedSend) => item.status === "waiting";

export const desktopSendForOwner = (owner?: string) => (item: QueuedSend) =>
  item.desktopUndo === true &&
  isWaitingSend(item) &&
  (owner === undefined || item.desktopOwner === owner);

export const MAX_OP_AGE = 7 * 86_400_000;

export const WRITE_BATCH = 200;

export const DEFAULT_MODEL_CHARS = 12_000;

export const DEFAULT_SUGGESTIONS = 8;

export const isTransientPull = (e: {
  readonly _tag: string;
  readonly status?: number | undefined;
  readonly deferred?: boolean;
}) =>
  e._tag === "ProviderError" &&
  !e.deferred &&
  (e.status === undefined || e.status === 429 || e.status >= 500);

export const PULL_RETRY = {
  schedule: Schedule.exponential("5 seconds"),
  times: 2,
  while: isTransientPull,
};

export const cacheIO = <A>(work: () => Promise<A>, fallback: A) =>
  Effect.tryPromise(work).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Attachment cache unavailable", error).pipe(Effect.as(fallback)),
    ),
  );

export const SYNC_RETRY_MESSAGE = "Sync could not finish. It will retry automatically.";

export interface MailboxOptions {
  /** Desktop releases optional startup work after its first window is painted. */
  backgroundReady?: Effect.Effect<void>;
  imapIdle?: boolean;
  attachmentCacheDirectory?: string;
  imageDownloader?: import("./compose-images.js").ImageDownloader;
  /** Sync every account on this interval after backgroundReady. Desktop enables it; CLI and MCP don't. */
  autoSync?: Duration.Input;
  /** Desktop enables its independent idle indexer. CLI/MCP only read derived content. */
  media?: { vision: Vision; onBattery: () => boolean; idle: () => boolean };

  /** Desktop only. Independent inbox cursors leave full sync checkpoints untouched. */
  inboxPoll?: Duration.Input;
  pollOnBattery?: () => boolean;
  models?: ModelRuntime;
  /** Desktop reports foreground or AC power; absent means automatic triage cannot run. */
  canTriage?: () => boolean;
  /**
   * Push draft saves in the background (default) so saving never waits for
   * the network. Short-lived processes and tests set false: the save then
   * returns after the push was tried.
   */
  backgroundFlush?: boolean;
  /** Mobile retains draft attachments locally until the person sends. */
  localDraftQueue?: boolean;
  /** Only desktop main may resume persisted desktop sends. */
  resumeDesktopSends?: boolean;
}

export const withPendingOps = (
  incoming: IncomingMessage,
  ops: readonly MailOp[],
  provider: Provider,
): IncomingMessage => {
  if (!ops.length) return incoming;
  const labels = ops.reduce(
    (current, op) => applyOpToLabels(current, op, provider),
    [...incoming.labels],
  );
  return {
    ...incoming,
    labels,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
  };
};
export interface MailboxDependencies {
  crypto: PlatformCrypto;
  mailboxScope: Scope.Scope;
  codec: typeof MailCodec.Service;
  files: typeof AttachmentFiles.Service;
  network: typeof ImageNetwork.Service;
  unsubscribeNetwork: typeof UnsubscribeNetwork.Service;
  verifier: typeof AppVerifier.Service;
  store: Store["Service"];
  providers: Providers["Service"];
  secrets: Secrets["Service"];
  config: AppConfig["Service"];
  model: typeof Model.Service;
  diskAttachments: ReturnType<typeof AttachmentFiles.Service.open> | undefined;
  options: MailboxOptions;
  backgroundReady: Effect.Effect<void>;
  readOnly: boolean;
  newDraftId: () => string;
  parseRawDraft: (
    ...args: Parameters<typeof unboundParseRawDraft>
  ) => Effect.Effect<
    Effect.Success<ReturnType<typeof unboundParseRawDraft>>,
    Effect.Error<ReturnType<typeof unboundParseRawDraft>>
  >;
  inlineImagesFromRaw: (
    ...args: Parameters<typeof unboundInlineImagesFromRaw>
  ) => Effect.Effect<
    Effect.Success<ReturnType<typeof unboundInlineImagesFromRaw>>,
    Effect.Error<ReturnType<typeof unboundInlineImagesFromRaw>>
  >;
  inlineMediaFromRaw: (
    ...args: Parameters<typeof unboundInlineMediaFromRaw>
  ) => Effect.Effect<
    Effect.Success<ReturnType<typeof unboundInlineMediaFromRaw>>,
    Effect.Error<ReturnType<typeof unboundInlineMediaFromRaw>>
  >;
  emit: (event: MailboxEvent) => Effect.Effect<boolean>;
  changed: Effect.Effect<boolean>;
  mutate: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  imapPullLock: (accountId: string) => Semaphore.Semaphore;
  onBattery: () => boolean;
  pollInterval: number;
  resetConnectivity: Effect.Effect<void>;
  mailbox: () => Mailbox["Service"];
}
/** Mutable state shared by mailbox effects; operation-local variables stay in their factories. */
export const makeMailboxRuntimeState = Effect.gen(function* () {
  const adapters = new Map<Provider, import("./services.js").ProviderAdapter>();
  const attachmentCache = new AttachmentCache();

  const syncPaused = false;
  const attachmentEpoch = 0;
  const pubsub = yield* PubSub.unbounded<MailboxEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
  const state = yield* Ref.make<SyncState>({
    running: false,
    lastFinishedAt: null,
    errors: [],
  });
  const inflight = yield* Ref.make(Option.none<Deferred.Deferred<SyncResult[]>>());
  const syncLock = yield* Semaphore.make(1);
  const polling = new Map<string, { failures: number; due: number }>();
  const background = yield* FiberSet.make();
  const flushLock = yield* Semaphore.make(1);
  const imapPullLocks = new Map<string, Semaphore.Semaphore>();
  const headerLocks = new Map<string, Semaphore.Semaphore>();
  const pendingSends = 0;
  const outboxLock = yield* Semaphore.make(1);
  const undoSendWorkers = new Map<
    string,
    { worker: Fiber.Fiber<Outcome, PerformError>; token: symbol }
  >();
  return {
    adapters,
    attachmentCache,
    idle: Option.getOrUndefined(Option.none<ImapIdle>()),
    syncPaused,
    attachmentEpoch,
    pubsub,
    syncState: state,
    inflight,
    syncLock,
    polling,
    background,
    flushLock,
    imapPullLocks,
    headerLocks,
    pendingSends,
    outboxLock,
    undoSendWorkers,
    nextHeadersAccount: 0,
    nextAccount: 0,
  };
});
export type MailboxRuntimeState = Effect.Success<typeof makeMailboxRuntimeState>;
