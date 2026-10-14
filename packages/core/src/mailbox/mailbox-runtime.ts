import {
  type Deferred,
  type Duration,
  Effect,
  type Fiber,
  FiberSet,
  Option,
  PubSub,
  Ref,
  type Scope,
  Semaphore,
} from "effect";
import { AttachmentCache } from "../mime/attachment-cache.js";
import {
  type inlineImagesFromRaw as unboundInlineImagesFromRaw,
  type inlineMediaFromRaw as unboundInlineMediaFromRaw,
} from "../mime/attachments.js";
import type { Outcome } from "../domain/command.js";
import type { Provider } from "../domain/account.js";
import type { SyncResult } from "../domain/sync-status.js";
import { type parseRawDraft as unboundParseRawDraft } from "../compose/drafts.js";
import { type ImapIdle } from "../providers/imap/imap-idle.js";
import { type Mailbox, type MailboxEvent, type PerformError, type SyncState } from "./mailbox.js";
import { type ModelRuntime, type Vision } from "../ai/media.js";
import { type Model } from "../ai/model.js";
import { type PlatformCrypto } from "../platform/crypto.js";
import { type MailCodec } from "../platform/mail-codec.js";
import { type AppVerifier, type AttachmentFiles, type ImageNetwork } from "../platform/runtime.js";
import type { AppConfig, OAuthIssuers, Secrets } from "../platform/auth.js";
import type { Providers } from "../providers/adapter.js";
import type { Store } from "../store/service.js";
import { type UnsubscribeNetwork } from "./unsubscribe.js";

export interface MailboxOptions {
  /** Desktop releases optional startup work after its first window is painted. */
  backgroundReady?: Effect.Effect<void>;
  imapIdle?: boolean;
  attachmentCacheDirectory?: string;
  imageDownloader?: import("../platform/runtime.js").ImageDownloader;
  /** Sync every account on this interval after backgroundReady. Desktop enables it; CLI and MCP don't. */
  autoSync?: Duration.Input;
  /** Desktop enables its independent idle indexer. CLI/MCP only read derived content. */
  media?: { vision: Vision; onBattery: () => boolean; idle: () => boolean };

  /** Desktop only. Independent inbox cursors leave full sync checkpoints untouched. */
  inboxPoll?: Duration.Input;
  pollOnBattery?: () => boolean;
  /** On-device models. MailboxLive drops them where onDeviceModelsSupported is false. */
  models?: ModelRuntime;
  /**
   * Set by MailboxLive, not by callers: this machine cannot run on-device models (an Intel
   * Mac), so semantic search and the model download stay off.
   */
  modelsUnsupported?: boolean;
  /**
   * Desktop reports foreground or AC power. Automatic triage and automatic summaries run only
   * while it is true; absent means neither runs.
   */
  canTriage?: () => boolean;
  /**
   * The system language as a BCP 47 tag, for AI text made in the background when the language
   * setting follows the system. Desktop passes the OS language.
   */
  systemLocale?: () => string | undefined;
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
  issuers: OAuthIssuers["Service"];
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
  const adapters = new Map<Provider, import("../providers/adapter.js").ProviderAdapter>();
  const attachmentCache = new AttachmentCache();

  const pubsub = yield* PubSub.unbounded<MailboxEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
  const state = yield* Ref.make<SyncState>({
    running: false,
    lastFinishedAt: null,
    errors: [],
  });
  const inflight = yield* Ref.make(Option.none<InflightSync>());
  const syncLock = yield* Semaphore.make(1);
  const polling = new Map<string, { failures: number; due: number }>();
  /** Background work (queue flushes after a draft save) that dies with the layer. */
  const background = yield* FiberSet.make();
  /** One flush at a time in this process; claims keep other processes off the same op. */
  const flushLock = yield* Semaphore.make(1);
  const imapPullLocks = new Map<string, Semaphore.Semaphore>();
  const headerLocks = new Map<string, Semaphore.Semaphore>();
  const outboxLock = yield* Semaphore.make(1);
  const undoSendWorkers = new Map<
    string,
    { worker: Fiber.Fiber<Outcome, PerformError>; token: symbol }
  >();
  const runtime: MailboxRuntimeState = {
    adapters,
    attachmentCache,
    idle: undefined,
    syncPaused: false,
    attachmentEpoch: 0,
    pubsub,
    syncState: state,
    inflight,
    syncLock,
    polling,
    background,
    flushLock,
    imapPullLocks,
    headerLocks,
    pendingSends: 0,
    outboxLock,
    undoSendWorkers,
    nextHeadersAccount: 0,
    nextAccount: 0,
  };
  return runtime;
});
/** The running sync: one account, or every account when `accountId` is undefined. */
export interface InflightSync {
  readonly accountId: string | undefined;
  readonly done: Deferred.Deferred<SyncResult[]>;
  /** Accounts the run covers. Unset until the run has listed them. */
  accountIds: ReadonlySet<string> | undefined;
}
export interface MailboxRuntimeState {
  adapters: Map<Provider, import("../providers/adapter.js").ProviderAdapter>;
  attachmentCache: AttachmentCache;
  idle: ImapIdle | undefined;
  syncPaused: boolean;
  attachmentEpoch: number;
  pubsub: PubSub.PubSub<MailboxEvent>;
  syncState: Ref.Ref<SyncState>;
  inflight: Ref.Ref<Option.Option<InflightSync>>;
  syncLock: Semaphore.Semaphore;
  polling: Map<string, { failures: number; due: number }>;
  background: FiberSet.FiberSet;
  flushLock: Semaphore.Semaphore;
  imapPullLocks: Map<string, Semaphore.Semaphore>;
  headerLocks: Map<string, Semaphore.Semaphore>;
  pendingSends: number;
  outboxLock: Semaphore.Semaphore;
  undoSendWorkers: Map<string, { worker: Fiber.Fiber<Outcome, PerformError>; token: symbol }>;
  nextHeadersAccount: number;
  nextAccount: number;
}
