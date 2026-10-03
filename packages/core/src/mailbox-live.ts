import { makeOptionalServiceMailbox } from "./mailbox-services.js";
import { scopedAdapter, serviceGranted, type AuthorizationFeature } from "./optional-services.js";
import { makeResetGuard, RESET_VERIFICATION_LIMIT } from "./sync-reset.js";
import { readOnlyAdapter, READ_ONLY_MESSAGE } from "./read-only.js";
import { inspectAttachment } from "./attachment-import.js";
import { eventFromInvite, makeFeatureMailbox } from "./mailbox-features.js";
import { UnsubscribeNetwork } from "./unsubscribe.js";
import { PlatformCrypto, sha256Hex } from "./platform/crypto.js";
import { Buffer } from "./platform/bytes.js";
import { destination as outlookDestination } from "./outlook.js";
import { applyOpToLabels, invalidCategoryFolderOp } from "./mail-ops.js";
import { makeAiMailbox } from "./mailbox-ai.js";
import { Model, ModelUnavailable } from "./model.js";
import { modelContext } from "./model-view.js";
import { decodeProviderId, readCursor } from "./imap-cursor.js";
import { ImapIdle } from "./imap-idle.js";
import { AppVerifier, AttachmentFiles, ImageNetwork, PdfWorker } from "./platform/runtime.js";
import { MailCodec } from "./platform/mail-codec.js";
import { AttachmentCache } from "./attachment-cache.js";
import { makeReaderAttachments } from "./reader-attachments.js";
import { isLocalFeedbackDraft } from "./feedback.js";
import { makeFolderMailbox } from "./mailbox-folders.js";
import { GMAIL_PERMANENT_DELETE_SCOPE } from "./folder-actions.js";
import {
  attachmentProblem,
  attachmentSizesProblem,
  attachmentProblemMessage,
  GMAIL_MIME_LIMIT,
} from "./attachment-policy.js";
import { makeDownloadBudget } from "./download-budget.js";
import { makeSemanticIndexer } from "./semantic-indexer.js";
import { quoteSearchValue, parseSearchQuery, semanticRankFusion } from "./search.js";
import { makeIndexer } from "./indexer.js";
import {
  MediaError,
  type DerivedChunk,
  type Vision,
  type ModelRuntime,
  unavailableVision,
} from "./media.js";

import {
  privateMailLink,
  parseStableReference,
  notificationEligible,
  profileNotificationsActive,
} from "./system.js";

import {
  Cause,
  Config,
  Clock,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Semaphore,
  Stream,
  Schema,
} from "effect";

import {
  attachmentRef,
  inlineImagesFromRaw as unboundInlineImagesFromRaw,
  inlineMediaFromRaw as unboundInlineMediaFromRaw,
  MAX_INLINE_BYTES,
  MEDIA_RAW_TOO_LARGE,
} from "./attachments.js";
import type {
  Account,
  Actor,
  Command,
  DraftInput,
  FlushResult,
  Message,
  IncomingMessage,
  MailOp,
  Provider,
  Outcome,
  OutgoingMessage,
  SyncResult,
} from "./domain.js";
import { AccountSettings, actorLabel } from "./domain.js";
import {
  attachmentsKey,
  draftOrganizationKey,
  importedMessage,
  originalAttachment,
  type ParsedDraft,
  parseRawDraft as unboundParseRawDraft,
  withDraftMarkdownSource,
  toDraft,
} from "./drafts.js";
import {
  AuthError,
  SendUncertain,
  FeatureScopeMissing,
  InvalidInput,
  NotFound,
  PermanentError,
  ProviderError,
} from "./errors.js";
import { mobileAttachmentProblem } from "./mobile-outbox.js";
import { isEmailAddress } from "./recipients.js";
import { Mailbox, type MailboxEvent, type SyncState } from "./mailbox.js";
import { renderMarkdown } from "./markdown.js";
import {
  normalizeComposeMessage,
  remoteComposeBody,
  preservedComposeHtml,
} from "./compose-body.js";
import { decide } from "./policy.js";
import {
  AppConfig,
  type Change,
  type ConnectInput,
  type PendingOp,
  type ProviderPushContext,
  type ProviderPushResult,
  Providers,
  Secrets,
  Store,
  type StoredDraft,
} from "./services.js";
import { makeOrganizationMailbox } from "./mailbox-organization.js";
import { checkStoredUpdates, startStoredUpdates, UPDATE_TOKEN_KEY } from "./updates.js";
import { makeSyncHealth } from "./sync-health.js";
import { makeCacheMailbox } from "./mailbox-cache.js";
import { folderTarget } from "./store.js";
import { makeBatchMailbox } from "./mailbox-batch.js";
import { gmailThreadUrl, officialMessageUrl, validMessageProviderId } from "./reading.js";

const isSpecialAgentLabel = (value: string) => {
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

class PendingOpClaimLost extends Schema.TaggedError<PendingOpClaimLost>()("PendingOpClaimLost", {
  message: Schema.String,
}) {}

/** Only a week-old mutation can expire; reconciliation waits for connectivity. */
const MAX_OP_AGE = 7 * 86_400_000;
/** Upserts from a pull land in transactions of this many, or every quarter second. */
const WRITE_BATCH = 200;
const DEFAULT_MODEL_CHARS = 12_000;
const DEFAULT_SUGGESTIONS = 8;

/**
 * A pull that failed on the network (no status: the connection dropped, DNS
 * failed after a wake from sleep), throttling or a 5xx is tried again before
 * the sync counts as failed. The adapters already retry each request for
 * about 8 s; this covers an outage that outlasts that.
 */
const isTransientPull = (e: {
  readonly _tag: string;
  readonly status?: number | undefined;
  readonly deferred?: boolean;
}) =>
  e._tag === "ProviderError" &&
  !e.deferred &&
  (e.status === undefined || e.status === 429 || e.status >= 500);
const PULL_RETRY = {
  schedule: Schedule.exponential("5 seconds"),
  times: 2,
  while: isTransientPull,
};

const cacheIO = <A>(work: () => Promise<A>, fallback: A) =>
  Effect.tryPromise(work).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Attachment cache unavailable", error).pipe(Effect.as(fallback)),
    ),
  );

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
}

// Merge queued intent without running local-action reminder side effects.
const withPendingOps = (
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

export const MailboxLive = (
  options: MailboxOptions = {},
): Layer.Layer<
  Mailbox,
  never,
  Store | Providers | Secrets | AppConfig | MailCodec | PdfWorker | AttachmentFiles | ImageNetwork
> =>
  Layer.effect(
    Mailbox,
    Effect.gen(function* () {
      const crypto = yield* PlatformCrypto;
      const newDraftId = () => `draft:${crypto.randomUUID()}`;
      const codec = yield* MailCodec;
      const files = yield* AttachmentFiles;
      const network = yield* ImageNetwork;
      const unsubscribeNetwork = yield* UnsubscribeNetwork;
      const verifier = yield* AppVerifier;
      const parseRawDraft = (...args: Parameters<typeof unboundParseRawDraft>) =>
        unboundParseRawDraft(...args).pipe(Effect.provideService(MailCodec, codec));
      const inlineImagesFromRaw = (...args: Parameters<typeof unboundInlineImagesFromRaw>) =>
        unboundInlineImagesFromRaw(...args).pipe(Effect.provideService(MailCodec, codec));
      const inlineMediaFromRaw = (...args: Parameters<typeof unboundInlineMediaFromRaw>) =>
        unboundInlineMediaFromRaw(...args).pipe(Effect.provideService(MailCodec, codec));
      const store = yield* Store;
      for (const account of yield* store.listAccounts) yield* store.grantedScopes(account.id);
      const backgroundReady = options.backgroundReady ?? Effect.void;
      const readOnly =
        (yield* Config.String("OPENMAIL_READ_ONLY").pipe(Config.withDefault("0"), Effect.orDie)) ===
        "1";
      const rawProviders = yield* Providers;
      const adapters = new Map<Provider, import("./services.js").ProviderAdapter>();
      const providers = Providers.of({
        get: (provider) => {
          const cached = adapters.get(provider);
          if (cached) return cached;
          const scoped = scopedAdapter(rawProviders.get(provider), store);
          const adapter = readOnly ? readOnlyAdapter(scoped) : scoped;
          adapters.set(provider, adapter);
          return adapter;
        },
      });
      const secrets = yield* Secrets;
      const config = yield* AppConfig;
      const model = Option.getOrElse(yield* Effect.serviceOption(Model), () => ModelUnavailable);
      const diskAttachments = options.attachmentCacheDirectory
        ? files.open(options.attachmentCacheDirectory)
        : undefined;
      const attachmentCache = new AttachmentCache();
      let idle: ImapIdle | undefined;
      let syncPaused = false;
      let attachmentEpoch = 0;

      const pubsub = yield* PubSub.unbounded<MailboxEvent>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      const emit = (event: MailboxEvent) => PubSub.publish(pubsub, event);
      const changed = emit({ _tag: "Changed" });

      const state = yield* Ref.make<SyncState>({
        running: false,
        lastFinishedAt: null,
        errors: [],
      });
      const inflight = yield* Ref.make(Option.none<Deferred.Deferred<SyncResult[]>>());

      const syncLock = yield* Semaphore.make(1);
      const polling = new Map<string, { failures: number; due: number }>();
      const cache = makeCacheMailbox(
        store,
        providers,
        syncLock,
        () => Ref.get(inflight).pipe(Effect.map(Option.isSome)),
        changed,
        emit({ _tag: "BackfillProgress" }),
      );

      // Pushing the queue

      /** Background work (queue flushes after a draft save) that dies with the layer. */
      const background = yield* FiberSet.make();
      yield* Effect.gen(function* () {
        // Let desktop construct/show its first window before taking the SQLite
        // write lock for optional, resumable search backfill.
        yield* backgroundReady;
        let indexed = false;
        let ready = false;
        while (!ready) {
          const batch = yield* store.backfillWordIndex().pipe(
            Effect.result,
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.succeed({ _tag: "Failure" } as const),
            ),
          );
          if (batch._tag === "Success" && batch.success.processed) indexed = true;
          ready = batch._tag === "Success" && batch.success.ready;
          if (!ready) yield* Effect.sleep(batch._tag === "Success" ? "20 millis" : "5 seconds");
        }
        if (indexed) yield* changed;
      }).pipe(Effect.forkScoped);

      /** One flush at a time in this process; claims keep other processes off the same op. */
      const flushLock = yield* Semaphore.make(1);
      const imapPullLocks = new Map<string, Semaphore.Semaphore>();
      const imapPullLock = (accountId: string) => {
        let lock = imapPullLocks.get(accountId);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          imapPullLocks.set(accountId, lock);
        }
        return lock;
      };

      /**
       * A message ready for the provider: Markdown rendered, and for a forward
       * as attachment the original fetched as an .eml and the message turned
       * into a new one. `original` is what replies and forwards thread on.
       */
      const prepare = Effect.fnUntraced(function* (message: OutgoingMessage) {
        const normalized = normalizeComposeMessage(message);
        const prepared: OutgoingMessage = normalized.markdown
          ? { ...normalized, html: renderMarkdown(normalized.text) }
          : normalized;
        // Source stays in local metadata; transport uses its own wider safe allow-list.
        const out: OutgoingMessage =
          prepared.originalHtml === undefined
            ? prepared
            : { ...prepared, html: preservedComposeHtml(prepared.originalHtml) };
        if (!message.inReplyTo) return { message: out, original: Option.none() };
        const ref = yield* store.messageRef(message.inReplyTo);
        const source = yield* store.getMessage(message.inReplyTo);
        if (!message.forwardAsAttachment) {
          return {
            message: out,
            original: Option.some({ providerId: ref.providerId, threadId: source.threadId }),
          };
        }
        // The original lives on the account that received it.
        const owner = yield* store.getAccount(ref.accountId);
        const raw = yield* providers.get(owner.provider).fetchRaw(owner, ref.providerId);
        const forwarded: OutgoingMessage = {
          to: out.to,
          cc: out.cc,
          bcc: out.bcc,
          subject: out.subject,
          text: out.text,
          ...(out.html === undefined ? {} : { html: out.html }),
          ...(out.markdown ? { markdown: true } : {}),
          attachments: [...out.attachments, originalAttachment(source.subject, raw)],
          mode: "new",
          ...(out.from ? { from: out.from } : {}),
        };
        return { message: forwarded, original: Option.none() };
      });

      /** Pushes a draft's current content. A draft discarded meanwhile loses its new copy too. */
      const pushDraft = Effect.fnUntraced(function* (
        account: Account,
        draftId: string,
        claim?: { readonly id: number; readonly token: string },
        context?: ProviderPushContext,
      ) {
        const stored = yield* store.getDraft(draftId);
        // Discarded, or moved to another account (a newer op pushes it there).
        if (
          Option.isNone(stored) ||
          stored.value.accountId !== account.id ||
          stored.value.localOnly
        )
          return;
        const draft = stored.value;
        const adapter = providers.get(account.provider);
        const { message, original } = yield* prepare(draft.message).pipe(
          Effect.catchTag("NotFound", (e) =>
            Effect.fail(new PermanentError({ message: `The original ${e.what} is gone` })),
          ),
        );
        const key =
          attachmentsKey(message.attachments) +
          (message.includeOriginalAttachments === undefined
            ? ""
            : `|original:${message.includeOriginalAttachments}`);
        const organizationKey = draftOrganizationKey(message.draftOrganization);
        const organizationChanged =
          organizationKey !== null && organizationKey !== draft.pushedOrganization;
        const { draftOrganization, ...bodyMessage } = message;
        const remote = yield* adapter.saveDraft(
          account,
          {
            remote: draft.remote,
            message: organizationChanged && account.provider !== "gmail" ? message : bodyMessage,
            original,
            replaceAttachments: key !== draft.pushedAttachments,
          },
          context,
        );
        if (!(yield* store.setDraftRemote(draftId, remote, key, account.id, claim))) {
          if (claim && !(yield* store.ownsPendingOp(claim.id, claim.token))) {
            const latest = yield* store.getDraft(draftId);
            if (
              remote.messageId ===
              (Option.isSome(latest) ? latest.value.remote?.messageId : undefined)
            )
              return;
            if (remote.messageId === draft.remote?.messageId) return;
          }
          yield* adapter
            .deleteDraft(account, remote)
            .pipe(
              Effect.catch(() =>
                store.enqueueOp(account.id, draftId, { kind: "deleteDraft", remote }),
              ),
            );
          return;
        }
        const cleanupIds = new Set([
          ...(remote.cleanupMessageIds ?? []),
          ...(remote.cleanupMessageId ? [remote.cleanupMessageId] : []),
        ]);
        for (const messageId of cleanupIds)
          yield* store.enqueueOp(account.id, draftId, {
            kind: "deleteDraft",
            remote: { draftId: messageId, messageId },
          });
        if (remote.conflict) {
          yield* store.setDraftSyncError(
            draftId,
            "The remote draft changed in another client. Both versions were kept.",
          );
          yield* store.audit({
            actor: { kind: "user", surface: "app" },
            accountId: account.id,
            action: "draft-conflict",
            detail: { draftId, previous: draft.remote, remote },
          });
        }
        const old = remote.conflict ? null : draft.remote?.messageId;
        if (old && old !== remote.messageId) yield* store.deleteMessage(account.id, old);
        let organizationApplied = organizationChanged;
        if (
          organizationChanged &&
          remote.messageId &&
          draftOrganization &&
          account.provider !== "gmail" &&
          adapter.setDraftOrganization
        ) {
          organizationApplied = yield* adapter
            .setDraftOrganization(account, remote.messageId, draftOrganization)
            .pipe(
              Effect.as(true),
              Effect.catchCause(() =>
                Effect.logWarning("Draft organization could not be applied; body saved").pipe(
                  Effect.as(false),
                ),
              ),
            );
        }
        // A label failure must not replay a successful MIME save through the op queue.
        // Record the attempted intent as well: a new UI change gets a new key.
        if (organizationChanged) yield* store.setDraftOrganizationKey(draftId, organizationKey);
        if (old !== remote.messageId || organizationApplied) yield* changed;
      });

      const refreshMessage = (account: Account, providerId: string) =>
        providers
          .get(account.provider)
          .fetchMessage(account, providerId)
          .pipe(
            Effect.flatMap((message) =>
              Effect.gen(function* () {
                const pending = (yield* store.pendingOpsForMessages(account.id, [
                  providerId,
                ])).flatMap((item) =>
                  item.op.kind === "saveDraft" ||
                  item.op.kind === "deleteDraft" ||
                  item.op.kind === "reconcile"
                    ? []
                    : [item.op],
                );
                yield* store.upsertMessage(
                  account.id,
                  withPendingOps(message, pending, account.provider),
                );
              }),
            ),
            Effect.catchTag("PermanentError", () => store.deleteMessage(account.id, providerId)),
          );
      const imapPushCursor = (account: Account): Effect.Effect<string | undefined> =>
        account.provider === "imap"
          ? Effect.gen(function* () {
              const full = readCursor(yield* store.getSyncCursor(account.id));
              const inbox = readCursor(yield* store.getInboxCursor(account.id));
              return JSON.stringify({ folders: { ...full.folders, ...inbox.folders } });
            })
          : Effect.succeed(undefined);
      const pushContext = (items: readonly PendingOp[], token: string): ProviderPushContext => ({
        messageIds: new Map(
          items.flatMap((item) =>
            item.rfcMessageId ? [[item.providerId, item.rfcMessageId]] : [],
          ),
        ),
        progress: new Set(items.flatMap((item) => item.progress)),
        ...(items[0]?.appendedMessageId
          ? { appendedDraftMessageId: items[0].appendedMessageId }
          : {}),
        beforeCopy: (destination, ids) =>
          store.transaction(
            Effect.forEach(
              items.filter((item) => ids.includes(item.providerId)),
              (item) =>
                store.recordCopyProgress(item.id, token, destination, item.providerId, "issued"),
              { discard: true },
            ),
          ),
        afterCopy: (destination, ids) =>
          store.transaction(
            Effect.forEach(
              items.filter((item) => ids.includes(item.providerId)),
              (item) =>
                store.recordCopyProgress(item.id, token, destination, item.providerId, "accepted"),
              { discard: true },
            ),
          ),
        clearCopy: (destination, ids) =>
          store.transaction(
            Effect.forEach(
              items.filter((item) => ids.includes(item.providerId)),
              (item) =>
                store.recordCopyProgress(item.id, token, destination, item.providerId, "clear"),
              { discard: true },
            ),
          ),
        beforeAppendDraft: (messageId) =>
          Effect.forEach(
            items,
            (item) => store.recordAppendedMessageId(item.id, token, messageId),
            { discard: true },
          ),
      });
      const pushOp = (account: Account, pending: PendingOp, token: string) => {
        const { op } = pending;
        const context = pushContext([pending], token);
        switch (op.kind) {
          case "saveDraft":
            return pushDraft(account, op.draftId, { id: pending.id, token }, context);
          case "deleteDraft":
            return providers.get(account.provider).deleteDraft(account, op.remote);
          case "reconcile":
            return refreshMessage(account, pending.providerId);
          default:
            return imapPushCursor(account).pipe(
              Effect.flatMap((cursor) =>
                providers
                  .get(account.provider)
                  .push(account, pending.providerId, op, cursor, context),
              ),
            );
        }
      };

      const reconcileDropped = Effect.fnUntraced(function* (
        account: Account,
        item: PendingOp,
        error: string,
      ) {
        if (
          item.op.kind === "saveDraft" ||
          item.op.kind === "deleteDraft" ||
          item.op.kind === "reconcile"
        )
          return;
        yield* refreshMessage(account, item.providerId).pipe(
          Effect.catch(() => store.enqueueOp(account.id, item.providerId, { kind: "reconcile" })),
        );
        yield* store.audit({
          actor: { kind: "user", surface: "app" },
          accountId: account.id,
          action: "sync-failed",
          detail: { providerId: item.providerId, op: item.op, error },
        });
      });
      const flush = Effect.fn("Mailbox.flush")(
        function* (accountIds?: readonly string[], skipImap = false) {
          const result = { done: 0, failed: 0, reauth: new Array<string>() };
          const blocked = new Set<string>();
          const queued = yield* store.listPendingOps;
          if (readOnly) {
            for (const item of queued)
              if (item.op.kind === "saveDraft")
                yield* store.setDraftSyncError(item.op.draftId, READ_ONLY_MESSAGE);
            return { ...result, failed: queued.length };
          }
          const refreshQueued = store.listPendingOps.pipe(
            Effect.tap((updated) =>
              Effect.sync(() => {
                const byId = new Map(updated.map((item) => [item.id, item]));
                for (let i = 0; i < queued.length; i++) {
                  const next = byId.get(queued[i]!.id);
                  if (next) queued[i] = next;
                }
              }),
            ),
            Effect.asVoid,
          );
          const claimToken = crypto.randomUUID();
          const activeClaims = new Set<number>();
          const settle = (
            account: Account,
            items: readonly PendingOp[],
            push: Effect.Effect<ProviderPushResult, import("./errors.js").ProviderFailure>,
          ): Effect.Effect<void> =>
            push.pipe(
              Effect.result,
              Effect.flatMap((outcome) => {
                const reconciliations: Array<{ item: PendingOp; error: string }> = [];
                return store
                  .transaction(
                    Effect.gen(function* () {
                      const owned: PendingOp[] = [];
                      for (const item of items)
                        if (yield* store.ownsPendingOp(item.id, claimToken)) owned.push(item);
                      if (owned.length !== items.length) return;
                      if (outcome._tag === "Success") {
                        const needsReconcile =
                          outcome.success !== undefined && "reconcile" in outcome.success;
                        if (outcome.success && !needsReconcile) {
                          yield* store.remapProviderIds(account.id, outcome.success);
                          yield* refreshQueued;
                        }
                        for (const item of owned) {
                          yield* store.removePendingOp(item.id, claimToken);
                          if (needsReconcile) {
                            blocked.add(`${item.accountId}/${item.providerId}`);
                            yield* store.enqueueOp(item.accountId, item.providerId, {
                              kind: "reconcile",
                            });
                          }
                        }
                        result.done += owned.length;
                        return;
                      }
                      const error = outcome.failure;
                      if (error._tag === "AuthError") {
                        yield* store.setNeedsReauth(account.id, true);
                        result.reauth.push(account.id);
                      }
                      for (const item of owned) {
                        if (item.op.kind === "saveDraft")
                          yield* store.setDraftSyncError(item.op.draftId, error.message);
                        if (error._tag === "AuthError") {
                          yield* store.releasePendingOp(item.id, claimToken);
                          continue;
                        }
                        blocked.add(`${item.accountId}/${item.providerId}`);
                        const expired =
                          item.op.kind !== "reconcile" &&
                          (yield* Clock.currentTimeMillis) - item.createdAt >= MAX_OP_AGE;
                        if (error._tag === "PermanentError" || expired) {
                          yield* store.removePendingOp(item.id, claimToken);
                          if (item.op.kind !== "reconcile")
                            yield* store.recordFailedOp({
                              accountId: account.id,
                              providerId: item.providerId,
                              kind: item.op.kind,
                              reason: error.message,
                            });
                          if (error._tag === "PermanentError" && error.imapReset) {
                            yield* store.invalidateImapFolder(account.id, error.imapReset);
                            yield* refreshQueued;
                          } else reconciliations.push({ item, error: error.message });
                        } else yield* store.failPendingOp(item.id, error.message, claimToken);
                        if (item.op.kind !== "reconcile") result.failed++;
                      }
                    }),
                  )
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        for (const item of items) activeClaims.delete(item.id);
                      }),
                    ),
                    Effect.andThen(() =>
                      Effect.forEach(
                        reconciliations,
                        ({ item, error }) => reconcileDropped(account, item, error),
                        { discard: true },
                      ),
                    ),
                  );
              }),
              Effect.catchTag("ProviderError", (error) =>
                settle(account, items, Effect.fail(error)),
              ),
            );
          for (let index = 0; index < queued.length; index++) {
            const pending = queued[index];
            if (!pending || (accountIds && !accountIds.includes(pending.accountId))) continue;
            if (options.localDraftQueue && pending.op.kind === "saveDraft") continue;
            const key = `${pending.accountId}/${pending.providerId}`;
            if (blocked.has(key) || result.reauth.includes(pending.accountId)) continue;
            if (pending.retryAt > (yield* Clock.currentTimeMillis)) {
              blocked.add(key);
              continue;
            }
            const account = yield* store.getAccount(pending.accountId).pipe(Effect.option);
            if (Option.isNone(account)) {
              yield* store.removePendingOp(pending.id);
              continue;
            }
            if (account.value.enabled === false || (skipImap && account.value.provider === "imap"))
              continue;
            if (account.value.needsReauth) {
              result.reauth.push(account.value.id);
              continue;
            }
            const owner = account.value;
            const leasedIds: number[] = [];
            const heartbeat = Effect.gen(function* () {
              for (;;) {
                yield* Effect.sleep("30 seconds");
                for (const id of leasedIds)
                  if (activeClaims.has(id) && !(yield* store.renewPendingOp(id, claimToken)))
                    return yield* new PendingOpClaimLost({
                      message: "The queued operation is no longer owned by this worker",
                    });
              }
            });
            const pushOne = Effect.gen(function* () {
              if (!(yield* store.claimPendingOp(pending.id, claimToken))) {
                blocked.add(key);
                return;
              }
              leasedIds.push(pending.id);
              activeClaims.add(pending.id);
              const adapter = providers.get(owner.provider);
              const op = pending.op;
              const batch: PendingOp[] = [pending];
              if (
                adapter.pushBatch &&
                op.kind !== "saveDraft" &&
                op.kind !== "deleteDraft" &&
                op.kind !== "reconcile" &&
                op.kind !== "trash" &&
                op.kind !== "inbox"
              ) {
                const signature = JSON.stringify(op);
                for (const next of queued.slice(index + 1, index + 1000)) {
                  if (
                    next.accountId !== pending.accountId ||
                    JSON.stringify(next.op) !== signature ||
                    (owner.provider === "imap" &&
                      !Option.getOrElse(
                        Option.zipWith(
                          decodeProviderId(pending.providerId),
                          decodeProviderId(next.providerId),
                          (first, other) =>
                            first.path === other.path && first.uidValidity === other.uidValidity,
                        ),
                        () => false,
                      )) ||
                    next.retryAt > (yield* Clock.currentTimeMillis) ||
                    blocked.has(`${next.accountId}/${next.providerId}`)
                  )
                    break;
                  if (!(yield* store.claimPendingOp(next.id, claimToken))) {
                    blocked.add(`${next.accountId}/${next.providerId}`);
                    break;
                  }
                  leasedIds.push(next.id);
                  activeClaims.add(next.id);
                  batch.push(next);
                }
                index += batch.length - 1;
                if (batch.length > 1) {
                  // A stale provider ID must not cause other messages to be dropped.
                  const pushBatch = adapter.pushBatch;
                  const bulk = imapPushCursor(owner)
                    .pipe(
                      Effect.flatMap((cursor) =>
                        pushBatch(
                          owner,
                          batch.map((item) => item.providerId),
                          op,
                          cursor,
                          pushContext(batch, claimToken),
                        ),
                      ),
                    )
                    .pipe(
                      Effect.catchTag("PermanentError", () =>
                        Effect.gen(function* () {
                          for (const item of batch) {
                            if (
                              result.reauth.includes(item.accountId) ||
                              blocked.has(`${item.accountId}/${item.providerId}`)
                            ) {
                              yield* store.releasePendingOp(item.id, claimToken);
                              activeClaims.delete(item.id);
                              continue;
                            }
                            yield* settle(owner, [item], pushOp(owner, item, claimToken));
                          }
                        }).pipe(Effect.as("fallback" as const)),
                      ),
                    );
                  const sent = yield* bulk.pipe(Effect.result);
                  if (sent._tag === "Failure")
                    yield* settle(owner, batch, Effect.fail(sent.failure));
                  else {
                    if (sent.success === "fallback") return;
                    yield* settle(owner, batch, Effect.succeed(sent.success));
                  }
                  return;
                }
              }
              yield* settle(owner, [pending], pushOp(owner, pending, claimToken));
            }).pipe(
              Effect.raceFirst(heartbeat),
              Effect.catchTag("PendingOpClaimLost", (error) =>
                Effect.gen(function* () {
                  for (const id of leasedIds) {
                    const item = queued.find((candidate) => candidate.id === id);
                    if (item) blocked.add(`${item.accountId}/${item.providerId}`);
                    if (yield* store.ownsPendingOp(id, claimToken))
                      yield* store.failPendingOp(id, error.message, claimToken);
                  }
                  result.failed += leasedIds.length;
                }),
              ),
              Effect.ensuring(
                Effect.forEach(
                  leasedIds,
                  (id) =>
                    store
                      .releasePendingOp(id, claimToken)
                      .pipe(Effect.tap(() => Effect.sync(() => activeClaims.delete(id)))),
                  {
                    discard: true,
                  },
                ),
              ),
            );
            yield* owner.provider === "imap"
              ? imapPullLock(owner.id).withPermitsIfAvailable(1)(pushOne)
              : pushOne;
          }
          return result;
        },
        (effect, _accountIds?: readonly string[], _skipImap?: boolean) =>
          flushLock.withPermits(1)(effect),
      );

      /** Flushes without making the caller wait for the network. */
      const flushNow = flush().pipe(
        Effect.flatMap((result) =>
          result.reauth.length || result.failed || result.done ? changed : Effect.void,
        ),
        Effect.catchCause((cause) => Effect.logWarning("flush failed", cause)),
      );
      const flushLater = options.localDraftQueue
        ? Effect.void
        : options.backgroundFlush === false
          ? flushNow
          : FiberSet.run(background, flushNow).pipe(Effect.asVoid);

      const folderMailbox = makeFolderMailbox(store, providers, changed, (effect) =>
        flushNow.pipe(
          Effect.andThen(effect.pipe(flushLock.withPermits(1), syncLock.withPermits(1))),
        ),
      );
      const batchMailbox = yield* makeBatchMailbox(
        store,
        changed,
        FiberSet.run(background, flushNow).pipe(Effect.asVoid),
        (id) =>
          Effect.gen(function* () {
            const ref = yield* store.messageRef(id);
            const account = yield* store.getAccount(ref.accountId);
            if (account.enabled === false)
              return yield* new InvalidInput({
                message: "Enable the account before undoing this operation.",
              });
            return yield* providers.get(account.provider).fetchMessage(account, ref.providerId);
          }),
        (accountId, labelId) =>
          Effect.gen(function* () {
            const account = yield* store.getAccount(accountId);
            yield* providers.get(account.provider).listFolderMessages(
              account,
              {
                mailbox: "all",
                label:
                  account.provider === "outlook"
                    ? (outlookDestination({ kind: "move", labelId, removeLabelId: null }) ??
                      labelId)
                    : labelId,
              },
              null,
            );
          }),
      );

      const organization = makeOrganizationMailbox(
        store,
        providers,
        changed,
        flushLater,
        batchMailbox.modifyWithUndo,
        crypto,
        (ids, wokenAt) =>
          Effect.gen(function* () {
            const groups = new Map<string, string[]>();
            for (const id of ids) {
              const ref = yield* store.messageRef(id).pipe(Effect.option);
              if (Option.isNone(ref)) continue;
              const group = groups.get(ref.value.accountId) ?? [];
              group.push(id);
              groups.set(ref.value.accountId, group);
            }
            for (const [accountId, due] of groups)
              yield* emit({
                _tag: "SnoozeDue",
                accountId,
                ids: due,
                wokenAt,
              });
          }),
      );

      // Running commands

      const modify = Effect.fn("Mailbox.modify")(function* (
        command: Extract<Command, { kind: "modify" }>,
        actor: Actor,
      ) {
        if (invalidCategoryFolderOp(command.op))
          return yield* new InvalidInput({
            message: "Categories cannot be used as folders. Use the categories action.",
          });
        const ids = new Set<string>();
        for (const thread of command.threads) {
          for (const id of yield* store.threadMessageIds(thread)) ids.add(id);
        }
        if (ids.size === 0) {
          return yield* new InvalidInput({ message: "No message matches the given thread ids." });
        }
        const accounts = new Map<string, Account>();
        for (const id of ids) {
          const { accountId, providerId } = yield* store.messageRef(id);
          let account = accounts.get(accountId);
          if (!account) {
            account = yield* store.getAccount(accountId);
            accounts.set(accountId, account);
          }
          // IMAP importance is read-only; removing an absent folder does nothing.
          const flag =
            command.op.kind === "read" ||
            command.op.kind === "star" ||
            (command.op.kind === "important" && account.provider === "outlook");
          if (account.provider !== "gmail" && !flag) {
            const labels = yield* store.messageLabels(accountId, providerId);
            if (!folderTarget(command.op, labels)) continue;
          }
          yield* store.transaction(
            Effect.all([
              store.applyLocalOp(id, command.op),
              store.enqueueOp(accountId, providerId, command.op),
              store.audit({
                actor,
                accountId,
                action: command.op.kind,
                detail: { id, op: command.op },
              }),
            ]),
          );
        }
        yield* changed;
        // Local state already changed; a failed push stays queued for the next sync.
        const result = yield* flush();
        if (result.reauth.length) yield* changed;
        return result;
      });

      /** Settles an agent's message proposal once the person sent or discarded its draft. */
      const settleProposal = Effect.fnUntraced(function* (proposalId: number, approve: boolean) {
        const proposal = yield* store.getProposal(proposalId).pipe(Effect.option);
        if (Option.isNone(proposal) || proposal.value.status !== "pending") return;
        yield* store.setProposalStatus(proposalId, approve ? "approved" : "rejected");
        yield* store.audit({
          actor: { kind: "user", surface: "app" },
          action: approve ? "approve" : "reject",
          detail: { proposalId, proposer: actorLabel(proposal.value.actor) },
        });
      });

      /** Deletes a draft here and queues deleting the provider's copy. */
      const removeDraft = Effect.fnUntraced(function* (draft: StoredDraft) {
        yield* store.deleteDraft(draft.id);
        const { remote } = draft;
        if (!remote) return;
        yield* store.enqueueOp(draft.accountId, remote.messageId ?? remote.draftId ?? draft.id, {
          kind: "deleteDraft",
          remote,
        });
        if (remote.messageId) yield* store.deleteMessage(draft.accountId, remote.messageId);
      });

      let pendingSends = 0;
      const send = Effect.fn("Mailbox.send")(function* (
        command: Extract<Command, { kind: "send" }>,
        actor: Actor,
      ) {
        if (readOnly) return yield* new InvalidInput({ message: READ_ONLY_MESSAGE });
        const { accountId, message } = command;
        if (command.draftId && (yield* store.sendUncertain(command.draftId))) {
          if (!command.confirmResend || actor.kind !== "user" || actor.surface !== "app")
            return yield* new SendUncertain({
              message: "This message may have been sent. Check Sent before sending it again.",
            });
          yield* store.setSendUncertain(command.draftId, false);
        }
        if (message.to.length + message.cc.length + message.bcc.length === 0) {
          yield* new InvalidInput({ message: "A message needs at least one recipient." });
        }
        const account = yield* store.getAccount(accountId);
        if (message.from && message.from.address.toLowerCase() !== account.email.toLowerCase()) {
          const aliases = yield* store.sendAs;
          if (
            account.provider !== "gmail" ||
            !aliases.some(
              (a) =>
                a.accountId === accountId &&
                a.address.toLowerCase() === message.from?.address.toLowerCase(),
            )
          )
            return yield* new InvalidInput({
              message: "Choose a verified send-as address for this account",
            });
        }
        if (account.enabled === false)
          return yield* new InvalidInput({ message: "Enable the account before sending" });
        if (account.needsReauth) {
          yield* new AuthError({ accountId, message: "Sign in again before sending." });
        }
        const prepared = yield* prepare(message);
        const problem = attachmentProblem(account.provider, prepared.message.attachments);
        if (problem) return yield* new InvalidInput({ message: attachmentProblemMessage(problem) });
        const detail = {
          to: message.to.map((a) => a.address),
          cc: message.cc.map((a) => a.address),
          bcc: message.bcc.map((a) => a.address),
          subject: message.subject,
          mode: message.mode ?? "new",
          attachments: prepared.message.attachments.length,
          ...(message.markdown ? { markdown: true } : {}),
          ...(message.forwardAsAttachment ? { forwardAsAttachment: true } : {}),
          ...(command.draftId ? { draftId: command.draftId } : {}),
        };
        const delivery = yield* providers
          .get(account.provider)
          .send(account, prepared.message, prepared.original)
          .pipe(
            Effect.tapError((error) =>
              Effect.all([
                error._tag === "AuthError" ? store.setNeedsReauth(accountId, true) : Effect.void,
                error._tag === "SendUncertain" && command.draftId
                  ? store.setSendUncertain(command.draftId, true)
                  : Effect.void,
                store.audit({
                  actor,
                  accountId,
                  action: "send_failed",
                  detail: { ...detail, error: error.message },
                }),
              ]),
            ),
          );
        if (delivery?.rejected?.length) {
          yield* store.recordFailedOp({
            accountId,
            providerId: command.draftId ?? "",
            kind: "sendPartial",
            reason: delivery.rejected.join(", "),
            subject: message.subject,
            sender: message.from?.address ?? account.email,
            rejected: delivery.rejected,
          });
          if (command.draftId) yield* store.setSendUncertain(command.draftId, true);
        }
        if (delivery?.sentCopyMissing)
          yield* store.recordFailedOp({
            accountId,
            providerId: command.draftId ?? "",
            kind: "sentCopyMissing",
            reason: "SMTP accepted the message, but saving its Sent copy failed.",
            subject: message.subject,
            sender: message.from?.address ?? account.email,
          });
        yield* store.audit({ actor, accountId, action: "send", detail });
        yield* store.rememberMailedAddresses(
          accountId,
          [...message.to, ...message.cc, ...message.bcc].map((recipient) => recipient.address),
        );

        // The mail is out. What follows only tidies up and must not fail the send.
        const draft = command.draftId
          ? yield* store.getDraft(command.draftId)
          : Option.none<StoredDraft>();
        if (Option.isSome(draft) && !delivery?.rejected?.length) {
          yield* store.transaction(removeDraft(draft.value));
          if (draft.value.proposalId !== null) yield* settleProposal(draft.value.proposalId, true);
        }
        let flushed: FlushResult | undefined;
        if (command.archive && message.inReplyTo) {
          flushed = yield* modify(
            { kind: "modify", threads: [message.inReplyTo], op: { kind: "archive" } },
            actor,
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`Sent, but archiving failed: ${error.message}`).pipe(
                Effect.as(undefined),
              ),
            ),
          );
        } else if (Option.isSome(draft)) {
          yield* flushLater;
        }
        yield* changed;
        return flushed;
      });

      const run = Effect.fn("Mailbox.run")(function* (command: Command, actor: Actor) {
        switch (command.kind) {
          case "modify":
            return { status: "applied", flush: yield* modify(command, actor) } satisfies Outcome;
          case "snooze":
            yield* organization.snooze(command.threads, command.due);
            return { status: "applied" } satisfies Outcome;
          case "send": {
            const flushed = yield* Effect.sync(() => {
              pendingSends++;
            }).pipe(
              Effect.andThen(send(command, actor)),
              Effect.ensuring(
                Effect.sync(() => {
                  pendingSends--;
                }),
              ),
            );
            return (
              flushed ? { status: "applied", flush: flushed } : { status: "applied" }
            ) satisfies Outcome;
          }
          case "removeAccount":
            yield* store.getAccount(command.accountId);
            for (const item of yield* store.queuedSends)
              if (item.accountId === command.accountId) yield* store.deleteQueuedSend(item.id);
            attachmentEpoch++;
            idle?.remove(command.accountId);
            if (diskAttachments)
              yield* cacheIO(() => diskAttachments.clear(command.accountId), undefined);
            attachmentCache.clear();
            const removedAccount = yield* store.getAccount(command.accountId);
            yield* (
              providers.get(removedAccount.provider).closeSessions?.(command.accountId) ??
                Effect.void
            );
            yield* store.removeAccount(command.accountId);
            yield* secrets.remove(command.accountId);
            yield* store.audit({
              actor,
              accountId: command.accountId,
              action: "removeAccount",
              detail: {},
            });
            yield* changed;
            return { status: "applied" } satisfies Outcome;
          default:
            // Drafts: policy never lets one get this far.
            return yield* new InvalidInput({ message: "Drafts are never performed." });
        }
      });

      const validateMcpProposal = Effect.fnUntraced(function* (command: Command) {
        if (command.kind === "modify" && command.op.kind === "label") {
          const labelId = command.op.labelId;
          for (const thread of command.threads) {
            const messages = yield* store.getThread(thread);
            const accountId = messages[0]?.accountId;
            if (!accountId)
              return yield* new InvalidInput({ message: "No account for the conversation." });
            const account = yield* store.getAccount(accountId);
            const label = (yield* store.listLabels([accountId])).find((l) => l.id === labelId);
            if (
              account.provider !== "gmail" ||
              !label ||
              isSpecialAgentLabel(label.id) ||
              isSpecialAgentLabel(label.name)
            )
              return yield* new InvalidInput({
                message: "MCP can only propose existing Gmail user labels for the same account.",
              });
          }
        }
        if (command.kind === "draft") {
          const draft = command.message;
          const composeMode = draft.mode ?? (draft.inReplyTo ? "reply" : "new");
          if (
            composeMode === "forward" ||
            draft.attachments.length ||
            draft.html ||
            (composeMode === "new") === Boolean(draft.inReplyTo)
          )
            return yield* new InvalidInput({
              message: "MCP drafts support plain-text new messages and replies only.",
            });
          if (
            draft.inReplyTo &&
            (yield* store.getMessage(draft.inReplyTo)).accountId !== command.accountId
          )
            return yield* new InvalidInput({
              message: "Reply message belongs to another account.",
            });
        }
        if (command.kind === "snooze" && command.due <= (yield* Clock.currentTimeMillis))
          return yield* new InvalidInput({ message: "Choose a future reminder time." });
        return yield* Effect.void;
      });

      const perform = Effect.fn("Mailbox.perform")(function* (command: Command, actor: Actor) {
        const mode = actor.kind === "agent" ? yield* store.agentWriteMode(actor.name) : "off";
        // Refuse unknown threads before anything is proposed or audited.
        if (command.kind === "snooze") {
          const now = yield* Clock.currentTimeMillis;
          if (
            !Number.isFinite(command.due) ||
            command.due <= now ||
            command.due > now + 365 * 86_400_000
          )
            return yield* new InvalidInput({
              message: "Reminder time must be within the next year.",
            });
        }
        if (command.kind === "modify" || command.kind === "snooze") {
          if (
            actor.kind === "agent" &&
            actor.surface === "mcp" &&
            (command.threads.length === 0 || command.threads.length > 20)
          )
            return yield* new InvalidInput({ message: "Proposals need 1 to 20 conversations." });
          for (const thread of command.threads) {
            if ((yield* store.threadMessageIds(thread)).length === 0) {
              return yield* new InvalidInput({ message: `No thread with id ${thread}.` });
            }
          }
        }
        if (actor.kind === "agent" && actor.surface === "mcp") yield* validateMcpProposal(command);
        const decision = decide(command, actor, mode);
        if (decision.status === "denied") {
          yield* store.audit({
            actor,
            action: "denied",
            detail: { command, reason: decision.reason },
          });
          return decision satisfies Outcome;
        }
        if (decision.status === "proposed") {
          // An agent's message becomes a real draft that syncs like any other
          // and waits in the Drafts list for the person to send or discard.
          const message =
            command.kind === "send" || command.kind === "draft"
              ? Option.some({ accountId: command.accountId, message: command.message })
              : Option.none();
          if (Option.isSome(message)) yield* store.getAccount(message.value.accountId);
          const proposalId = yield* store.transaction(
            Effect.gen(function* () {
              const id = yield* store.insertProposal(actor, command);
              if (Option.isSome(message)) {
                const draft = yield* store.putDraft({
                  id: newDraftId(),
                  ...message.value,
                  proposalId: id,
                });
                // Read-only agents change nothing on the server: the draft
                // stays local until the person saves it from the composer.
                // Otherwise the app's next flush pushes it, not the agent's process.
                const push =
                  actor.kind === "agent" &&
                  actor.surface !== "mcp" &&
                  !(actor.surface === "rule" && actor.name === "openmail-assistant") &&
                  (yield* store.agentWriteMode(actor.name)) !== "off";
                if (push) yield* store.enqueueDraftSave(draft.accountId, draft.id);
              }
              yield* store.audit({
                actor,
                action: "proposed",
                detail: { proposalId: id, command },
              });
              return id;
            }),
          );
          yield* changed;
          return { status: "proposed", proposalId } satisfies Outcome;
        }
        return yield* run(command, actor);
      });

      const decideProposal = Effect.fn("Mailbox.decideProposal")(function* (
        id: number,
        approve: boolean,
        surface: "app" | "cli",
      ) {
        const proposal = yield* store.getProposal(id);
        if (
          approve &&
          surface !== "app" &&
          proposal.actor.kind === "agent" &&
          (proposal.actor.surface === "mcp" ||
            (proposal.actor.surface === "rule" && proposal.actor.name === "openmail-assistant"))
        )
          return yield* new InvalidInput({ message: "Approve agent suggestions in the app." });
        if (proposal.status !== "pending") {
          return yield* new InvalidInput({
            message: `Proposal ${id} is already ${proposal.status}.`,
          });
        }
        if (approve && proposal.actor.kind === "agent" && proposal.actor.surface === "mcp")
          yield* validateMcpProposal(proposal.command);
        const person: Actor = { kind: "user", surface };
        yield* store.setProposalStatus(id, approve ? "approved" : "rejected");
        yield* store.audit({
          actor: person,
          action: approve ? "approve" : "reject",
          detail: { proposalId: id, proposer: actorLabel(proposal.actor) },
        });
        // Messages an agent proposed are sent from the compose window, as a
        // draft; sending approves the proposal. Rejecting one discards its draft.
        if (proposal.command.kind !== "modify" && proposal.command.kind !== "snooze") {
          const draft = yield* store.draftByProposal(id);
          if (!approve && Option.isSome(draft)) {
            yield* store.transaction(removeDraft(draft.value));
            yield* flushLater;
          }
          yield* changed;
          return { status: "applied" } satisfies Outcome;
        }
        yield* changed;
        if (!approve) return { status: "applied" } satisfies Outcome;
        return yield* run(proposal.command, person);
      });

      // Drafts

      const publicDraft = Effect.fnUntraced(function* (draft: StoredDraft) {
        const saveStatus = yield* store.draftSaveState(draft.id);
        return { ...toDraft(draft, saveStatus.pending), syncRetrying: saveStatus.retrying };
      });

      const draftStatus = (id: string) =>
        Effect.gen(function* () {
          const draft = yield* store.getDraft(id);
          return Option.isSome(draft) ? yield* publicDraft(draft.value) : null;
        });

      const persistDraft = Effect.fnUntraced(function* (input: DraftInput, enqueue: boolean) {
        const account = yield* store.getAccount(input.accountId);
        const draftOrganizationInput = input.message.draftOrganization;
        if (
          draftOrganizationInput?.labels.some(
            (label) =>
              !label.trim() ||
              label.includes("\r") ||
              label.includes("\n") ||
              label.includes("\0") ||
              (account.provider === "gmail" && !label.startsWith("Label_")) ||
              (account.provider === "imap" && !/^[a-zA-Z0-9_$.-]+$/.test(label)),
          )
        )
          return yield* new InvalidInput({ message: "Invalid draft label or keyword" });
        const saved = yield* store.transaction(
          Effect.gen(function* () {
            const existing = yield* store.getDraft(input.id);
            const localOnly = Option.isSome(existing) && existing.value.localOnly;
            if (Option.isSome(existing)) {
              const old = existing.value;
              // Detach a local copy from its old mirror; synced drafts remove that mirror.
              if (old.accountId !== input.accountId && old.remote) {
                yield* localOnly ? store.deleteDraft(old.id) : removeDraft(old);
              }
            } else {
              yield* store.audit({
                actor: { kind: "user", surface: "app" },
                accountId: input.accountId,
                action: "draft",
                detail: { draftId: input.id, subject: input.message.subject },
              });
            }
            const draft = yield* store.putDraft({
              id: input.id,
              accountId: input.accountId,
              message: normalizeComposeMessage(input.message),
            });
            const restoreLocalOnly = localOnly && !draft.localOnly;
            if (restoreLocalOnly) yield* store.setDraftLocalOnly(input.id, true);
            if (enqueue && !isLocalFeedbackDraft(input.id))
              yield* store.enqueueDraftSave(input.accountId, input.id);
            return restoreLocalOnly ? { ...draft, localOnly: true, syncError: null } : draft;
          }),
        );
        return saved;
      });
      const saveDraft = Effect.fn("Mailbox.saveDraft")(function* (input: DraftInput) {
        const saved = yield* persistDraft(input, true);
        yield* changed;
        yield* flushLater;
        return yield* publicDraft(Option.getOrElse(yield* store.getDraft(input.id), () => saved));
      });

      const recoverDraft = Effect.fn("Mailbox.recoverDraft")(function* (
        id: string,
        action: "retry" | "local",
        latest?: DraftInput,
      ) {
        if (latest && latest.id !== id)
          return yield* new InvalidInput({ message: "Recovery draft id does not match" });
        const draft = yield* store.transaction(
          Effect.gen(function* () {
            const stored = yield* store.getDraft(id);
            if (Option.isNone(stored)) return yield* new NotFound({ what: "draft", id });
            const saved = latest ? yield* persistDraft(latest, false) : stored.value;
            yield* store.setDraftLocalOnly(id, action === "local");
            if (action === "retry") yield* store.enqueueDraftSave(saved.accountId, id);
            return saved;
          }),
        );
        if (action === "retry") {
          const account = yield* store.getAccount(draft.accountId);
          if (account.needsReauth || account.enabled === false)
            yield* store.setDraftSyncError(
              id,
              draft.syncError ??
                (account.needsReauth
                  ? "Sign in again to sync this draft"
                  : "Enable the account to sync this draft"),
            );
          yield* flushLater;
        }
        yield* changed;
        return yield* publicDraft(Option.getOrElse(yield* store.getDraft(id), () => draft));
      });

      const discardDraft = Effect.fn("Mailbox.discardDraft")(function* (id: string) {
        const draft = yield* store.getDraft(id);
        if (Option.isNone(draft)) return;
        yield* store.transaction(
          Effect.gen(function* () {
            yield* removeDraft(draft.value);
            yield* store.audit({
              actor: { kind: "user", surface: "app" },
              accountId: draft.value.accountId,
              action: "discard_draft",
              detail: { draftId: id, subject: draft.value.message.subject },
            });
          }),
        );
        if (draft.value.proposalId !== null) yield* settleProposal(draft.value.proposalId, false);
        yield* flushLater;
        yield* changed;
      });

      /** A draft message from the Drafts list that openmail has no local draft for yet. */
      const importDraft = Effect.fnUntraced(function* (message: Message) {
        const { providerId } = yield* store.messageRef(message.id);
        const account = yield* store.getAccount(message.accountId);
        const fallback: ParsedDraft = {
          to: [...message.to],
          cc: [...message.cc],
          bcc: [],
          subject: message.subject,
          ...(message.bodyHtml ? remoteComposeBody(message.bodyHtml) : { text: message.bodyText }),
          attachments: [],
          isReply: false,
        };
        const adapter = providers.get(account.provider);
        const decoded = yield* adapter.fetchRaw(account, providerId).pipe(
          Effect.flatMap(parseRawDraft),
          Effect.map((parsed) => ({ parsed, fetched: true })),
          // Offline: without attachments the stored copy has everything.
          Effect.catch((error) =>
            message.attachments.length > 0
              ? Effect.fail(error)
              : Effect.succeed({ parsed: fallback, fetched: false }),
          ),
        );
        const markdownSource =
          decoded.fetched && adapter.draftMarkdownSource
            ? yield* adapter
                .draftMarkdownSource(account, providerId)
                .pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined;
        const parsed = withDraftMarkdownSource(decoded.parsed, markdownSource);
        const fetchedOrganization = adapter.getDraftOrganization
          ? yield* adapter
              .getDraftOrganization(account, providerId)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined;
        const draftOrganization =
          fetchedOrganization ??
          (account.provider === "gmail"
            ? {
                labels: message.labels.filter((label) => label.startsWith("Label_")),
                starred: message.isStarred,
              }
            : undefined);
        const thread = yield* store.getThread(message.id);
        return yield* store.transaction(
          Effect.gen(function* () {
            const draft = yield* store.putDraft({
              id: newDraftId(),
              accountId: account.id,
              message: {
                ...importedMessage(parsed, thread),
                ...(draftOrganization ? { draftOrganization } : {}),
              },
            });
            yield* store.setDraftRemote(
              draft.id,
              // Gmail's draft id is looked up by message id when first needed.
              { draftId: account.provider === "gmail" ? null : providerId, messageId: providerId },
              attachmentsKey(parsed.attachments),
            );
            yield* store.setDraftOrganizationKey(draft.id, draftOrganizationKey(draftOrganization));
            return yield* store.getDraft(draft.id).pipe(Effect.map(Option.getOrThrow));
          }),
        );
      });

      const openDraft = Effect.fn("Mailbox.openDraft")(function* (id: string) {
        const proposalRef = /^proposal:(\d+)$/.exec(id);
        if (proposalRef) {
          const proposalId = Number(proposalRef[1]);
          const linked = yield* store.draftByProposal(proposalId);
          if (Option.isSome(linked)) return yield* publicDraft(linked.value);
          // A proposal from before drafts were synced: it becomes one now.
          const proposal = yield* store.getProposal(proposalId);
          const { command } = proposal;
          if (command.kind !== "send" && command.kind !== "draft") {
            return yield* new InvalidInput({ message: `Proposal ${proposalId} is not a message.` });
          }
          const draft = yield* store.putDraft({
            id: newDraftId(),
            accountId: command.accountId,
            message: command.message,
            proposalId,
          });
          yield* store.enqueueDraftSave(draft.accountId, draft.id);
          return yield* publicDraft(draft);
        }
        const local = yield* store.getDraft(id);
        if (Option.isSome(local)) return yield* publicDraft(local.value);
        if (id.startsWith("draft:")) return yield* new NotFound({ what: "draft", id });
        const message = yield* store.getMessage(id);
        const { providerId } = yield* store.messageRef(id);
        const linked = yield* store.draftByRemoteMessage(message.accountId, providerId);
        if (Option.isSome(linked)) return yield* publicDraft(linked.value);
        if (!message.labels.includes("DRAFT")) {
          return yield* new InvalidInput({ message: "This message is not a draft." });
        }
        const imported = yield* publicDraft(yield* importDraft(message));
        yield* changed;
        return imported;
      });

      const composeAttachments = Effect.fn("Mailbox.composeAttachments")(function* (id: string) {
        const ref = yield* store.messageRef(id);
        const account = yield* store.getAccount(ref.accountId);
        const source = yield* store.getMessage(id);
        const problem = attachmentSizesProblem(account.provider, source.attachments);
        if (problem) return yield* new InvalidInput({ message: attachmentProblemMessage(problem) });
        if (source.attachments.reduce((total, file) => total + file.size, 0) > 30 * 1024 * 1024)
          return yield* new InvalidInput({
            message: "Original attachments exceed the 30 MB compose limit.",
          });
        const maxBytes =
          account.provider === "gmail"
            ? GMAIL_MIME_LIMIT
            : account.provider === "outlook"
              ? 4 * 1024 * 1024
              : 42 * 1024 * 1024;
        const parsed = yield* providers
          .get(account.provider)
          .fetchRaw(account, ref.providerId, maxBytes)
          .pipe(
            Effect.flatMap((raw) =>
              raw.byteLength > maxBytes
                ? Effect.fail(
                    new InvalidInput({
                      message: "Original message exceeds the compose size limit.",
                    }),
                  )
                : Effect.succeed(raw),
            ),
          )
          .pipe(Effect.flatMap(parseRawDraft));
        const actual = attachmentProblem(account.provider, parsed.attachments);
        if (actual) return yield* new InvalidInput({ message: attachmentProblemMessage(actual) });
        return parsed.attachments.map((attachment) => ({ ...attachment, sourceMessageId: id }));
      });

      const sendAgain = Effect.fn("Mailbox.sendAgain")(function* (id: string) {
        const message = yield* store.getMessage(id);
        if (!message.labels.includes("SENT"))
          return yield* new InvalidInput({ message: "Choose a sent message to send again." });
        const account = yield* store.getAccount(message.accountId);
        const { providerId } = yield* store.messageRef(id);
        const parsed = yield* providers
          .get(account.provider)
          .fetchRaw(account, providerId)
          .pipe(Effect.flatMap(parseRawDraft));
        return yield* saveDraft({
          id: newDraftId(),
          accountId: account.id,
          message: normalizeComposeMessage({
            from: message.from,
            to: parsed.to,
            cc: parsed.cc,
            bcc: parsed.bcc,
            subject: parsed.subject,
            text: parsed.text,
            ...(parsed.html === undefined ? {} : { html: parsed.html }),
            ...(parsed.originalHtml === undefined ? {} : { originalHtml: parsed.originalHtml }),
            ...(parsed.markdown ? { markdown: true } : {}),
            attachments: parsed.attachments,
            mode: "new",
          }),
        });
      });

      const features = makeFeatureMailbox(
        store,
        providers,
        changed,
        perform,
        options.imageDownloader ?? network.download,
        codec,
        crypto,
      );

      // Reading from the provider

      const source = Effect.fnUntraced(function* (id: string) {
        const ref = yield* store.messageRef(id);
        const account = yield* store.getAccount(ref.accountId);
        return { account, adapter: providers.get(account.provider), providerId: ref.providerId };
      });

      const rawMessageBytes = Effect.fn("Mailbox.rawMessageBytes")(function* (id: string) {
        const { account, adapter, providerId } = yield* source(id);
        return yield* adapter.fetchRaw(account, providerId);
      });
      const rawMessage = Effect.fn("Mailbox.rawMessage")(function* (id: string) {
        const raw = yield* rawMessageBytes(id);
        // Headers are ASCII; 8-bit bodies in other charsets show replacement characters.
        return new TextDecoder("utf-8").decode(raw);
      });

      const messageWebUrl = Effect.fn("Mailbox.messageWebUrl")(function* (id: string) {
        const cachedMessage = yield* store.getMessage(id).pipe(Effect.option);
        const linkedAccount = Option.isSome(cachedMessage)
          ? yield* store.getAccount(cachedMessage.value.accountId)
          : (yield* store.listAccounts)
              .filter((a) => id.startsWith(`${a.id}/`))
              .toSorted((a, b) => b.id.length - a.id.length)[0];
        if (!linkedAccount) return yield* new NotFound({ what: "account", id });
        const account = linkedAccount;
        if (account.enabled === false)
          return yield* new InvalidInput({
            message: "Enable this account to open mail on the web",
          });
        const adapter = providers.get(account.provider);
        const providerId = id.slice(account.id.length + 1);
        if (!providerId) return yield* new InvalidInput({ message: "Invalid message link" });
        if (account.provider === "imap")
          return yield* new InvalidInput({
            message: "This account has no supported web mail link.",
          });
        if (
          (account.provider !== "gmail" || Option.isNone(cachedMessage)) &&
          !validMessageProviderId(account.provider, providerId)
        )
          return yield* new InvalidInput({ message: "Invalid message link" });
        const message = Option.getOrNull(cachedMessage);
        if (account.provider === "gmail")
          return gmailThreadUrl(account.email, message?.threadId ?? providerId);
        const cached = message?.webLink && officialMessageUrl("outlook", message.webLink);
        if (cached) return cached;
        const fetched = yield* adapter.fetchMessage(account, providerId);
        const url = fetched.webLink && officialMessageUrl("outlook", fetched.webLink);
        if (!url)
          return yield* new InvalidInput({
            message: "The provider did not return an official Outlook web link.",
          });
        if (message) yield* store.setMessageWebLink(id, url);
        return url;
      });

      const attachment = Effect.fn("Mailbox.attachment")(function* (
        messageId: string,
        index: number,
      ) {
        const message = yield* store.getMessage(messageId);
        const listed = message.attachments[index];
        const ref = attachmentRef(message.attachments, index);
        if (!listed || !ref) {
          return yield* new NotFound({ what: "attachment", id: `${messageId}#${index}` });
        }
        const { account, adapter, providerId } = yield* source(messageId);
        const key = JSON.stringify([
          providerId,
          index,
          listed.filename,
          listed.mimeType,
          listed.size,
        ]);
        const epoch = attachmentEpoch;
        const diskVersion = diskAttachments?.version();
        const maxBytes = (yield* store.prefs).attachmentCacheBytes;
        const cached =
          (diskAttachments
            ? yield* cacheIO(
                () => diskAttachments.get(account.id, JSON.stringify([messageId, key]), maxBytes),
                null,
              )
            : null) ?? attachmentCache.get(messageId, key);
        if (cached) return { filename: listed.filename, mimeType: listed.mimeType, data: cached };
        const data = yield* adapter.fetchAttachment(account, providerId, ref);
        yield* store.getAccount(account.id);
        if (epoch === attachmentEpoch) {
          attachmentCache.set(messageId, key, data);
          if (diskAttachments)
            yield* cacheIO(
              () =>
                diskAttachments.set(
                  account.id,
                  JSON.stringify([messageId, key]),
                  data,
                  maxBytes,
                  diskVersion,
                ),
              undefined,
            );
          yield* emit({ _tag: "BackfillProgress" });
        }
        return { filename: listed.filename, mimeType: listed.mimeType, data };
      });

      const inlineImages = Effect.fn("Mailbox.inlineImages")(function* (messageId: string) {
        const { account, adapter, providerId } = yield* source(messageId);
        return yield* adapter
          .fetchRaw(account, providerId)
          .pipe(Effect.flatMap(inlineImagesFromRaw));
      });

      const localInline = Effect.fnUntraced(function* (id: string) {
        const message = yield* store.getMessage(id);
        if (
          Buffer.byteLength(message.bodyHtml) +
            message.attachments.reduce((total, part) => total + part.size, 0) >
          MAX_INLINE_BYTES
        )
          return [];
        const { account, adapter, providerId } = yield* source(id);
        return yield* adapter.fetchRaw(account, providerId, MAX_INLINE_BYTES).pipe(
          Effect.flatMap((raw) =>
            inlineMediaFromRaw(raw).pipe(
              Effect.mapError(() => new MediaError({ message: "Cannot parse inline media" })),
            ),
          ),
          Effect.catchIf(
            (error) => error._tag === "PermanentError" && error.message === MEDIA_RAW_TOO_LARGE,
            () => Effect.succeed([]),
          ),
        );
      });
      const reserveBytes = yield* makeDownloadBudget;
      const indexInput = {
        reserveBytes,
        store: store.media,
        vision: options.media?.vision ?? unavailableVision,
        onBattery: options.media?.onBattery ?? (() => false),
        busy: Effect.map(
          Ref.get(state),
          (current) => current.running || !(options.media?.idle() ?? true),
        ),
        message: (id) => store.getMessage(id).pipe(Effect.orDie),
        attachment: (id, index) => attachment(id, index).pipe(Effect.map((part) => part.data)),
        inline: (id) => localInline(id),
        changed,
      } satisfies import("./indexer.js").IndexerInput;
      const indexer = yield* makeIndexer(indexInput);
      const semantic = options.models
        ? yield* makeSemanticIndexer(indexInput, store, options.models)
        : undefined;
      if (options.media)
        yield* backgroundReady.pipe(
          Effect.andThen(
            indexer.batch().pipe(
              Effect.catchCause(() => Effect.logWarning("Media indexing batch failed")),
              Effect.repeat(Schedule.spaced("15 seconds")),
            ),
          ),
          Effect.forkScoped,
        );
      if (options.media && semantic)
        yield* backgroundReady.pipe(
          Effect.andThen(
            semantic.batch().pipe(
              Effect.catchCause(() => Effect.void),
              Effect.repeat(Schedule.spaced("15 seconds")),
            ),
          ),
          Effect.forkScoped,
        );
      if (!options.media && options.models?.verifyLocal && (yield* store.semantics.enabled))
        yield* options.models.verifyLocal().pipe(Effect.catch(() => Effect.void));
      const semanticThreads = Effect.fn("Mailbox.semanticThreads")(function* (
        q: import("./domain.js").ThreadQuery,
      ) {
        const local = yield* store.listThreads(q);
        const parsed = parseSearchQuery(q);
        const query = parsed.search?.trim();
        if (
          !query ||
          !options.models ||
          !store.semantics.vectors ||
          !(yield* store.semantics.enabled) ||
          (yield* options.models.status).kind !== "ready"
        )
          return local;
        const models = options.models;
        const routes = yield* Effect.gen(function* () {
          // CLI/MCP may use already-present files after the app's persisted
          // opt-in. A search never starts a model download.
          yield* models.ensure(false);
          const text = yield* models.embedder.text(query, "query");
          const image = yield* models.images.query(query);
          return [
            yield* store.vectorThreads(
              q,
              yield* store.semantics.neighbors("text", text, models.version, parsed),
            ),
            yield* store.vectorThreads(
              q,
              yield* store.semantics.neighbors("image", image, models.version, parsed),
            ),
          ];
        }).pipe(Effect.catch(() => Effect.succeed([])));
        return semanticRankFusion(local, routes[0] ?? [], routes[1] ?? [], q.flat).slice(
          0,
          q.limit ?? 50,
        );
      });
      const mediaImage = Effect.fnUntraced(function* (chunk: DerivedChunk) {
        if (
          chunk.source.kind === "body" ||
          chunk.region === null ||
          !chunk.source.mimeType.toLowerCase().startsWith("image/")
        )
          return yield* new NotFound({ what: "attachment", id: chunk.messageId });
        if (chunk.source.kind === "attachment") {
          const part = yield* attachment(chunk.messageId, chunk.source.index);
          return `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`;
        }
        const images = yield* inlineImages(chunk.messageId);
        const data = images[chunk.source.cid];
        if (data === undefined)
          return yield* new NotFound({ what: "attachment", id: chunk.source.cid });
        return data;
      });

      // Pulling

      const applyChanges = (
        account: Account,
        counts: { changed: number; deleted: number },
        notificationsReady: boolean,
        scope?: "inbox",
      ) => {
        const remapped = new Set<string>();
        return Effect.fnUntraced(function* (batch: readonly Change[]) {
          account = yield* store.getAccount(account.id).pipe(Effect.orDie);
          if (account.enabled === false) return;
          const prefs = yield* store.prefs;
          const now = new Date(yield* Clock.currentTimeMillis);
          const writes: Effect.Effect<void, ProviderError>[] = [];
          const newIds: string[] = [];
          const pendingById = new Map<string, MailOp[]>();
          for (const change of batch) {
            // Polling only discovers arrivals/flags; full sync reconciles moves and resets.
            if (
              scope &&
              ["Delete", "DeleteLabel", "Reset", "Labels", "VerifyCandidates"].includes(change._tag)
            )
              continue;
            switch (change._tag) {
              case "FetchLater":
                writes.push(
                  store
                    .enqueueOp(account.id, change.providerId, { kind: "reconcile" })
                    .pipe(Effect.asVoid),
                );
                break;
              case "Remap":
              case "Upsert":
                counts.changed++;
                writes.push(
                  Effect.gen(function* () {
                    if (
                      change._tag === "Remap" &&
                      change.message.rfcMessageId &&
                      !(yield* store.messageIdForProvider(account.id, change.message.providerId))
                    ) {
                      const local = yield* store.findMessageByRfcId(
                        account.id,
                        change.message.rfcMessageId,
                        change.previous,
                      );
                      if (local && !remapped.has(local)) {
                        remapped.add(local);
                        const ref = yield* store.messageRef(local).pipe(Effect.orDie);
                        yield* store.remapProviderIds(account.id, [
                          { from: ref.providerId, to: change.message.providerId },
                        ]);
                      }
                    }
                    const existingId = yield* store.messageIdForProvider(
                      account.id,
                      change.message.providerId,
                    );
                    const id = existingId ?? `${account.id}/${change.message.providerId}`;
                    const known = existingId !== null;
                    // IMAP moves assign a new folder/UID while preserving the mail itself.
                    const identity =
                      account.provider === "imap"
                        ? sha256Hex(
                            JSON.stringify([
                              change.message.threadId,
                              change.message.date,
                              change.message.from.address,
                              change.message.subject,
                              change.message.bodyText,
                            ]),
                          )
                        : change.message.providerId;
                    const first = yield* store.observeIncoming(account.id, identity);
                    const remappedOps =
                      change._tag === "Remap"
                        ? (yield* store.pendingOpsForMessages(account.id, [
                            change.message.providerId,
                          ])).flatMap((pending) =>
                            pending.op.kind === "saveDraft" ||
                            pending.op.kind === "deleteDraft" ||
                            pending.op.kind === "reconcile"
                              ? []
                              : [pending.op],
                          )
                        : (pendingById.get(change.message.providerId) ?? []);
                    const incoming = withPendingOps(change.message, remappedOps, account.provider);
                    yield* store.upsertMessage(account.id, incoming);
                    const storedId =
                      (yield* store.messageIdForProvider(account.id, incoming.providerId)) ?? id;
                    if (
                      first &&
                      !known &&
                      notificationsReady &&
                      change.message.date >= (account.lastSyncedAt ?? 0) &&
                      change.message.isUnread &&
                      change.message.labels.includes("INBOX")
                    ) {
                      const message = {
                        ...change.message,
                        id: storedId,
                        accountId: account.id,
                        hasAttachments: change.message.attachments.length > 0,
                      };
                      if (notificationEligible(account, message, prefs))
                        yield* store.enqueueNotification(
                          storedId,
                          !profileNotificationsActive(account, prefs, now),
                        );
                      newIds.push(storedId);
                    }
                  }),
                );
                // Gmail keeps the message id when a draft is sent elsewhere; it only loses DRAFT.
                if (!change.message.labels.includes("DRAFT")) {
                  writes.push(store.dropSyncedDrafts(account.id, change.message.providerId));
                }
                break;
              case "Delete":
                counts.deleted++;
                writes.push(
                  store.deleteMessage(account.id, change.providerId),
                  // A draft deleted or sent in another client goes here too.
                  store.dropSyncedDrafts(account.id, change.providerId),
                );
                break;
              case "MessageLabels":
                counts.changed++;
                if (!change.labels.includes("DRAFT"))
                  writes.push(store.dropSyncedDrafts(account.id, change.providerId));
                if (!(yield* store.messageIdForProvider(account.id, change.providerId))) {
                  const fetched = yield* providers
                    .get(account.provider)
                    .fetchMessage(account, change.providerId)
                    .pipe(
                      Effect.map(Option.some),
                      Effect.catchTag("PermanentError", () => Effect.succeed(Option.none())),
                    );
                  if (Option.isSome(fetched))
                    writes.push(
                      Effect.gen(function* () {
                        yield* store.upsertMessage(
                          account.id,
                          withPendingOps(
                            fetched.value,
                            pendingById.get(change.providerId) ?? [],
                            account.provider,
                          ),
                        );
                      }),
                    );
                  break;
                }
                writes.push(
                  Effect.gen(function* () {
                    const id = yield* store.messageIdForProvider(account.id, change.providerId);
                    if (!id) return;
                    const message = yield* store.getMessage(id).pipe(Effect.orDie);
                    yield* store.upsertMessage(
                      account.id,
                      withPendingOps(
                        {
                          ...message,
                          providerId: change.providerId,
                          labels: [...change.labels],
                          isUnread: change.labels.includes("UNREAD"),
                          isStarred: change.labels.includes("STARRED"),
                        },
                        pendingById.get(change.providerId) ?? [],
                        account.provider,
                      ),
                    );
                  }),
                );
                break;
              case "Flags":
                counts.changed++;
                writes.push(
                  Effect.gen(function* () {
                    const id = yield* store.messageIdForProvider(account.id, change.providerId);
                    if (!id) return;
                    const cached = yield* store.getMessage(id).pipe(Effect.option);
                    if (Option.isNone(cached)) return;
                    const message = cached.value;
                    const labels = applyOpToLabels(
                      applyOpToLabels(
                        message.labels.filter((label) => label !== "SNOOZED"),
                        { kind: "read", value: !change.isUnread },
                        account.provider,
                      ),
                      { kind: "star", value: change.isStarred },
                      account.provider,
                    );
                    yield* store.upsertMessage(
                      account.id,
                      withPendingOps(
                        {
                          ...message,
                          providerId: change.providerId,
                          labels,
                          isUnread: change.isUnread,
                          isStarred: change.isStarred,
                        },
                        pendingById.get(change.providerId) ?? [],
                        account.provider,
                      ),
                    );
                  }),
                );
                break;
              case "InvalidateFolder":
                writes.push(
                  store.invalidateImapFolder(account.id, change.previous).pipe(
                    Effect.tap(batchMailbox.forgetMessages),
                    Effect.asVoid,
                    Effect.tap(() =>
                      Effect.sync(() => {
                        for (const id of pendingById.keys()) {
                          const ref = decodeProviderId(id);
                          if (
                            Option.isSome(ref) &&
                            ref.value.path === change.previous.path &&
                            ref.value.uidValidity === change.previous.uidValidity
                          )
                            pendingById.delete(id);
                        }
                      }),
                    ),
                  ),
                );
                break;
              case "VerifyCandidates":
              case "RebuildFolder":
              case "DeleteLabel":
              case "Reset":
                break; // Verification and reset barriers run outside the write transaction.
              case "BackfillReset":
                writes.push(store.resetBackfill(account.id));
                break;
              case "Labels":
                writes.push(store.replaceLabels(account.id, change.labels));
                break;
              case "Cursor":
                writes.push(
                  scope
                    ? store.saveInboxCursor(account.id, change.cursor)
                    : store
                        .saveSyncCursor(account.id, change.cursor)
                        .pipe(
                          Effect.andThen(
                            account.provider === "imap"
                              ? store.saveInboxCursor(account.id, change.cursor)
                              : Effect.void,
                          ),
                        ),
                );
                break;
              case "Progress":
                if (scope) break;
                writes.push(
                  emit({
                    _tag: "SyncProgress",
                    progress: {
                      accountId: account.id,
                      fetched: change.fetched,
                      total: change.total,
                    },
                  }).pipe(Effect.asVoid),
                );
                break;
            }
          }
          // Changes apply in order, so a Cursor inside the batch is saved only
          // together with everything before it.
          yield* store.transaction(
            Effect.gen(function* () {
              const ids = [
                ...new Set(
                  batch.flatMap((change) =>
                    change._tag === "Upsert" || change._tag === "Remap"
                      ? [change.message.providerId]
                      : change._tag === "Flags" || change._tag === "MessageLabels"
                        ? [change.providerId]
                        : [],
                  ),
                ),
              ];
              for (const pending of yield* store.pendingOpsForMessages(account.id, ids)) {
                if (
                  pending.op.kind === "saveDraft" ||
                  pending.op.kind === "deleteDraft" ||
                  pending.op.kind === "reconcile"
                )
                  continue;
                const ops = pendingById.get(pending.providerId) ?? [];
                ops.push(pending.op);
                pendingById.set(pending.providerId, ops);
              }
              yield* Effect.all(writes, { discard: true });
            }),
          );
          if (newIds.length) yield* emit({ _tag: "NewMail", accountId: account.id, ids: newIds });
        });
      };

      const pullAccount = Effect.fn("Mailbox.pullAccount")(function* (
        account: Account,
        scope?: "inbox",
        incrementalOnly = false,
        budget = { remaining: RESET_VERIFICATION_LIMIT },
      ) {
        const counts = { changed: 0, deleted: 0 };
        const guard = makeResetGuard(
          store,
          providers.get(account.provider),
          account,
          counts,
          budget,
        );
        const apply = (current: Account, notificationsReady: boolean) =>
          Effect.fnUntraced(function* (batch: readonly Change[]) {
            let changes: Change[] = [];
            for (const change of batch) {
              if (
                !scope &&
                (change._tag === "VerifyCandidates" ||
                  change._tag === "Reset" ||
                  change._tag === "DeleteLabel" ||
                  change._tag === "RebuildFolder")
              ) {
                if (changes.length)
                  yield* applyChanges(current, counts, notificationsReady, scope)(changes);
                changes = [];
                yield* change._tag === "VerifyCandidates"
                  ? guard.enqueue(change.providerIds)
                  : guard.reset(change);
              } else changes.push(change);
            }
            if (changes.length)
              yield* applyChanges(current, counts, notificationsReady, scope)(changes);
          });
        account = yield* store.getAccount(account.id).pipe(Effect.orDie);
        if (account.enabled === false) return { accountId: account.id, ...counts };
        if (account.needsReauth) {
          return { accountId: account.id, ...counts, error: "Sign in again", needsReauth: true };
        }
        const failed = (text: string, auth: boolean) =>
          Effect.gen(function* () {
            if (auth) yield* store.setNeedsReauth(account.id, true);
            yield* scope
              ? store.setInboxError(account.id, text)
              : store.setSyncError(account.id, text);
            return {
              accountId: account.id,
              ...counts,
              error: text,
              ...(auth ? { needsReauth: true } : {}),
            } satisfies SyncResult;
          });
        if (!scope && account.lastSyncedAt === null) yield* store.beginInitialSync(account.id);
        const notificationsReady = yield* store.notificationsReady(account.id);
        // A retry starts from the cursor the failed attempt left: batches it
        // wrote stay, and the cursor only moves once a whole pull is in.
        const pull = Effect.sync(() => {
          counts.changed = 0;
          counts.deleted = 0;
        }).pipe(
          Effect.andThen(
            scope
              ? store
                  .getInboxCursor(account.id)
                  .pipe(
                    Effect.flatMap((cursor) =>
                      Option.isSome(cursor)
                        ? Effect.succeed(cursor)
                        : store.getSyncCursor(account.id),
                    ),
                  )
              : store.getSyncCursor(account.id),
          ),
          Effect.flatMap((cursor) =>
            Effect.gen(function* () {
              const currentAccount = yield* store.getAccount(account.id).pipe(Effect.orDie);
              if (currentAccount.enabled === false) return;
              yield* providers
                .get(account.provider)
                .pull(currentAccount, cursor, scope, incrementalOnly)
                .pipe(
                  Stream.groupedWithin(WRITE_BATCH, Duration.millis(250)),
                  Stream.takeWhileEffect(() =>
                    store.getAccount(account.id).pipe(
                      Effect.orDie,
                      Effect.map((a) => a.enabled !== false),
                    ),
                  ),
                  Stream.runForEach(apply(currentAccount, notificationsReady)),
                );
            }),
          ),
        );
        return yield* pull.pipe(
          Effect.retry(scope ? { ...PULL_RETRY, times: 0 } : PULL_RETRY),
          Effect.andThen(scope ? Effect.void : guard.verify()),
          Effect.andThen(
            scope
              ? Effect.void
              : guard.sweep(() => makeSyncHealth(store, providers)(account.id).pipe(Effect.orDie)),
          ),
          Effect.andThen(
            scope
              ? store.setInboxError(account.id, null)
              : store
                  .setSyncError(account.id, null)
                  .pipe(Effect.andThen(store.setInboxError(account.id, null))),
          ),
          Effect.andThen(scope ? Effect.void : store.finishInitialSync(account.id)),
          Effect.andThen(
            !scope && account.provider === "gmail"
              ? store.getAccount(account.id).pipe(
                  Effect.orDie,
                  Effect.flatMap((a) =>
                    a.enabled === false
                      ? Effect.void
                      : providers
                          .get("gmail")
                          .sendAs(a)
                          .pipe(
                            Effect.flatMap((aliases) =>
                              store.transaction(store.replaceSendAs(a.id, aliases)),
                            ),
                            // Settings permission is optional for existing mail accounts.
                            Effect.catch(() => Effect.void),
                          ),
                  ),
                )
              : Effect.void,
          ),
          // `counts` is filled while the stream runs, so read it afterwards.
          Effect.map(() => ({ accountId: account.id, ...counts }) satisfies SyncResult),
          Effect.catch((error) => failed(error.message, error._tag === "AuthError")),
          // A bug in one provider must not stop the other accounts from syncing.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("sync crashed", cause).pipe(
                  Effect.andThen(failed(String(Cause.squash(cause)), false)),
                ),
          ),
        );
      });

      const runSync = Effect.fn("Mailbox.runSync")(function* (accountId?: string) {
        yield* Ref.update(state, (s) => ({ ...s, running: true }));
        yield* emit({ _tag: "SyncState", state: yield* Ref.get(state) });
        yield* organization.wakeSnoozed();
        // IMAP must check UID namespaces before replaying persisted operations.
        // Other providers retain stable identities and can push first.
        yield* flush(undefined, true);
        const accounts = accountId
          ? [yield* store.getAccount(accountId).pipe(Effect.orDie)]
          : yield* store.listAccounts;
        const results: SyncResult[] = [];
        const budget = { remaining: RESET_VERIFICATION_LIMIT };
        // One failing account does not stop the rest.
        for (const account of accounts) {
          if (account.enabled === false) continue;
          const result: SyncResult = yield* account.provider === "imap"
            ? pullAccount(account, undefined, false, budget).pipe(
                imapPullLock(account.id).withPermits(1),
              )
            : pullAccount(account, undefined, false, budget);
          if (account.provider === "imap" && !result.error) yield* flush([account.id]);

          results.push(result);
          if (!result.error) polling.delete(account.id);
          if (!account.needsReauth)
            yield* features
              .refreshContacts(account.id, false)
              .pipe(Effect.catch(() => Effect.void));
          yield* store.getBackfillState(account.id);
          yield* store.evictBodies(account.id, yield* Clock.currentTimeMillis);
        }
        const next: SyncState = {
          running: false,
          lastFinishedAt: Date.now(),
          errors: results.flatMap((r) => (r.error ? [`${r.accountId}: ${r.error}`] : [])),
        };
        yield* Ref.set(state, next);
        yield* emit({ _tag: "SyncState", state: next });
        yield* changed;
        yield* store.checkpoint;
        return results;
      });

      /** One sync at a time: a call during a run waits for that run instead of starting another. */
      const sync = Effect.fn("Mailbox.sync")(function* (accountId?: string) {
        const current = yield* Ref.get(inflight);
        if (Option.isSome(current)) return yield* Deferred.await(current.value);
        const done = yield* Deferred.make<SyncResult[]>();
        yield* Ref.set(inflight, Option.some(done));
        return yield* runSync(accountId).pipe(
          syncLock.withPermits(1),
          Effect.onExit((exit) =>
            Ref.set(inflight, Option.none()).pipe(
              Effect.andThen(Deferred.done(done, exit)),
              Effect.andThen(
                exit._tag === "Failure"
                  ? Ref.update(state, (s) => ({ ...s, running: false }))
                  : Effect.void,
              ),
            ),
          ),
        );
      });

      const pollInterval = Duration.toMillis(
        Duration.fromInputUnsafe(options.inboxPoll ?? "45 seconds"),
      );
      const onBattery = () => options.pollOnBattery?.() ?? options.media?.onBattery() ?? false;
      const pollInbox = Effect.fn("Mailbox.pollInbox")(function* (
        accountIds?: readonly string[],
        incrementalOnly = false,
      ) {
        if (syncPaused) return [];
        const task = Effect.gen(function* () {
          if (accountIds === undefined) yield* flush(undefined, true);
          const accounts = yield* store.listAccounts;
          const now = yield* Clock.currentTimeMillis;
          const results: SyncResult[] = [];
          let anyChange = false;
          for (const account of accounts) {
            if (
              account.enabled === false ||
              (accountIds !== undefined && !accountIds.includes(account.id)) ||
              (accountIds === undefined &&
                (idle?.active(account.id) || idle?.reconnecting(account.id))) ||
              account.lastSyncedAt === null ||
              (accountIds === undefined && (polling.get(account.id)?.due ?? 0) > now)
            )
              continue;
            const before = yield* store.getInboxError(account.id);
            const pulled: SyncResult = yield* account.provider === "imap"
              ? pullAccount(account, "inbox", incrementalOnly).pipe(
                  imapPullLock(account.id).withPermits(1),
                )
              : pullAccount(account, "inbox", incrementalOnly);
            if (account.provider === "imap" && !pulled.error) yield* flush([account.id]);
            results.push(pulled);
            const error = yield* store.getInboxError(account.id);
            anyChange ||= pulled.changed + pulled.deleted > 0 || before !== error;
            if (pulled.error) {
              const failures = (polling.get(account.id)?.failures ?? 0) + 1;
              polling.set(account.id, {
                failures,
                due: now + Math.min(900_000, pollInterval * 2 ** Math.min(failures, 5)),
              });
            } else polling.delete(account.id);
          }
          const live = new Set(accounts.map((account) => account.id));
          for (const id of polling.keys()) if (!live.has(id)) polling.delete(id);
          if (anyChange) yield* changed;
          return results;
        });
        if (accountIds !== undefined) return yield* syncLock.withPermits(1)(task);
        const result = yield* syncLock.withPermitsIfAvailable(1)(task);
        return Option.getOrElse(result, () => []);
      });

      if (options.imapIdle) {
        const runIdle = yield* FiberSet.makeRuntimePromise();
        idle = new ImapIdle(
          (account, signal, onChange, ready) => {
            const watch = providers.get(account.provider).watchInbox;
            return watch
              ? runIdle(watch(account, signal, onChange, ready))
              : Promise.resolve("unsupported");
          },
          (accountIds) => runIdle(pollInbox(accountIds)),
        );
        const watcher = idle;
        yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()));
        yield* store.listAccounts.pipe(
          Effect.tap((accounts) => Effect.sync(() => watcher.reconcile(accounts))),
          Effect.repeat(Schedule.spaced("5 seconds")),
          Effect.forkScoped,
        );
      }

      // Accounts

      const connect = Effect.fn("Mailbox.connect")(function* (
        input: ConnectInput,
        expect?: string,
      ) {
        const accounts = yield* store.listAccounts;
        const hinted =
          input.provider === "imap"
            ? undefined
            : accounts.find(
                (account) =>
                  account.provider === input.provider &&
                  account.email.toLowerCase() === (input.loginHint ?? expect)?.toLowerCase(),
              );
        const scopes = hinted
          ? yield* store.grantedScopes(hinted.id)
          : input.provider === "imap"
            ? []
            : (input.grantedScopes ?? []);
        let connected = yield* providers
          .get(input.provider)
          .connect(
            input.provider === "imap" || scopes.length === 0
              ? input
              : { ...input, grantedScopes: scopes },
          );
        // Re-add without a login hint discovers the identity before requesting its saved grant.
        const existing = accounts.find(
          (account) =>
            account.provider === input.provider &&
            account.email.toLowerCase() === connected.email.toLowerCase(),
        );
        if (!hinted && existing && input.provider !== "imap" && input.grantedScopes === undefined) {
          const previous = yield* store.grantedScopes(existing.id);
          connected = yield* providers
            .get(input.provider)
            .connect({ ...input, loginHint: existing.email, grantedScopes: previous });
          if (connected.email.toLowerCase() !== existing.email.toLowerCase())
            return yield* new InvalidInput({
              message: `Signed in as ${connected.email}, expected ${existing.email}.`,
            });
        }
        if (expect && connected.email.toLowerCase() !== expect.toLowerCase()) {
          return yield* new InvalidInput({
            message: `Signed in as ${connected.email}, expected ${expect}.`,
          });
        }
        const account = yield* store.upsertAccount(input.provider, connected.email);
        yield* secrets.set(account.id, connected.secret);
        if (input.provider !== "imap")
          yield* store.setGrantedScopes(account.id, connected.scopes ?? []);
        if (connected.imap) yield* store.setImapSettings(account.id, connected.imap);
        yield* providers.get(account.provider).closeSessions?.(account.id) ?? Effect.void;
        yield* store.setNeedsReauth(account.id, false);
        yield* store.setSyncError(account.id, null);
        yield* store.audit({
          actor: { kind: "user", surface: "app" },
          accountId: account.id,
          action: "connect",
          detail: {},
        });
        // New grants must not wait for the optional-feature retry interval.
        yield* FiberSet.run(
          background,
          features.refreshContacts(account.id, true, true).pipe(Effect.catch(() => Effect.void)),
        );
        yield* changed;
        yield* Effect.forkDetach(sync());
        return yield* store.getAccount(account.id).pipe(Effect.orDie);
      });

      const reauth = Effect.fn("Mailbox.reauth")(function* (
        accountId: string,
        feature?: AuthorizationFeature,
      ) {
        const account = yield* store.getAccount(accountId);
        if (feature === "permanentDelete" && account.provider !== "gmail")
          return yield* new InvalidInput({
            message: "Only Gmail requires an extra permanent deletion permission.",
          });
        if (account.provider === "imap") {
          return yield* new InvalidInput({
            message: "IMAP accounts sign in again by adding the address with a new password.",
          });
        }
        const grantedScopes = yield* store.grantedScopes(accountId);
        const result = yield* connect(
          account.provider === "gmail"
            ? {
                provider: "gmail",
                loginHint: account.email,
                grantedScopes,
                ...(feature ? { feature } : {}),
              }
            : {
                provider: "outlook",
                loginHint: account.email,
                grantedScopes,
                ...(feature && feature !== "permanentDelete" ? { feature } : {}),
              },
          account.email,
        );
        if (
          feature &&
          !(feature === "permanentDelete"
            ? (yield* store.grantedScopes(accountId)).includes(GMAIL_PERMANENT_DELETE_SCOPE)
            : serviceGranted(account.provider, feature, yield* store.grantedScopes(accountId)))
        )
          return yield* new FeatureScopeMissing({
            accountId,
            feature,
            message: "The provider did not grant the requested permission.",
          });
        if (feature && feature !== "permanentDelete")
          yield* store.setServiceEnabled(accountId, feature, true);
        if (feature === "contacts")
          yield* features
            .refreshContacts(accountId, true, true)
            .pipe(Effect.catch(() => Effect.void));
        yield* changed;
        return result;
      });

      if (options.autoSync !== undefined) {
        yield* Effect.gen(function* () {
          yield* store.evictBodyBudget((yield* store.prefs).bodyCacheBytes);
        }).pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped);

        // Start after the first normal sync. A single account/page per tick
        // prevents large accounts from starving smaller ones.
        let nextAccount = 0;
        yield* Effect.gen(function* () {
          yield* Effect.sleep("10 seconds");
          if (syncPaused) return;
          const accounts = yield* store.listAccounts;
          const account = accounts[nextAccount % Math.max(1, accounts.length)];
          nextAccount++;
          if (account) yield* cache.backfillOlder({ accountIds: [account.id] });
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("backfill failed", cause)),
          Effect.repeat(Schedule.spaced("10 seconds")),
          Effect.forkScoped,
        );

        yield* organization
          .wakeSnoozed()
          .pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
        yield* backgroundReady.pipe(
          Effect.andThen(
            Effect.suspend(() => (syncPaused ? Effect.void : sync())).pipe(
              Effect.catchCause((cause) => Effect.logWarning("sync failed", cause)),
              Effect.repeat(Schedule.spaced(options.autoSync)),
            ),
          ),
          Effect.forkScoped,
        );
      }

      if (options.inboxPoll !== undefined) {
        yield* Effect.suspend(() => Effect.sleep(pollInterval * (onBattery() ? 2 : 1))).pipe(
          Effect.andThen(pollInbox()),
          Effect.catchCause((cause) => Effect.logWarning("inbox poll failed", cause)),
          Effect.forever,
          Effect.forkScoped,
        );
      }

      const mutate = <A, E>(effect: Effect.Effect<A, E>) => Effect.tap(effect, () => changed);

      let mailbox: Mailbox["Service"];
      const ai = makeAiMailbox(store, secrets, model, () => mailbox, changed, options.canTriage);
      function thread(id: string): Effect.Effect<Message[], NotFound>;
      function thread(
        id: string,
        view: "model",
        tokenBudget?: number,
      ): Effect.Effect<import("./mailbox.js").ModelThread, NotFound>;
      function thread(id: string, view?: "model", tokenBudget = 6000) {
        return view === "model"
          ? Effect.map(store.getThread(id), (messages) => modelContext(messages, tokenBudget))
          : store.getThread(id);
      }
      // Subscribe before returning. Only opted-in auto-summary accounts can call the model.
      if (options.autoSync)
        yield* Stream.runForEach(Stream.fromPubSub(pubsub), (event) =>
          event._tag === "NewMail"
            ? Effect.andThen(ai.autoTriage(event.ids), ai.autoSummaries(event.ids))
            : Effect.void,
        ).pipe(Effect.forkScoped);
      const outboxLock = yield* Semaphore.make(1);
      const queueSend = Effect.fn("Mailbox.queueSend")(function* (
        input: DraftInput,
        due: number,
        confirmResend = false,
      ) {
        if (readOnly) return yield* new InvalidInput({ message: READ_ONLY_MESSAGE });
        if (
          !Number.isFinite(due) ||
          [...input.message.to, ...input.message.cc, ...input.message.bcc].some(
            (recipient) => !isEmailAddress(recipient.address),
          ) ||
          input.message.to.length + input.message.cc.length + input.message.bcc.length === 0
        )
          return yield* new InvalidInput({
            message: "A queued message needs recipients and a valid send time",
          });
        const account = yield* store.getAccount(input.accountId);
        if (mobileAttachmentProblem(account.provider, input.message.attachments))
          return yield* new InvalidInput({ message: "Attachments rejected before sending" });
        if (yield* store.sendUncertain(input.id)) {
          if (!confirmResend)
            return yield* new SendUncertain({
              message: "This message may have been sent. Check Sent before sending it again.",
            });
          const queued = (yield* store.queuedSends).find((item) => item.id === input.id);
          if (queued?.status === "failed") yield* store.deleteQueuedSend(input.id);
          yield* store.setSendUncertain(input.id, false);
        }
        if ((yield* store.queuedSends).some((item) => item.id === input.id))
          return yield* new InvalidInput({ message: "This draft already has a queued send" });
        yield* store.transaction(
          Effect.gen(function* () {
            const saved = yield* persistDraft(input, true);
            yield* store.putQueuedSend({
              id: input.id,
              accountId: input.accountId,
              message: saved.message,
              due,
              status: "waiting",
            });
          }),
        );
        return yield* changed;
      }, outboxLock.withPermits(1));
      const cancelQueuedSend = (id: string) =>
        Effect.gen(function* () {
          const item = (yield* store.queuedSends).find((entry) => entry.id === id);
          if (!item) return false;
          yield* store.deleteQueuedSend(id);
          yield* changed;
          return true;
        }).pipe(outboxLock.withPermits(1));
      const flushQueuedSends = (canSend: () => boolean = () => true) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (readOnly) return;
          for (const item of yield* store.queuedSends) {
            if (!canSend()) break;
            if (item.status !== "waiting" || item.due > now) continue;
            const account = yield* store.getAccount(item.accountId).pipe(Effect.option);
            if (
              Option.isNone(account) ||
              mobileAttachmentProblem(account.value.provider, item.message.attachments)
            ) {
              yield* store.putQueuedSend({ ...item, status: "rejected" });
              yield* changed;
              continue;
            }
            yield* store.putQueuedSend({ ...item, status: "sending" });
            const delivered = yield* perform(
              { kind: "send", accountId: item.accountId, draftId: item.id, message: item.message },
              { kind: "user", surface: "app" },
            ).pipe(Effect.result);
            yield* delivered._tag === "Success"
              ? store.deleteQueuedSend(item.id)
              : store.putQueuedSend({
                  ...item,
                  status:
                    delivered.failure._tag === "InvalidInput" ||
                    delivered.failure._tag === "NotFound"
                      ? "rejected"
                      : "failed",
                });
            yield* changed;
          }
        }).pipe(outboxLock.withPermits(1));
      mailbox = Mailbox.of({
        importCalendarAttachment: (messageId, path, key, actor) =>
          Effect.gen(function* () {
            if (readOnly) return yield* new InvalidInput({ message: READ_ONLY_MESSAGE });
            if (actor.kind !== "user" || actor.surface !== "app")
              return yield* new InvalidInput({
                message: "Calendar import requires confirmation in the app",
              });
            const message = yield* store.getMessage(messageId);
            const account = yield* store.getAccount(message.accountId);
            const adapter = providers.get(account.provider);
            if (
              account.enabled === false ||
              account.provider === "imap" ||
              !adapter.createCalendarEvent
            )
              return yield* new InvalidInput({
                message: "Calendar access is unavailable for this account",
              });
            const inspection = inspectAttachment(yield* mailbox.attachmentPart(messageId, path));
            const invite =
              inspection?.kind === "calendar"
                ? inspection.invites.find((i) => i.key === key && i.method === "PUBLISH")
                : undefined;
            const event = invite ? eventFromInvite(invite) : null;
            if (!event)
              return yield* new InvalidInput({ message: "This event cannot be imported" });
            yield* adapter.createCalendarEvent(account, event);
            yield* store.audit({
              actor,
              accountId: account.id,
              action: "calendar_import",
              detail: { messageId, key },
            });
            yield* changed;
            return yield* Effect.void;
          }),
        unsubscribe: (messageId, actor) =>
          Effect.gen(function* () {
            if (readOnly) return yield* new InvalidInput({ message: READ_ONLY_MESSAGE });
            if (actor.kind !== "user" || actor.surface !== "app")
              return yield* new InvalidInput({
                message: "Unsubscribe requires confirmation in the app",
              });
            const message = yield* store.getMessage(messageId);
            const target = message.security?.unsubscribe;
            if (target?.kind !== "post")
              return yield* new InvalidInput({
                message: "No verified one-click unsubscribe target",
              });
            const account = yield* store.getAccount(message.accountId);
            if (account.enabled === false)
              return yield* new InvalidInput({ message: "Enable this account to unsubscribe" });
            yield* unsubscribeNetwork.post(target.url);
            yield* store.audit({
              actor,
              accountId: account.id,
              action: "unsubscribe",
              detail: { messageId },
            });
            return yield* Effect.void;
          }),
        queuedSends: store.queuedSends,
        queueSend,
        cancelQueuedSend,
        flushQueuedSends,
        ...ai,
        closeSessions: () =>
          Effect.gen(function* () {
            for (const provider of new Set(
              (yield* store.listAccounts).map((account) => account.provider),
            ))
              yield* providers.get(provider).closeSessions?.() ?? Effect.void;
          }),
        setSyncPaused: (paused) =>
          Effect.gen(function* () {
            syncPaused = paused;
            idle?.pause(paused);
            if (paused)
              for (const provider of new Set(
                (yield* store.listAccounts).map((account) => account.provider),
              ))
                yield* providers.get(provider).closeSessions?.() ?? Effect.void;
          }),
        updateTokenConfigured: secrets.get(UPDATE_TOKEN_KEY).pipe(Effect.map(Option.isSome)),
        setUpdateToken: (token) =>
          Effect.gen(function* () {
            const trimmed = token.trim();
            if (trimmed.length > 4096 || /[\r\n]/.test(trimmed))
              yield* new InvalidInput({ message: "Enter a single access token" });
            yield* trimmed
              ? secrets.set(UPDATE_TOKEN_KEY, trimmed)
              : secrets.remove(UPDATE_TOKEN_KEY);
            yield* emit({ _tag: "UpdateSettingsChanged", resetState: true });
          }),
        startUpdates: (client, updateOptions) =>
          Effect.flatMap(store.prefs, (prefs) =>
            startStoredUpdates(
              client,
              {
                ...updateOptions,
                channel: prefs.updateChannel,
                autoDownload: updateOptions.autoDownload ?? prefs.updateAutoDownload,
              },
              secrets.get(UPDATE_TOKEN_KEY),
              verifier.verify,
            ),
          ),
        ...organization,
        ...batchMailbox,
        ...folderMailbox,
        ...features,
        ...cache,
        syncHealth: makeSyncHealth(store, providers),
        cacheDatabaseSize: store.cacheDatabaseSize,
        cacheSize: Effect.gen(function* () {
          const bodies = yield* store.bodySizes;
          return yield* Effect.forEach(yield* store.listAccounts, (a) =>
            Effect.gen(function* () {
              const attachmentBytes = diskAttachments
                ? yield* cacheIO(() => diskAttachments.size(a.id), 0)
                : 0;
              return {
                accountId: a.id,
                bodyBytes: bodies.find((b) => b.accountId === a.id)?.bytes ?? 0,
                attachmentBytes,
              };
            }),
          );
        }),
        clearCache: (accountId) =>
          Effect.gen(function* () {
            attachmentEpoch++;
            attachmentCache.clear();
            if (diskAttachments) yield* cacheIO(() => diskAttachments.clear(accountId), undefined);
            for (const a of yield* store.listAccounts)
              if (accountId === undefined || a.id === accountId) yield* store.clearBodies(a.id);
            yield* changed;
          }),
        initializeProfiles: (accept, names) =>
          store
            .transaction(
              Effect.gen(function* () {
                const prefs = yield* store.prefs;
                const accounts = yield* store.listAccounts;
                if (prefs.defaultProfilesPrompted || accounts.length < 2) return;
                yield* store.setPrefs({ defaultProfilesPrompted: true });
                if (!accept || (yield* store.listProfiles).length) return;
                yield* store.createProfile({ name: names.personal, icon: "🏠", color: "emerald" });
                yield* store.createProfile({ name: names.work, icon: "💼", color: "blue" });
              }),
            )
            .pipe(Effect.andThen(changed)),
        searchServer: (query) =>
          organization
            .searchServer(query)
            .pipe(Effect.tap(() => FiberSet.run(background, cache.fetchOlder(query)))),
        changeLabel: (accountId, change) =>
          organization
            .changeLabel(accountId, change)
            .pipe(
              Effect.tap(() =>
                change.kind === "color"
                  ? Effect.void
                  : options.backgroundFlush === false
                    ? sync(accountId).pipe(Effect.asVoid)
                    : FiberSet.run(background, sync(accountId)).pipe(Effect.asVoid),
              ),
            ),
        checkUpdates: (client, updateOptions) =>
          Effect.flatMap(store.prefs, (prefs) =>
            checkStoredUpdates(
              client,
              {
                ...updateOptions,
                channel: prefs.updateChannel,
                autoDownload: updateOptions.autoDownload ?? prefs.updateAutoDownload,
              },
              secrets.get(UPDATE_TOKEN_KEY),
              verifier.verify,
            ).pipe(
              Effect.ensuring(
                Effect.flatMap(store.prefs, (latestPrefs) =>
                  Effect.sync(() => {
                    client.autoDownload = latestPrefs.updateAutoDownload;
                  }),
                ),
              ),
            ),
          ),
        rememberNotificationActions: (id, actions) =>
          store.rememberNotificationActions(id, actions),
        notificationActions: (id) => store.notificationActions(id),
        ...makeOptionalServiceMailbox(store, changed, features.refreshContacts),
        accounts: store.listAccounts,
        setAccountSettings: (id, input) =>
          Effect.gen(function* () {
            const settings = yield* Schema.decodeUnknownEffect(AccountSettings)(input).pipe(
              Effect.mapError(() => new InvalidInput({ message: "Invalid account settings" })),
            );
            const previous = yield* store.getAccount(id);
            // Local edits and the enabled flag never wait for provider work.
            yield* store.setAccountSettings(id, settings);
            yield* providers.get(previous.provider).closeSessions?.(id) ?? Effect.void;
            idle?.reconcile(yield* store.listAccounts);
            const resumed = previous.enabled === false && settings.enabled;

            yield* changed;
            if (resumed) {
              polling.delete(id);
              yield* FiberSet.run(background, sync(id));
            }
          }),
        moveAccount: (id, input) => mutate(store.moveAccount(id, input)),
        takeNotifications: Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => store.takeNotifications(now)),
        ),
        connect: (input) => connect(input),
        reauth,
        clientSetup: Effect.map(config.read, (c) => ({
          googleConfigured: Boolean(c.google),
          microsoftConfigured: Boolean(c.microsoft),
        })),
        setClient: (patch) => mutate(config.write(patch)),

        threads: semanticThreads,
        semanticSearch: (q) =>
          Effect.gen(function* () {
            if (!q.accountIds?.length || !q.search?.trim()) return [];
            const consent = yield* store.ai.accounts;
            if (q.accountIds.some((id) => !consent.some((a) => a.accountId === id && a.allowed)))
              return yield* new InvalidInput({
                message: "This account is outside the selected accounts.",
              });
            const models = options.models;
            if (
              !models ||
              !store.semantics.vectors ||
              !(yield* store.semantics.enabled) ||
              (yield* models.status).kind !== "ready"
            )
              return [];
            yield* models.ensure(false);
            const embedding = yield* models.embedder.text(q.search, "query");
            const hits = yield* store.semantics.neighbors(
              "text",
              embedding,
              models.version,
              parseSearchQuery(q),
            );
            return (yield* store.vectorThreads(q, hits)).slice(0, Math.min(q.limit ?? 5, 5));
          }).pipe(
            Effect.mapError(() => new InvalidInput({ message: "Semantic search is unavailable." })),
          ),
        threadCount: (query) => store.countThreads(query),
        privateMailLink: (id, kind) =>
          store.getMessage(id).pipe(Effect.map((message) => privateMailLink(message, kind))),
        resolveMailLink: (id) =>
          Effect.gen(function* () {
            const reference = parseStableReference(id);
            if (!reference) {
              const message = yield* store.getMessage(id);
              if ((yield* store.getAccount(message.accountId)).enabled === false)
                return yield* new NotFound({ what: "message", id });
              return id;
            }
            const account = yield* store.getAccount(reference.accountId);
            if (account.enabled === false) return yield* new NotFound({ what: "message", id });
            const cached = yield* store.findMessageByRfcId(
              reference.accountId,
              reference.messageId,
            );
            if (cached) return cached;

            const found = yield* providers.get(account.provider).search(account, {
              mailbox: "all",
              search: `rfc822msgid:${quoteSearchValue(reference.messageId)}`,
              limit: 20,
            });
            const message = found.messages.find(
              (m) => m.rfcMessageId?.replace(/^<|>$/g, "") === reference.messageId,
            );
            if (!message) return yield* new NotFound({ what: "message", id });
            yield* store.upsertMessage(account.id, message);
            return (
              (yield* store.messageIdForProvider(account.id, message.providerId)) ??
              `${account.id}/${message.providerId}`
            );
          }),
        thread,
        threadForModel: (id, maxChars = DEFAULT_MODEL_CHARS) =>
          Effect.map(store.getThread(id), (messages) => modelContext(messages, maxChars)),
        rawMessage,
        rawMessageBytes,
        messageWebUrl,
        knownSenders: (accountId, addresses) => store.knownSenders(accountId, addresses),
        attachment,
        ...makeReaderAttachments(attachment, (id) => store.getThread(id), codec),
        inlineImages,
        imageSenders: store.imageSenders,
        setImageSender: (entry, allowed) => mutate(store.setImageSender(entry, allowed)),
        labels: (accountIds) => store.listLabels(accountIds),
        unreadCounts: store.unreadCounts,
        unreadByLabel: (accountIds, within, conversations) =>
          store.unreadByLabel(accountIds, within, conversations),

        profiles: store.listProfiles,
        createProfile: (input) => mutate(store.createProfile(input)),
        updateProfile: (id, input) => mutate(store.updateProfile(id, input)),
        deleteProfile: (id) => mutate(store.deleteProfile(id)),
        assignProfile: (accountId, profileId) =>
          mutate(store.setAccountProfile(accountId, profileId)),

        perform,
        decideProposal,
        proposals: store.listProposals("pending"),
        prepareRejectedResend: (noticeId) =>
          Effect.gen(function* () {
            const { notice, rejected } = yield* store.getFailedOp(noticeId);
            if (notice.kind !== "sendPartial" || !rejected.length)
              return yield* new InvalidInput({
                message: "This notice has no rejected recipients.",
              });
            const draft = yield* store.getDraft(notice.providerId);
            if (Option.isNone(draft))
              return yield* new NotFound({ what: "draft", id: notice.providerId });
            if (draft.value.accountId !== notice.accountId)
              return yield* new InvalidInput({
                message: "This draft changed accounts. Open it to choose recipients.",
              });
            const addresses = new Set(rejected.map((address) => address.trim().toLowerCase()));
            const keep = (recipients: OutgoingMessage["to"]) =>
              recipients.filter((recipient) => addresses.has(recipient.address.toLowerCase()));
            const message = {
              ...draft.value.message,
              to: keep(draft.value.message.to),
              cc: keep(draft.value.message.cc),
              bcc: keep(draft.value.message.bcc),
            };
            if (!message.to.length && !message.cc.length && !message.bcc.length)
              return yield* new InvalidInput({
                message: "The rejected recipients are no longer in this draft.",
              });
            const input = {
              id: `draft:${crypto.randomUUID()}`,
              accountId: notice.accountId,
              message,
            };
            yield* store.putDraft(input);
            yield* changed;
            return input;
          }),
        listFailedOps: store.listFailedOps,
        acknowledgeFailedOps: (ids) => mutate(store.acknowledgeFailedOps(ids)),
        audit: (limit) => store.listAudit(limit),
        agentWriteMode: store.agentWriteMode("*"),
        setAgentWriteMode: (mode) => mutate(store.setAgentWriteMode("*", mode)),

        openDraft,
        draftStatus,
        sendAgain,
        composeAttachments,
        pendingSendCount: Effect.sync(() => pendingSends),
        saveDraft,
        recoverDraft,
        discardDraft: (id) =>
          store
            .deleteQueuedSend(id)
            .pipe(Effect.andThen(discardDraft(id)), outboxLock.withPermits(1)),

        indexingProgress: Effect.gen(function* () {
          const enabled = yield* store.semantics.enabled;
          const counts = yield* store.semantics.counts;
          return {
            ...(yield* indexer.progress),
            modelsEnabled: enabled,
            models:
              enabled && options.models
                ? yield* options.models.status
                : { kind: "disabled" as const },
            semanticAvailable: store.semantics.vectors,
            embeddingRunning: counts.running,
            embeddingQueued: counts.queued,
            embeddingDone: counts.done,
            embeddingFailed: counts.failed,
          };
        }),
        setModelsEnabled: (enabled) =>
          mutate(
            store.semantics
              .setEnabled(enabled)
              .pipe(
                Effect.tap(() =>
                  !enabled && options.models ? options.models.stop() : Effect.void,
                ),
              ),
          ),
        setIndexingPaused: (value) => mutate(indexer.setPaused(value)),
        derivedChunks: store.media.chunks,
        mediaImage,
        prefs: store.prefs,
        setPrefs: (patch) =>
          Effect.gen(function* () {
            const previous = yield* store.prefs;
            const resetState =
              patch.updateChannel !== undefined && patch.updateChannel !== previous.updateChannel;
            return yield* mutate(store.setPrefs(patch)).pipe(
              Effect.tap(() =>
                patch.bodyCacheBytes !== undefined &&
                patch.bodyCacheBytes !== previous.bodyCacheBytes
                  ? store.evictBodyBudget(patch.bodyCacheBytes, true)
                  : Effect.void,
              ),
              Effect.tap(() =>
                patch.attachmentCacheBytes !== undefined && diskAttachments
                  ? cacheIO(() => diskAttachments.trim(patch.attachmentCacheBytes ?? 0), undefined)
                  : Effect.void,
              ),
              Effect.tap(() =>
                patch.updateChannel !== undefined || patch.updateAutoDownload !== undefined
                  ? emit({ _tag: "UpdateSettingsChanged", resetState })
                  : Effect.void,
              ),
            );
          }),
        namedSignatures: store.namedSignatures,
        signatureDefaults: store.signatureDefaults,
        saveNamedSignature: (input, id) => mutate(store.saveNamedSignature(input, id)),
        deleteNamedSignature: (id) => mutate(store.deleteNamedSignature(id)),
        setSignatureDefault: (setting) => mutate(store.setSignatureDefault(setting)),
        signatures: store.signatures,
        setSignature: (signature) => mutate(store.setSignature(signature)),
        templates: store.templates,
        saveTemplate: (input, id) => mutate(store.saveTemplate(id ?? null, input)),
        deleteTemplate: (id) => mutate(store.deleteTemplate(id)),

        suggestContacts: (query, { limit = DEFAULT_SUGGESTIONS, exclude, accountIds } = {}) =>
          store.suggestContacts(query, limit, exclude, accountIds),
        contactAlternatives: (address) => store.contactAlternatives(address),
        hiddenContacts: store.hiddenContacts,
        setContactHidden: (address, hidden) => mutate(store.setContactHidden(address, hidden)),

        sync: (accountId) => sync(accountId),
        pollInbox,
        syncState: Ref.get(state),
        events: Stream.fromPubSub(pubsub),
      });
      return mailbox;
    }),
  );
