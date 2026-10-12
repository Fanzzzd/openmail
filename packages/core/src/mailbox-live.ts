import { normalizeRemoteAccess } from "./remote-access.js";
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
  Semaphore,
  Stream,
} from "effect";
import {
  inlineImagesFromRaw as unboundInlineImagesFromRaw,
  inlineMediaFromRaw as unboundInlineMediaFromRaw,
} from "./attachments.js";
import { makeDownloadBudget } from "./download-budget.js";
import { parseRawDraft as unboundParseRawDraft } from "./drafts.js";
import { InvalidInput } from "./errors.js";
import { makeIndexer } from "./indexer.js";
import { makeAccountsMailbox } from "./mailbox-accounts.js";
import { makeAiMailbox } from "./mailbox-ai.js";
import { makeApplyMailbox } from "./mailbox-apply.js";
import { makeBatchMailbox } from "./mailbox-batch.js";
import { makeCacheMailbox } from "./mailbox-cache.js";
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
import { makeOptionalServiceMailbox } from "./mailbox-services.js";
import { cacheIO } from "./mailbox-shared.js";
import { makeSyncMailbox } from "./mailbox-sync.js";
import { Mailbox, type MailboxEvent } from "./mailbox.js";
import { unavailableVision } from "./media.js";
import { Model, ModelUnavailable } from "./model.js";
import { scopedAdapter } from "./optional-services.js";
import { destination as outlookDestination } from "./outlook/graph.js";
import { PlatformCrypto } from "./platform/crypto.js";
import { MailCodec } from "./platform/mail-codec.js";
import { AppVerifier, AttachmentFiles, ImageNetwork, type PdfWorker } from "./platform/runtime.js";
import { readOnlyAdapter } from "./read-only.js";
import { makeSemanticIndexer } from "./semantic-indexer.js";
import { AppConfig, OAuthIssuers, Providers, Secrets, Store } from "./services.js";
import { makeSyncHealth } from "./sync-health.js";
import { UnsubscribeNetwork } from "./unsubscribe.js";
import { checkStoredUpdates, startStoredUpdates, UPDATE_TOKEN_KEY } from "./updates.js";

const DEFAULT_SUGGESTIONS = 8;

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

      const rawProviders = yield* Providers;

      const providers = Providers.of({
        get: (provider) => {
          const cached = runtime.adapters.get(provider);
          if (cached) return cached;
          const scoped = scopedAdapter(rawProviders.get(provider), store);
          const adapter = readOnly ? readOnlyAdapter(scoped) : scoped;
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
        for (const step of [store.backfillWordIndex(), store.backfillSearchFlags()]) {
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
          batchMailbox: () => batchMailbox,
        },
        runtime,
      );
      const readingMailbox = makeReadingMailbox(deps, runtime);
      const accountsMailbox = makeAccountsMailbox(
        { ...deps, features: () => features, sync: (...args) => syncMailbox.sync(...args) },
        runtime,
      );
      const syncMailbox = makeSyncMailbox(
        {
          ...deps,
          applyChanges: (...args) => applyMailbox.applyChanges(...args),
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
        },
        runtime,
      );

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
      );

      const features = makeFeatureMailbox(
        store,
        providers,
        changed,
        applyMailbox.service.perform,
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
          readingMailbox.service.attachment(id, index).pipe(Effect.map((part) => part.data)),
        inline: (id) => readingMailbox.localInline(id),
        changed,
        markReauth: (id, error) => store.markReauth(id, error),
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

      yield* syncMailbox.start;
      const ai = makeAiMailbox(
        store,
        secrets,
        model,
        () => mailbox,
        changed,
        (ownerId) => store.purgeAccountProposals(ownerId, draftsMailbox.removeDraft),
        options.canTriage,
      );

      // Subscribe before returning. Only opted-in auto-summary accounts can call the model.
      if (options.autoSync)
        yield* Stream.runForEach(Stream.fromPubSub(runtime.pubsub), (event) =>
          event._tag === "NewMail"
            ? Effect.andThen(ai.autoTriage(event.ids), ai.autoSummaries(event.ids))
            : Effect.void,
        ).pipe(Effect.forkScoped);
      yield* outboxMailbox.start;
      const mailbox = Mailbox.of({
        ...ai,
        setAiAccount: (input) =>
          ai.setAiAccount(input).pipe(Effect.andThen(flushMailbox.flushLater)),

        updateTokenConfigured: secrets.get(UPDATE_TOKEN_KEY).pipe(Effect.map(Option.isSome)),

        setUpdateToken: (token) =>
          Effect.gen(function* () {
            const trimmed = token.trim();
            if (trimmed.length > 4096 || /[\r\n]/.test(trimmed))
              yield* new InvalidInput({ message: "Enter a single access token" });
            yield* (
              trimmed ? secrets.set(UPDATE_TOKEN_KEY, trimmed) : secrets.remove(UPDATE_TOKEN_KEY)
            ).pipe(
              Effect.mapError(
                () =>
                  new InvalidInput({ message: "Could not save the token in the system keychain." }),
              ),
            );
            yield* emit({ _tag: "UpdateSettingsChanged", resetState: true });
          }),

        remoteAccess: store.remoteAccess,
        setRemoteAccess: (input) =>
          normalizeRemoteAccess(input).pipe(
            Effect.tap((settings) => store.setRemoteAccess(settings)),
          ),

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

        cacheDatabaseSize: storage.cacheDatabaseSize,
        compactCache: storage.compactCache,

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
            runtime.attachmentEpoch++;
            runtime.attachmentCache.clear();
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
            .pipe(Effect.tap(() => FiberSet.run(runtime.background, cache.fetchOlder(query)))),

        changeLabel: (accountId, change) =>
          organization
            .changeLabel(accountId, change)
            .pipe(
              Effect.tap(() =>
                change.kind === "color"
                  ? Effect.void
                  : options.backgroundFlush === false
                    ? syncMailbox.sync(accountId).pipe(Effect.asVoid)
                    : FiberSet.run(runtime.background, syncMailbox.sync(accountId)).pipe(
                        Effect.asVoid,
                      ),
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

        prefs: store.prefs,

        setPrefs: (patch) =>
          Effect.gen(function* () {
            const previous = yield* store.prefs;
            const resetState =
              patch.updateChannel !== undefined && patch.updateChannel !== previous.updateChannel;
            return yield* mutate(store.setPrefs(patch)).pipe(
              Effect.tap(() =>
                (patch.bodyCacheBytes !== undefined &&
                  patch.bodyCacheBytes !== previous.bodyCacheBytes) ||
                (patch.totalCacheBytes !== undefined &&
                  patch.totalCacheBytes !== previous.totalCacheBytes)
                  ? storage.enforceCacheBudget(true)
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
        ...draftsMailbox.service,
        ...applyMailbox.service,
        ...readingMailbox.service,
        ...syncMailbox.service,
        ...accountsMailbox.service,
        ...outboxMailbox.service,
      });
      return mailbox;
    }),
  );
