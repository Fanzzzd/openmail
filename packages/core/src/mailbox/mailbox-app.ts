import { Clock, Effect, Stream } from "effect";
import { normalizeRemoteAccess } from "../app/remote-access.js";
import {
  checkVerifiedUpdates,
  LEGACY_UPDATE_TOKEN_KEY,
  startVerifiedUpdates,
} from "../app/updates.js";
import { diagnosticsState } from "../domain/diagnostics-state.js";
import type { MailboxDependencies, MailboxRuntimeState } from "./mailbox-runtime.js";
import { cacheIO } from "./mailbox-shared.js";
import type { MailboxApp } from "./mailbox.js";

/** Settings, notifications, diagnostics, updates, remote access and the event stream. */
export const makeAppMailbox = (
  deps: MailboxDependencies & {
    enforceCacheBudget: (force?: boolean) => Effect.Effect<void>;
  },
  runtime: MailboxRuntimeState,
) => {
  const { store, secrets, verifier, diskAttachments, emit, mutate, enforceCacheBudget } = deps;
  return {
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
              ? enforceCacheBudget(true)
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

    rememberNotificationActions: (id, actions) => store.rememberNotificationActions(id, actions),

    notificationActions: (id) => store.notificationActions(id),

    takeNotifications: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => store.takeNotifications(now)),
    ),

    diagnosticsState: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const counts = yield* store.diagnosticCounts(now);
      return diagnosticsState({ ...counts, accounts: yield* store.listAccounts, now });
    }),

    remoteAccess: store.remoteAccess,

    setRemoteAccess: (input) =>
      normalizeRemoteAccess(input).pipe(Effect.tap((settings) => store.setRemoteAccess(settings))),

    checkUpdates: (client, updateOptions) =>
      Effect.flatMap(store.prefs, (prefs) =>
        checkVerifiedUpdates(
          client,
          {
            ...updateOptions,
            channel: prefs.updateChannel,
            autoDownload: updateOptions.autoDownload ?? prefs.updateAutoDownload,
          },
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

    startUpdates: (client, updateOptions) =>
      Effect.gen(function* () {
        // Builds from the private repo kept a GitHub token; delete it once, missing or not.
        if (yield* store.claimOnce("updates:legacy-token-removed"))
          yield* secrets.remove(LEGACY_UPDATE_TOKEN_KEY).pipe(Effect.catchCause(() => Effect.void));
        const prefs = yield* store.prefs;
        return yield* startVerifiedUpdates(
          client,
          {
            ...updateOptions,
            channel: prefs.updateChannel,
            autoDownload: updateOptions.autoDownload ?? prefs.updateAutoDownload,
          },
          verifier.verify,
        );
      }),

    events: Stream.fromPubSub(runtime.pubsub),
  } satisfies Omit<MailboxApp, "host">;
};
