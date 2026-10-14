import { CacheMaintenance } from "../platform/cache-storage.js";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import { DatabaseCapabilities } from "../db/capabilities.js";
import { PlatformCrypto } from "../platform/crypto.js";
import { Store } from "./service.js";
import { makeAccountsStore } from "./store-accounts.js";
import { makeAiStore } from "./store-ai.js";
import { makeCacheStore } from "./store-cache.js";
import { makeComposeStore } from "./store-compose.js";
import { makeContactStore } from "./store-contacts.js";
import { makeDiagnosticsStore } from "./store-diagnostics.js";
import { makeHeaderBackfillStore } from "./store-header-backfill.js";
import { makeInviteStatusStore } from "./store-invite-status.js";
import { makeMediaStore } from "./store-media.js";
import { makeMessagesStore } from "./store-messages.js";
import { makeNotificationsStore } from "./store-notifications.js";
import { makeOpQueueStore } from "./store-opqueue.js";
import { makeOrganizationStore } from "./store-organization.js";
import { makePolicyStore } from "./store-policy.js";
import { makeQueryStore } from "./store-query.js";
import { makeRemindersStore } from "./store-reminders.js";
import { makeSemanticStore } from "./store-semantic.js";
import { makeServiceStore } from "./store-services.js";
import { makeSignatureStore } from "./store-signatures.js";
import { makeSyncHealthStore } from "./store-sync-health.js";
import { makeThreadsStore } from "./store-threads.js";
import { makeWordIndexStore } from "./store-word-index.js";
import { makeUndoStore } from "../mailbox/undo-journal.js";
export { applyOpToLabels, folderTarget } from "../domain/mail-ops.js";
export { accountId } from "./store-rows.js";
/**
 * The Store service over SQLite. The only module that runs SQL. Rows are
 * decoded with schemas built from the domain types (this is the IO boundary);
 * SQL and decode failures die, since they mean a bug or a corrupt file.
 */
export const StoreLive: Layer.Layer<Store, never, SqlClient.SqlClient> = Layer.effect(
  Store,
  Effect.gen(function* () {
    const crypto = yield* PlatformCrypto;

    const sql = yield* SqlClient.SqlClient;

    const cache = makeCacheStore(sql, yield* CacheMaintenance);

    const compose = makeComposeStore(sql, crypto);
    const {
      localDrafts: _localDrafts,
      countLocalDrafts: _countLocalDrafts,
      ...composeService
    } = compose;

    const signatureLibrary = makeSignatureStore(sql, crypto);

    const capabilities = yield* Effect.serviceOption(DatabaseCapabilities);

    const vectors = Option.isSome(capabilities) && capabilities.value.vectors;

    const media = makeMediaStore(sql, vectors, "derived_jobs", crypto);

    const contacts = makeContactStore(sql);

    const organization = makeOrganizationStore(sql);

    const wordIndex = makeWordIndexStore(sql);
    const query = makeQueryStore({ sql });
    const policy = makePolicyStore({ sql, compose });
    const accounts = makeAccountsStore({
      sql,
      crypto,
      media,
      purgeAccountProposals: policy.service.purgeAccountProposals,
    });
    const messages = yield* makeMessagesStore({
      sql,
      crypto,
      compose,
      media,
      contacts,
      getAccount: accounts.getAccount,
      hasLabel: query.hasLabel,
      imapFolder: query.imapFolder,
      outsideKeep: query.outsideKeep,
    });
    const threads = makeThreadsStore({
      sql,
      compose,
      wordIndex,
      hasLabel: query.hasLabel,
      textFilter: query.textFilter,
      listFilter: query.listFilter,
      listSource: query.listSource,
      searchDrivenList: query.searchDrivenList,
      planTextPage: query.planTextPage,
    });
    const reminders = makeRemindersStore({
      sql,
      getAccount: accounts.getAccount,
      getMessage: messages.getMessage,
      getThread: messages.getThread,
      messageRef: messages.messageRef,
      hasLabel: query.hasLabel,
    });
    const opqueue = makeOpQueueStore({ sql });
    const notifications = makeNotificationsStore({
      sql,
      compose,
      listAccounts: accounts.listAccounts,
    });
    const semantics = makeSemanticStore(
      sql,
      vectors,
      (q) => {
        const { attachmentText: _scope, ...criteria } = q.criteria ?? {};
        return query.listFilter({ ...q, search: "", criteria });
      },
      crypto,
    );

    yield* policy.initialize;

    return Store.of({
      ...composeService,
      ai: makeAiStore(sql),
      ...cache,
      ...organization,
      transaction: (effect) =>
        sql.withTransaction(effect).pipe(Effect.catchIf(isSqlError, (e) => Effect.die(e))),
      ...makeSyncHealthStore(sql),
      ...makeDiagnosticsStore(sql),
      ...makeServiceStore(sql),
      media,
      semantics,
      ...makeHeaderBackfillStore(sql),
      ...wordIndex,
      ...makeInviteStatusStore(sql),
      ...signatureLibrary,
      ...makeUndoStore(sql),
      ...contacts,
      ...accounts,
      ...messages,
      ...threads,
      ...opqueue,
      ...policy.service,
      ...reminders,
      ...notifications,
    });
  }),
);
