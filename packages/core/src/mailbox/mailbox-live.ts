import { logWarning } from "../domain/diagnostic-log.js";
import { makeStorageMailbox } from "./mailbox-storage.js";
import {
  Cause,
  Config,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import {
  inlineImagesFromRaw as unboundInlineImagesFromRaw,
  inlineMediaFromRaw as unboundInlineMediaFromRaw,
} from "../mime/attachments.js";
import { makeDownloadBudget } from "../ai/download-budget.js";
import { parseRawDraft as unboundParseRawDraft } from "../compose/drafts.js";
import { InvalidInput } from "../domain/errors.js";
import { makeIndexer } from "../ai/indexer.js";
import { makeAccountsMailbox } from "./mailbox-accounts.js";
import { makeAiMailbox, makeLocalModelsMailbox } from "./mailbox-ai.js";
import { makeAppMailbox } from "./mailbox-app.js";
import { makeApplyMailbox } from "./mailbox-apply.js";
import { makeApplyChanges } from "./mailbox-pull-changes.js";
import { makeBatchMailbox } from "./mailbox-batch.js";
import { makeCacheMailbox } from "./mailbox-cache.js";
import { makeComposeSettingsMailbox } from "./mailbox-compose.js";
import { makeDraftsMailbox } from "./mailbox-drafts.js";
import { makeFeatureMailbox } from "./mailbox-features.js";
import { makeFlushMailbox } from "./mailbox-flush.js";
import { makeFolderMailbox } from "./mailbox-folders.js";
import { makeOrganizationMailbox } from "./mailbox-organization.js";
import { makeOutboxMailbox } from "./mailbox-outbox.js";
import { makeReadingMailbox } from "./mailbox-reading.js";
import {
  makeMailboxRuntimeState,
  type MailboxDependencies,
  type MailboxOptions,
} from "./mailbox-runtime.js";
import { makeSyncMailbox } from "./mailbox-sync.js";
import { Mailbox, type MailboxEvent, type MailboxSync } from "./mailbox.js";
import { unavailableVision } from "../ai/media.js";
import { Model, ModelUnavailable } from "../ai/model.js";
import { scopedAdapter } from "../providers/scoped-adapter.js";
import { destination as outlookDestination } from "../providers/outlook/graph.js";
import { PlatformCrypto } from "../platform/crypto.js";
import { MailCodec } from "../platform/mail-codec.js";
import { AppVerifier, AttachmentFiles, ImageNetwork, type PdfWorker } from "../platform/runtime.js";
import { offlineAdapter, readOnlyAdapter } from "./read-only.js";
import { makeSemanticIndexer } from "../ai/semantic-indexer.js";
import { AppConfig, OAuthIssuers, Secrets } from "../platform/auth.js";
import { Providers } from "../providers/adapter.js";
import { Store } from "../store/service.js";
import { UnsubscribeNetwork } from "./unsubscribe.js";

export type { MailboxOptions } from "./mailbox-runtime.js";
export const MailboxLive = (
  options: MailboxOptions = {},
): Layer.Layer<
  Mailbox,
  never,
  | Store
  | Providers
  | Secrets
  | AppConfig
  | OAuthIssuers
  | MailCodec
  | PdfWorker
  | AttachmentFiles
  | ImageNetwork
> =>
  Layer.effect(
    Mailbox,
    Effect.gen(function* () {
      const runtime = yield* makeMailboxRuntimeState;

      const crypto = yield* PlatformCrypto;

      const mailboxScope = yield* Effect.scope;

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

      const offline =
        (yield* Config.String("OPENMAIL_OFFLINE").pipe(Config.withDefault("0"), Effect.orDie)) ===
        "1";

      const rawProviders = yield* Providers;

      const providers = Providers.of({
        get: (provider) => {
          const cached = runtime.adapters.get(provider);
          if (cached) return cached;
          const scoped = scopedAdapter(rawProviders.get(provider), store);
          const adapter = offline
            ? offlineAdapter(scoped)
            : readOnly
              ? readOnlyAdapter(scoped)
              : scoped;
          runtime.adapters.set(provider, adapter);
          return adapter;
        },
      });

      const secrets = yield* Secrets;

      const config = yield* AppConfig;

      const issuers = yield* OAuthIssuers;

      const model = Option.getOrElse(yield* Effect.serviceOption(Model), () => ModelUnavailable);

      const diskAttachments = options.attachmentCacheDirectory
        ? files.open(options.attachmentCacheDirectory)
        : undefined;

      const emit = (event: MailboxEvent) => PubSub.publish(runtime.pubsub, event);

      const changed = emit({ _tag: "Changed" });

      const resetConnectivity = Effect.gen(function* () {
        runtime.polling.clear();
        runtime.idle?.retryNow();
        if (!readOnly) yield* store.retryPendingOpsNow();
        for (const provider of new Set(
          (yield* store.listAccounts).map((account) => account.provider),
        ))
          yield* providers.get(provider).resetConnectivity?.() ?? Effect.void;
      });

      const storage = yield* makeStorageMailbox(store, runtime, diskAttachments, readOnly, changed);
      const cache = makeCacheMailbox(
        store,
        providers,
        runtime.syncLock,
        () => Ref.get(runtime.inflight).pipe(Effect.map(Option.isSome)),
        changed,
        emit({ _tag: "BackfillProgress" }),
      );

      yield* Effect.gen(function* () {
        // Let desktop construct/show its first window before taking the SQLite
        // write lock for optional, resumable search backfill.
        yield* backgroundReady;
        let indexed = false;
        for (const step of [
          store.backfillWordIndex(),
          store.backfillSearchFlags(),
          store.indexBigrams(),
        ]) {
          let ready = false;
          while (!ready) {
            const batch = yield* step.pipe(
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
        }
        if (indexed) yield* changed;
        // Synced and edited mail queues bigram rows; search reads them with LIKE until indexed.
        // Drained after changes settle, not on a timer.
        yield* Stream.fromPubSub(runtime.pubsub).pipe(
          Stream.filter((event) => event._tag === "Changed" || event._tag === "NewMail"),
          Stream.debounce("2 seconds"),
          Stream.runForEach(() =>
            Effect.gen(function* () {
              let ready = false;
              while (!ready) {
                ready = (yield* store.indexBigrams()).ready;
                if (!ready) yield* Effect.yieldNow;
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void,
              ),
            ),
          ),
        );
      }).pipe(Effect.forkScoped);

      const imapPullLock = (accountId: string) => {
        let lock = runtime.imapPullLocks.get(accountId);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          runtime.imapPullLocks.set(accountId, lock);
        }
        return lock;
      };

      const pollInterval = Duration.toMillis(
        Duration.fromInputUnsafe(options.inboxPoll ?? "45 seconds"),
      );

      const onBattery = () => options.pollOnBattery?.() ?? options.media?.onBattery() ?? false;

      const mutate = <A, E>(effect: Effect.Effect<A, E>) => Effect.tap(effect, () => changed);
      // Cross-factory callbacks run after the complete mailbox has been constructed.
      const deps: MailboxDependencies = {
        crypto,
        mailboxScope,
        codec,
        files,
        network,
        unsubscribeNetwork,
        verifier,
        store,
        providers,
        secrets,
        config,
        issuers,
        model,
        diskAttachments,
        options,
        backgroundReady,
        readOnly,
        newDraftId,
        parseRawDraft,
        inlineImagesFromRaw,
        inlineMediaFromRaw,
        emit,
        changed,
        mutate,
        imapPullLock,
        onBattery,
        pollInterval,
        resetConnectivity,
        mailbox: () => mailbox,
      };
      const draftsMailbox = makeDraftsMailbox(
        { ...deps, flushLater: Effect.suspend(() => flushMailbox.flushLater) },
        runtime,
      );
      const flushMailbox = makeFlushMailbox(
        { ...deps, pushDraft: (...args) => draftsMailbox.pushDraft(...args) },
        runtime,
      );
      const applyMailbox = makeApplyMailbox(
        {
          ...deps,
          flush: (...args) => flushMailbox.flush(...args),
          organization: () => organization,
          send: (...args) => outboxMailbox.send(...args),
          removeDraft: (...args) => draftsMailbox.removeDraft(...args),
          flushLater: Effect.suspend(() => flushMailbox.flushLater),
        },
        runtime,
      );
      const readingMailbox = makeReadingMailbox(
        { ...deps, cache, organization: () => organization },
        runtime,
      );
      const accountsMailbox = makeAccountsMailbox(
        { ...deps, features: () => features, sync: (...args) => syncMailbox.sync(...args) },
        runtime,
      );
      const syncMailbox = makeSyncMailbox(
        {
          ...deps,
          applyChanges: makeApplyChanges({ ...deps, batchMailbox: () => batchMailbox }),
          organization: () => organization,
          flush: (...args) => flushMailbox.flush(...args),
          features: () => features,
          cache: () => cache,
          enforceCacheBudget: storage.enforceCacheBudget,
        },
        runtime,
      );
      const outboxMailbox = makeOutboxMailbox(
        {
          ...deps,
          prepare: (...args) => draftsMailbox.prepare(...args),
          removeDraft: (...args) => draftsMailbox.removeDraft(...args),
          settleProposal: (...args) => draftsMailbox.settleProposal(...args),
          modify: (...args) => applyMailbox.modify(...args),
          flushLater: Effect.suspend(() => flushMailbox.flushLater),
          persistDraft: (...args) => draftsMailbox.persistDraft(...args),
          discardDraft: (...args) => draftsMailbox.discardDraft(...args),
          draftStatus: (...args) => draftsMailbox.compose.draftStatus(...args),
          saveDraft: (...args) => draftsMailbox.compose.saveDraft(...args),
          openDraft: (...args) => draftsMailbox.compose.openDraft(...args),
        },
        runtime,
      );
      yield* Scope.addFinalizer(mailboxScope, outboxMailbox.finishHeldDiscards);

      const folderMailbox = makeFolderMailbox(store, providers, changed, (effect) =>
        flushMailbox.flushNow.pipe(
          Effect.andThen(
            effect.pipe(runtime.flushLock.withPermits(1), runtime.syncLock.withPermits(1)),
          ),
        ),
      );

      const batchMailbox = yield* makeBatchMailbox(
        store,
        changed,
        FiberSet.run(runtime.background, flushMailbox.flushNow).pipe(Effect.asVoid),
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
        flushMailbox.flushLater,
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
        (accountId, change) =>
          change.kind === "color"
            ? Effect.void
            : options.backgroundFlush === false
              ? syncMailbox.sync(accountId)
              : FiberSet.run(runtime.background, syncMailbox.sync(accountId)),
      );

      const features = makeFeatureMailbox(
        store,
        providers,
        changed,
        applyMailbox.organize.perform,
        options.imageDownloader ?? network.download,
        codec,
        crypto,
      );

      const reserveBytes = yield* makeDownloadBudget;

      const indexInput = {
        reserveBytes,
        store: store.media,
        vision: options.media?.vision ?? unavailableVision,
        onBattery: options.media?.onBattery ?? (() => false),
        busy: Effect.map(
          Ref.get(runtime.syncState),
          (current) => current.running || !(options.media?.idle() ?? true),
        ),
        message: (id) => store.getMessage(id).pipe(Effect.orDie),
        attachment: (id, index) =>
          readingMailbox.reading.attachment(id, index).pipe(Effect.map((part) => part.data)),
        inline: (id) => readingMailbox.localInline(id),
        changed,
        markReauth: (id, error) => store.markReauth(id, error),
      } satisfies import("../ai/indexer.js").IndexerInput;

      const indexer = yield* makeIndexer(indexInput);

      const semantic = options.models
        ? yield* makeSemanticIndexer(indexInput, store, options.models)
        : undefined;

      if (options.media)
        yield* backgroundReady.pipe(
          Effect.andThen(
            indexer.batch().pipe(
              Effect.catchCause(() =>
                logWarning("media-index-failed", "Media indexing batch failed"),
              ),
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

      yield* syncMailbox.start;
      const ai = makeAiMailbox(
        store,
        secrets,
        model,
        () => mailbox,
        changed,
        (ownerId) => store.purgeAccountProposals(ownerId, draftsMailbox.removeDraft),
        options.canTriage,
        options.systemLocale,
        flushMailbox.flushLater,
      );

      // Subscribe before returning. Only opted-in auto-summary accounts can call the model.
      if (options.autoSync)
        yield* Stream.runForEach(Stream.fromPubSub(runtime.pubsub), (event) =>
          event._tag === "NewMail"
            ? Effect.andThen(ai.autoTriage(event.ids), ai.autoSummaries(event.ids))
            : Effect.void,
        ).pipe(Effect.forkScoped);
      yield* outboxMailbox.start;
      const { autoTriage: _autoTriage, autoSummaries: _autoSummaries, ...aiMembers } = ai;
      const { forgetMessages: _forgetMessages, ...batchMembers } = batchMailbox;
      const { searchServer: _searchServer, ...organizationMembers } = organization;
      const { contactGroups, suggestSender, imageFromUrl, imageFromFile, ...calendarFeatures } =
        features;
      const { backfillOlder: _backfillOlder, readerThread: _readerThread, ...cacheMembers } = cache;
      const { enforceCacheBudget: _enforceCacheBudget, ...storageMembers } = storage;
      const groups = {
        reading: readingMailbox.reading,
        organize: {
          ...applyMailbox.organize,
          ...organizationMembers,
          ...batchMembers,
          ...folderMailbox,
        },
        proposals: applyMailbox.proposals,
        compose: {
          ...draftsMailbox.compose,
          ...outboxMailbox.compose,
          ...makeComposeSettingsMailbox(store, mutate),
          contactGroups,
          suggestSender,
          imageFromUrl,
          imageFromFile,
        },
        outbox: { ...outboxMailbox.outbox, ...draftsMailbox.outbox },
        accounts: accountsMailbox.accounts,
        ai: {
          ...aiMembers,
          ...readingMailbox.ai,
          ...makeLocalModelsMailbox(store, indexer, options.models, mutate),
        },
        sync: {
          ...syncMailbox.members,
          ...cacheMembers,
          ...storageMembers,
        } satisfies MailboxSync,
        calendar: { ...calendarFeatures, ...applyMailbox.calendar },
        app: makeAppMailbox({ ...deps, enforceCacheBudget: storage.enforceCacheBudget }, runtime),
      };
      const mailbox = Mailbox.of({
        ...groups.sync,
        reading: groups.reading,
        organize: groups.organize,
        compose: groups.compose,
        outbox: groups.outbox,
        ai: groups.ai,
        calendar: groups.calendar,
        app: groups.app,
        accounts: groups.accounts,
        proposals: groups.proposals,
      });
      return mailbox;
    }),
  );
