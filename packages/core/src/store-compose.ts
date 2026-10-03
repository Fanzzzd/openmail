import { makeOutboxStore } from "./mobile-outbox.js";
import { PlatformCrypto } from "./platform/crypto.js";
import { makeSignatureStore } from "./store-signatures.js";
import { signatureDefault } from "./signatures.js";
import { attachmentFilename } from "./attachment-filename.js";
/**
 * The Store's SQL for writing and reading settings: drafts, preferences,
 * signatures, templates, recipient suggestions and the remote image allowlist. Part of the Store service (store.ts
 * spreads these into it); split out to keep each file readable.
 */
import { Clock, Context, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fragment } from "effect/sql/Statement";

import {
  Address,
  DEFAULT_PREFS,
  type DraftRemote,
  DraftCreateState,
  OutgoingMessage,
  Prefs,
  ToolbarAction,
  type Signature,
  SignatureKind,
  type Template,
  type TemplateInput,
  type ThreadQuery,
  type ThreadSummary,
} from "./domain.js";
import { NotFound } from "./errors.js";
import { imageSenderKey } from "./reading.js";
import { richComposeBody, textComposeHtml, normalizeComposeMessage } from "./compose-body.js";
import type { StoredDraft } from "./services.js";
import { all, first, run } from "./sql-rows.js";

const DraftRow = Schema.Struct({
  id: Schema.String,
  account_id: Schema.String,
  message_json: Schema.fromJsonString(OutgoingMessage),
  updated_at: Schema.Number,
  proposal_id: Schema.NullOr(Schema.Number),
  remote_draft_id: Schema.NullOr(Schema.String),
  remote_message_id: Schema.NullOr(Schema.String),
  pushed_attachments: Schema.NullOr(Schema.String),
  pushed_organization: Schema.NullOr(Schema.String),
  sync_error: Schema.NullOr(Schema.String),
  local_only: Schema.BooleanFromBit,
  remote_json: Schema.NullOr(
    Schema.fromJsonString(
      Schema.Struct({
        changeKey: Schema.optionalKey(Schema.String),
        lastWrittenAt: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
});

const LocalDraftRow = Schema.Struct({
  ...DraftRow.fields,
  email: Schema.String,
});

const PrefRow = Schema.Struct({ key: Schema.String, value_json: Schema.String });
const SignatureRow = Schema.Struct({
  address: Schema.String,
  kind: SignatureKind,
  text: Schema.String,
});
const TemplateRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  subject: Schema.String,
  to_json: Schema.fromJsonString(Schema.Array(Address)),
  cc_json: Schema.fromJsonString(Schema.Array(Address)),
  bcc_json: Schema.fromJsonString(Schema.Array(Address)),
  body: Schema.String,
  updated_at: Schema.Number,
});
const ContactRow = Schema.Struct({ address: Schema.String, name: Schema.NullOr(Schema.String) });
const AddressRow = Schema.Struct({ address: Schema.String });
const IdRow = Schema.Struct({ id: Schema.String });
const EntryRow = Schema.Struct({ entry: Schema.String });

function toStoredDraft(r: typeof DraftRow.Type): StoredDraft {
  const remote: DraftRemote | null =
    r.remote_draft_id === null && r.remote_message_id === null
      ? null
      : { ...r.remote_json, draftId: r.remote_draft_id, messageId: r.remote_message_id };
  return {
    id: r.id,
    accountId: r.account_id,
    message: normalizeComposeMessage(r.message_json),
    updatedAt: r.updated_at,
    proposalId: r.proposal_id,
    remote,
    pushedAttachments: r.pushed_attachments,
    pushedOrganization: r.pushed_organization,
    syncError: r.sync_error,
    localOnly: r.local_only,
  };
}

function toTemplate(r: typeof TemplateRow.Type): Template {
  return {
    id: r.id,
    name: r.name,
    subject: r.subject,
    to: r.to_json,
    cc: r.cc_json,
    bcc: r.bcc_json,
    body: r.body,
    updatedAt: r.updated_at,
  };
}

/** One stored preference, or the default when it is missing or no longer valid. */
function pref<A, I>(schema: Schema.Codec<A, I>, raw: string | undefined, fallback: A): A {
  if (raw === undefined) return fallback;
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.fromJsonString(schema))(raw),
    () => fallback,
  );
}

function storedValue<A, I>(schema: Schema.Codec<A, I>, value: unknown, fallback: A): A {
  return Option.getOrElse(Schema.decodeUnknownOption(schema)(value), () => fallback);
}

/** Suggestions lose half their weight after this many milliseconds (30 days). */
const MONTH = 30 * 86_400_000;

/** Shared by completion and its SQLite query-plan regression check. */
export function contactMatch(sql: SqlClient.SqlClient, match: string): Fragment {
  return sql`c.rowid IN (
    SELECT rowid FROM contact_candidates_fts WHERE contact_candidates_fts MATCH ${match}
    UNION ALL
    SELECT cc.rowid FROM (
      SELECT account_id,address FROM contact_organizations WHERE rowid IN (
        SELECT rowid FROM contact_organizations_fts WHERE contact_organizations_fts MATCH ${match}
      )
    ) o CROSS JOIN contact_candidates cc ON cc.address=o.address AND cc.account_id=o.account_id
  )`;
}

export function makeComposeStore(
  sql: SqlClient.SqlClient,
  crypto: PlatformCrypto = Context.get(Context.empty(), PlatformCrypto),
) {
  const DRAFT_COLUMNS = sql.literal(`d.id, d.account_id, d.message_json, d.updated_at,
    d.proposal_id, d.remote_draft_id, d.remote_message_id, d.pushed_attachments, d.pushed_organization, d.sync_error, d.local_only,
    (SELECT value_json FROM prefs WHERE key='draft-remote:' || d.id) AS remote_json`);

  // A queued push of one draft, found by the draft id inside the op.
  const saveOpFor = (draftId: Fragment | string) =>
    sql`json_extract(op_json, '$.kind') = 'saveDraft'
      AND json_extract(op_json, '$.draftId') = ${draftId}`;

  const draftWhere = (where: Fragment) =>
    first(DraftRow)(sql`SELECT ${DRAFT_COLUMNS} FROM drafts d WHERE ${where}`).pipe(
      Effect.map(Option.map(toStoredDraft)),
    );

  const getDraft = Effect.fn("Store.getDraft")((id: string) => draftWhere(sql`d.id = ${id}`));

  const draftByRemoteMessage = Effect.fn("Store.draftByRemoteMessage")(
    (accountId: string, messageId: string) =>
      draftWhere(sql`d.account_id = ${accountId} AND d.remote_message_id = ${messageId}`),
  );

  const draftByProposal = Effect.fn("Store.draftByProposal")((proposalId: number) =>
    draftWhere(sql`d.proposal_id = ${proposalId}`),
  );

  const putDraft = Effect.fn("Store.putDraft")(function* (draft: {
    id: string;
    accountId: string;
    message: OutgoingMessage;
    proposalId?: number | null;
  }) {
    const now = yield* Clock.currentTimeMillis;
    yield* run(sql`INSERT INTO drafts (id, account_id, message_json, updated_at, proposal_id)
      VALUES (${draft.id}, ${draft.accountId}, ${JSON.stringify(draft.message)}, ${now},
        ${draft.proposalId ?? null})
      ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id,
        message_json = excluded.message_json, updated_at = excluded.updated_at,
        proposal_id = COALESCE(excluded.proposal_id, drafts.proposal_id),
        pushed_organization = CASE WHEN drafts.account_id = excluded.account_id THEN drafts.pushed_organization ELSE NULL END`);
    const saved = yield* getDraft(draft.id);
    if (Option.isNone(saved)) return yield* Effect.die("A draft just written is missing");
    return saved.value;
  });

  const setDraftRemote = Effect.fn("Store.setDraftRemote")(
    function* (
      id: string,
      remote: DraftRemote | null,
      pushedAttachments: string | null,
      accountId?: string,
      claim?: { readonly id: number; readonly token: string },
    ) {
      const row = yield* first(IdRow)(sql`UPDATE drafts SET
        remote_draft_id = ${remote?.draftId ?? null},
        remote_message_id = ${remote?.messageId ?? null},
        pushed_attachments = ${pushedAttachments}, sync_error=CASE WHEN local_only=0 THEN NULL ELSE sync_error END
      WHERE id = ${id} ${claim === undefined ? sql.literal("") : sql`AND EXISTS(SELECT 1 FROM pending_ops WHERE id=${claim.id} AND claim_token=${claim.token})`} ${accountId === undefined ? sql.literal("") : sql`AND account_id=${accountId}`} RETURNING id`);
      if (Option.isSome(row)) {
        yield* remote
          ? run(
              sql`INSERT INTO prefs(key,value_json) VALUES(${`draft-remote:${id}`},${JSON.stringify({ changeKey: remote.changeKey, lastWrittenAt: remote.lastWrittenAt })}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
            )
          : run(sql`DELETE FROM prefs WHERE key=${`draft-remote:${id}`}`);
      }
      return Option.isSome(row);
    },
    (effect) => sql.withTransaction(effect).pipe(Effect.orDie),
  );

  const draftCreateState = (id: string) =>
    first(Schema.Struct({ value_json: Schema.fromJsonString(DraftCreateState) }))(
      sql`SELECT value_json FROM prefs WHERE key=${`draft-create:${id}`}`,
    ).pipe(Effect.map(Option.map((row) => row.value_json)));
  const setDraftCreateState = (id: string, state: DraftCreateState | null) =>
    state
      ? run(
          sql`INSERT INTO prefs(key,value_json) VALUES(${`draft-create:${id}`},${JSON.stringify(state)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
        )
      : run(sql`DELETE FROM prefs WHERE key=${`draft-create:${id}`}`);

  const setDraftOrganizationKey = (id: string, key: string | null) =>
    run(sql`UPDATE drafts SET pushed_organization = ${key} WHERE id = ${id}`);

  const WaitingDraftSave = Schema.Struct({
    account_id: Schema.String,
    appended_message_id: Schema.NullOr(Schema.String),
    progress_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  });
  const waitingDraftSaves = (id: string) =>
    all(WaitingDraftSave)(
      sql`SELECT account_id,appended_message_id,progress_json FROM pending_ops WHERE claimed_at IS NULL AND ${saveOpFor(id)} ORDER BY id DESC`,
    );
  const enqueueAppendedCleanup = Effect.fnUntraced(function* (
    id: string,
    rows: readonly (typeof WaitingDraftSave.Type)[],
    keep?: { accountId: string; messageId: string | null },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const seen = new Set<string>();
    for (const row of rows) {
      const messageId = row.appended_message_id;
      if (!messageId || (row.account_id === keep?.accountId && messageId === keep.messageId))
        continue;
      const key = JSON.stringify([row.account_id, messageId]);
      if (seen.has(key)) continue;
      seen.add(key);
      const op = {
        kind: "deleteDraft",
        remote: { draftId: null, messageId: null, rfcMessageId: messageId },
      };
      yield* run(
        sql`INSERT INTO pending_ops(account_id,provider_id,op_json,created_at) VALUES(${row.account_id},${id},${JSON.stringify(op)},${now})`,
      );
    }
  });
  const deleteDraft = Effect.fn("Store.deleteDraft")((id: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const creation = yield* first(
            Schema.Struct({
              account_id: Schema.String,
              state: Schema.fromJsonString(DraftCreateState),
            }),
          )(
            sql`SELECT d.account_id,p.value_json AS state FROM drafts d JOIN prefs p ON p.key=${`draft-create:${id}`} WHERE d.id=${id}`,
          );
          const uncertain =
            Option.isSome(creation) && creation.value.state.attempted
              ? [
                  {
                    account_id: creation.value.account_id,
                    appended_message_id: creation.value.state.messageId,
                    progress_json: [],
                  },
                ]
              : [];
          yield* enqueueAppendedCleanup(id, [...(yield* waitingDraftSaves(id)), ...uncertain]);
          yield* setDraftCreateState(id, null);
          yield* run(sql`DELETE FROM prefs WHERE key=${`draft-remote:${id}`}`);
          yield* run(sql`DELETE FROM prefs WHERE key=${`send-uncertain:${id}`}`);
          yield* run(sql`DELETE FROM drafts WHERE id=${id}`);
          // A push already running finds the draft gone and cleans its newly created copy.
          yield* run(sql`DELETE FROM pending_ops WHERE claimed_at IS NULL AND ${saveOpFor(id)}`);
        }),
      )
      .pipe(Effect.orDie),
  );

  const enqueueDraftSave = Effect.fn("Store.enqueueDraftSave")(
    (accountId: string, draftId: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const draft = yield* getDraft(draftId);
            if (Option.isNone(draft) || draft.value.localOnly) return;
            const waiting = yield* waitingDraftSaves(draftId);
            const sameAccount = waiting.filter((row) => row.account_id === accountId);
            const messageId =
              sameAccount.find((row) => row.appended_message_id !== null)?.appended_message_id ??
              null;
            const progress = [...new Set(sameAccount.flatMap((row) => row.progress_json))];
            yield* enqueueAppendedCleanup(draftId, waiting, { accountId, messageId });
            yield* run(
              sql`DELETE FROM pending_ops WHERE claimed_at IS NULL AND ${saveOpFor(draftId)}`,
            );
            yield* run(sql`INSERT INTO pending_ops(account_id,provider_id,op_json,created_at,appended_message_id,progress_json)
      VALUES(${accountId},${draftId},${JSON.stringify({ kind: "saveDraft", draftId })},${now},${messageId},${JSON.stringify(progress)})`);
          }),
        )
        .pipe(Effect.orDie),
  );

  const dropSyncedDrafts = Effect.fn("Store.dropSyncedDrafts")(
    (accountId: string, messageId?: string) =>
      run(sql`DELETE FROM drafts WHERE account_id = ${accountId}
        AND remote_message_id IS NOT NULL AND local_only=0 AND sync_error IS NULL
        ${messageId === undefined ? sql.literal("") : sql`AND remote_message_id = ${messageId}`}
        AND NOT EXISTS (SELECT 1 FROM pending_ops WHERE ${saveOpFor(sql.literal("drafts.id"))})`),
  );

  /**
   * Drafts the Drafts list cannot show from `messages`: never pushed, or
   * pushed but not pulled back yet. Newest first, as thread rows.
   */
  const localDraftFilter = (q: ThreadQuery) => {
    const where: Fragment[] = [
      sql`(d.remote_message_id IS NULL OR NOT EXISTS (SELECT 1 FROM messages m
        WHERE m.account_id = d.account_id AND m.provider_id = d.remote_message_id))`,
    ];
    if (q.accountIds) {
      where.push(
        q.accountIds.length ? sql`d.account_id IN ${sql.in(q.accountIds)}` : sql.literal("0"),
      );
    }
    if (q.before !== undefined)
      where.push(
        sql`(d.updated_at < ${q.before} ${q.beforeId === undefined ? sql.literal("") : sql`OR (d.updated_at = ${q.before} AND d.id < ${q.beforeId})`})`,
      );
    return sql.and(where);
  };
  const countLocalDrafts = (accountIds?: readonly string[]) =>
    all(Schema.Struct({ n: Schema.Number }))(sql`SELECT COUNT(*) AS n FROM drafts d
      JOIN accounts a ON a.id=d.account_id WHERE a.enabled=1 AND ${localDraftFilter({ accountIds })}`).pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
    );
  const localDrafts = (q: ThreadQuery, limit: number) => {
    return all(LocalDraftRow)(sql`SELECT ${DRAFT_COLUMNS}, a.email FROM drafts d
      JOIN accounts a ON a.id = d.account_id
      WHERE a.enabled=1 AND ${localDraftFilter(q)} ORDER BY d.updated_at DESC, d.id DESC LIMIT ${limit}`).pipe(
      Effect.map((rows) =>
        rows.map((r): ThreadSummary => {
          const me = { name: "", address: r.email };
          const m = r.message_json;
          return {
            id: r.id,
            accountId: r.account_id,
            threadId: r.id,
            subject: m.subject,
            from: me,
            date: r.updated_at,
            snippet: m.text.replace(/\s+/g, " ").trim().slice(0, 200),
            labels: [
              "DRAFT",
              ...(m.draftOrganization?.labels ?? []),
              ...(m.draftOrganization?.starred ? ["STARRED"] : []),
            ],
            isUnread: false,
            isStarred: m.draftOrganization?.starred ?? false,
            hasAttachments: m.attachments.length > 0 || m.forwardAsAttachment === true,
            ...(m.attachments.length
              ? {
                  attachmentNames: m.attachments
                    .slice(0, 2)
                    .map((a) => attachmentFilename(a.filename)),
                }
              : {}),
            threadCount: 1,
            participants: [me],
          };
        }),
      ),
    );
  };

  const draftSaveState = (id: string) =>
    first(Schema.Struct({ pending: Schema.BooleanFromBit, retrying: Schema.BooleanFromBit }))(sql`
    WITH state AS (SELECT EXISTS(SELECT 1 FROM pending_ops WHERE ${saveOpFor(sql.literal("d.id"))}) AS pending,
      a.enabled=1 AND a.needs_reauth=0 AND d.local_only=0 AS active FROM drafts d JOIN accounts a ON a.id=d.account_id WHERE d.id=${id})
    SELECT pending,pending AND active AS retrying FROM state`).pipe(
      Effect.map(Option.getOrElse(() => ({ pending: false, retrying: false }))),
    );

  const setDraftSyncError = (id: string, error: string | null) =>
    run(sql`UPDATE drafts SET sync_error=${error} WHERE id=${id} AND local_only=0`);
  const setDraftLocalOnly = (id: string, localOnly: boolean) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* run(
            sql`UPDATE drafts SET local_only=${Number(localOnly)},sync_error=NULL WHERE id=${id}`,
          );
          if (localOnly) {
            yield* enqueueAppendedCleanup(id, yield* waitingDraftSaves(id));
            yield* run(sql`DELETE FROM prefs WHERE key=${`draft-remote:${id}`}`);
            yield* run(sql`DELETE FROM pending_ops WHERE claimed_at IS NULL AND ${saveOpFor(id)}`);
          }
        }),
      )
      .pipe(Effect.orDie);

  // Preferences

  const prefs = all(PrefRow)(
    sql`SELECT key, value_json FROM prefs WHERE key NOT LIKE 'mobile-outbox:%' AND key NOT LIKE 'mobile-background:%'`,
  ).pipe(
    Effect.map((rows): Prefs => {
      const stored = new Map(rows.map((r) => [r.key, r.value_json]));
      const f = Prefs.fields;
      const d = DEFAULT_PREFS;
      // Older builds stored a boolean; true loaded remote images in every message.
      const remoteImages = pref(
        Schema.Union([f.remoteImages, Schema.Boolean]),
        stored.get("remoteImages"),
        d.remoteImages,
      );
      const labs = pref(Schema.Record(Schema.String, Schema.Unknown), stored.get("labs"), {});
      const swipes = pref(
        Schema.Record(Schema.String, Schema.Unknown),
        stored.get("swipeActions"),
        {},
      );
      return {
        spellcheck: pref(f.spellcheck, stored.get("spellcheck"), d.spellcheck),
        spellcheckLanguages: pref(
          f.spellcheckLanguages,
          stored.get("spellcheckLanguages"),
          d.spellcheckLanguages,
        ),
        defaultProfilesPrompted: pref(
          f.defaultProfilesPrompted,
          stored.get("defaultProfilesPrompted"),
          d.defaultProfilesPrompted,
        ),
        bodyCacheBytes: pref(f.bodyCacheBytes, stored.get("bodyCacheBytes"), d.bodyCacheBytes),
        attachmentCacheBytes: pref(
          f.attachmentCacheBytes,
          stored.get("attachmentCacheBytes"),
          d.attachmentCacheBytes,
        ),
        signaturePosition: pref(
          f.signaturePosition,
          stored.get("signaturePosition"),
          d.signaturePosition,
        ),
        signatureSeparator: pref(
          f.signatureSeparator,
          stored.get("signatureSeparator"),
          d.signatureSeparator,
        ),
        signatureOrder: pref(f.signatureOrder, stored.get("signatureOrder"), d.signatureOrder),
        contactPhotos: pref(f.contactPhotos, stored.get("contactPhotos"), d.contactPhotos),
        useAppleContacts: pref(
          f.useAppleContacts,
          stored.get("useAppleContacts"),
          d.useAppleContacts,
        ),
        composeFormatBar: pref(
          f.composeFormatBar,
          stored.get("composeFormatBar"),
          d.composeFormatBar,
        ),
        composeMarkdownReplacement: pref(
          f.composeMarkdownReplacement,
          stored.get("composeMarkdownReplacement"),
          d.composeMarkdownReplacement,
        ),
        composeSmartLists: pref(
          f.composeSmartLists,
          stored.get("composeSmartLists"),
          d.composeSmartLists,
        ),
        emojiReplacement: pref(
          f.emojiReplacement,
          stored.get("emojiReplacement"),
          d.emojiReplacement,
        ),
        inlineImageSize: pref(f.inlineImageSize, stored.get("inlineImageSize"), d.inlineImageSize),
        composeFont: pref(f.composeFont, stored.get("composeFont"), d.composeFont),
        updateChannel: pref(f.updateChannel, stored.get("updateChannel"), d.updateChannel),
        updateAutoDownload: pref(
          f.updateAutoDownload,
          stored.get("updateAutoDownload"),
          d.updateAutoDownload,
        ),
        labs: {
          markdown: storedValue(f.labs.fields.markdown, labs.markdown, d.labs.markdown),
          calendarDetection: storedValue(
            f.labs.fields.calendarDetection,
            labs.calendarDetection,
            d.labs.calendarDetection,
          ),
        },
        swipeActions: {
          leftShort: storedValue(
            f.swipeActions.fields.leftShort,
            swipes.leftShort,
            d.swipeActions.leftShort,
          ),
          leftLong: storedValue(
            f.swipeActions.fields.leftLong,
            swipes.leftLong,
            d.swipeActions.leftLong,
          ),
          rightShort: storedValue(
            f.swipeActions.fields.rightShort,
            swipes.rightShort,
            d.swipeActions.rightShort,
          ),
          rightLong: storedValue(
            f.swipeActions.fields.rightLong,
            swipes.rightLong,
            d.swipeActions.rightLong,
          ),
        },
        toolbarActions: [
          ...new Set(
            pref(
              Schema.Array(Schema.Unknown),
              stored.get("toolbarActions"),
              d.toolbarActions,
            ).flatMap((item) => {
              const decoded = Schema.decodeUnknownOption(ToolbarAction)(item);
              return Option.isSome(decoded) ? [decoded.value] : [];
            }),
          ),
        ],
        messageListDensity: pref(
          f.messageListDensity,
          stored.get("messageListDensity"),
          d.messageListDensity,
        ),
        specialFolderBadges: pref(
          f.specialFolderBadges,
          stored.get("specialFolderBadges"),
          d.specialFolderBadges,
        ),
        showMore: pref(f.showMore, stored.get("showMore"), d.showMore),
        remoteImages: remoteImages === true ? "always" : remoteImages || "ask",
        cleanLinks: pref(Schema.Boolean, stored.get("cleanLinks"), true),
        undoSendSeconds: pref(f.undoSendSeconds, stored.get("undoSendSeconds"), d.undoSendSeconds),
        replyFrom: pref(f.replyFrom, stored.get("replyFrom"), d.replyFrom),
        quoteSelection: pref(f.quoteSelection, stored.get("quoteSelection"), d.quoteSelection),
        defaultFrom: pref(f.defaultFrom, stored.get("defaultFrom"), d.defaultFrom),
        showFullRecipientAddresses: pref(
          f.showFullRecipientAddresses,
          stored.get("showFullRecipientAddresses"),
          d.showFullRecipientAddresses,
        ),
        language: pref(f.language, stored.get("language"), d.language),
        markReadDelay: pref(f.markReadDelay, stored.get("markReadDelay"), d.markReadDelay),
        nextSelection: pref(f.nextSelection, stored.get("nextSelection"), d.nextSelection),
        deleteKeyAction: pref(f.deleteKeyAction, stored.get("deleteKeyAction"), d.deleteKeyAction),
        readingPanePosition: pref(
          f.readingPanePosition,
          stored.get("readingPanePosition"),
          d.readingPanePosition,
        ),
        sidebarVisible: pref(f.sidebarVisible, stored.get("sidebarVisible"), d.sidebarVisible),
        toolbarVisible: pref(f.toolbarVisible, stored.get("toolbarVisible"), d.toolbarVisible),
        readingPaneVisible: pref(
          f.readingPaneVisible,
          stored.get("readingPaneVisible"),
          d.readingPaneVisible,
        ),
        readerZoom: pref(f.readerZoom, stored.get("readerZoom"), d.readerZoom),
        messageBackground: pref(
          f.messageBackground,
          stored.get("messageBackground"),
          d.messageBackground,
        ),
        attachmentSaveFolder: pref(f.attachmentSaveFolder, stored.get("attachmentSaveFolder"), {
          kind: "ask",
        }),
        attachmentOpenFolder: pref(
          f.attachmentOpenFolder,
          stored.get("attachmentOpenFolder"),
          "internal",
        ),
        threadGrouping: pref(f.threadGrouping, stored.get("threadGrouping"), d.threadGrouping),
        threadOrder: pref(f.threadOrder, stored.get("threadOrder"), d.threadOrder),
        shortcutSet: pref(f.shortcutSet, stored.get("shortcutSet"), d.shortcutSet),
        showAccountLabels: pref(
          f.showAccountLabels,
          stored.get("showAccountLabels"),
          d.showAccountLabels,
        ),
        notificationActions: pref(
          f.notificationActions,
          stored.get("notificationActions"),
          d.notificationActions,
        ),
        notifications: pref(f.notifications, stored.get("notifications"), d.notifications),
        quietHours: pref(f.quietHours, stored.get("quietHours"), d.quietHours),
        activeHours: pref(f.activeHours, stored.get("activeHours"), d.activeHours),
        menuBarUnreadCount: pref(
          f.menuBarUnreadCount,
          stored.get("menuBarUnreadCount"),
          d.menuBarUnreadCount,
        ),
      };
    }),
    Effect.withSpan("Store.prefs"),
  );

  const setPrefs = Effect.fn("Store.setPrefs")(function* (patch: Partial<Prefs>) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const [key, value] of Object.entries(patch)) {
            yield* run(sql`INSERT INTO prefs (key, value_json) VALUES (${key}, ${JSON.stringify(value)})
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
          }
          if (patch.contactPhotos === false)
            yield* run(
              sql`UPDATE contact_photos SET data_url=NULL,last_used=0 WHERE data_url IS NOT NULL`,
            );
        }),
      )
      .pipe(Effect.orDie);
  });

  // Signatures

  const legacySignatures = all(SignatureRow)(
    sql`SELECT address, kind, text FROM (SELECT address, kind, text,
      ROW_NUMBER() OVER (PARTITION BY address, kind ORDER BY source = 'local' DESC) AS rank
      FROM signatures) WHERE rank=1 ORDER BY address, kind`,
  ).pipe(
    Effect.map((rows): Signature[] => [...rows]),
    Effect.withSpan("Store.signatures"),
  );

  const signatures = Effect.gen(function* () {
    const legacy = yield* legacySignatures;
    const library = makeSignatureStore(sql, crypto);
    const named = yield* library.namedSignatures;
    const defaults = yield* library.signatureDefaults;
    const addresses = new Set([
      ...legacy.map((s) => s.address),
      ...named.map((s) => s.address),
      ...defaults.map((s) => s.address),
    ]);
    const result: Signature[] = [];
    for (const address of addresses)
      for (const kind of ["new", "reply"] as const) {
        const selected = signatureDefault(named, defaults, address, kind);
        const choice = defaults.find((s) => s.address === address && s.kind === kind);
        if (selected) result.push({ address, kind, text: selected.text, html: selected.html });
        else if (!choice) {
          const old = legacy.find((s) => s.address === address && s.kind === kind);
          if (old) result.push(old);
        }
      }
    return result;
  });

  const setSignature = Effect.fn("Store.setSignature")(function* (s: Signature) {
    const address = s.address.trim().toLowerCase();
    const id = `legacy:${address}:${s.kind}`;
    const body = richComposeBody(s.html ?? textComposeHtml(s.text));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (body.text.trim()) {
            yield* run(
              sql`INSERT INTO signatures(address,kind,source,text) VALUES(${address},${s.kind},'local',${body.text}) ON CONFLICT(address,kind,source) DO UPDATE SET text=excluded.text`,
            );
            yield* run(
              sql`INSERT INTO named_signatures(id,address,name,text,html) VALUES(${id},${address},${s.kind === "new" ? "New messages" : "Replies"},${body.text},${body.html}) ON CONFLICT(id) DO UPDATE SET text=excluded.text,html=excluded.html`,
            );
            yield* run(
              sql`INSERT INTO signature_defaults(address,kind,signature_id) VALUES(${address},${s.kind},${id}) ON CONFLICT(address,kind) DO UPDATE SET signature_id=excluded.signature_id`,
            );
          } else {
            yield* run(
              sql`DELETE FROM signatures WHERE address=${address} AND kind=${s.kind} AND source='local'`,
            );
            yield* run(sql`DELETE FROM named_signatures WHERE id=${id}`);
            yield* run(sql`DELETE FROM signature_defaults WHERE signature_id=${id}`);
          }
        }),
      )
      .pipe(Effect.orDie);
  });

  // Templates

  const TEMPLATE_COLUMNS = sql.literal(
    "id, name, subject, to_json, cc_json, bcc_json, body, updated_at",
  );

  const templates = all(TemplateRow)(
    sql`SELECT ${TEMPLATE_COLUMNS} FROM templates ORDER BY name COLLATE NOCASE, id`,
  ).pipe(
    Effect.map((rows) => rows.map(toTemplate)),
    Effect.withSpan("Store.templates"),
  );

  const saveTemplate = Effect.fn("Store.saveTemplate")(function* (
    id: string | null,
    input: TemplateInput,
  ): Effect.fn.Return<Template, NotFound> {
    const now = yield* Clock.currentTimeMillis;
    const key = id ?? crypto.randomUUID();
    const values = {
      name: input.name.trim(),
      subject: input.subject,
      to: JSON.stringify(input.to),
      cc: JSON.stringify(input.cc),
      bcc: JSON.stringify(input.bcc ?? []),
      body: input.body,
    };
    const row = yield* first(TemplateRow)(
      id === null
        ? sql`INSERT INTO templates (id, name, subject, to_json, cc_json, bcc_json, body, updated_at)
            VALUES (${key}, ${values.name}, ${values.subject}, ${values.to}, ${values.cc}, ${values.bcc},
              ${values.body}, ${now}) RETURNING ${TEMPLATE_COLUMNS}`
        : sql`UPDATE templates SET name = ${values.name}, subject = ${values.subject},
            to_json = ${values.to}, cc_json = ${values.cc}, bcc_json = ${values.bcc}, body = ${values.body},
            updated_at = ${now} WHERE id = ${key} RETURNING ${TEMPLATE_COLUMNS}`,
    );
    if (Option.isNone(row)) return yield* new NotFound({ what: "template", id: key });
    return toTemplate(row.value);
  });

  const deleteTemplate = Effect.fn("Store.deleteTemplate")((id: string) =>
    run(sql`DELETE FROM templates WHERE id = ${id}`),
  );

  // Contacts

  /**
   * Everyone the person wrote to (weight 3 in To, 2 in Cc) or heard from
   * (weight 1), each occurrence discounted by age: weight / (1 + age / 30
   * days). Frequency and recency add up in one score.
   */
  const suggestContacts = Effect.fn("Store.suggestContacts")(function* (
    query: string,
    limit: number,
    exclude?: string,
    accountIds?: readonly string[],
  ) {
    if (accountIds?.length === 0) return [];

    const now = yield* Clock.currentTimeMillis;
    const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (query.trim() && tokens.length === 0) return [];
    const match = tokens.map((token) => `"${token}"*`).join(" AND ");
    const matching = tokens.length
      ? sql`c.rowid IN (SELECT rowid FROM contact_completion_fts WHERE contact_completion_fts MATCH ${match})`
      : sql.literal("1");
    const scope = (alias: "c" | "h") =>
      sql.and([
        sql`${sql.literal(`${alias}.account_id`)} IN (SELECT id FROM accounts WHERE enabled=1)`,
        accountIds === undefined
          ? sql`1`
          : sql`${sql.literal(`${alias}.account_id`)} IN ${sql.in(accountIds)}`,
      ]);
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(0, Math.min(100, Math.trunc(limit)))
      : 10;
    const rows = yield* all(ContactRow)(sql`
      WITH matched AS (
        SELECT c.* FROM contact_candidates c WHERE ${scope("c")}
          AND ${matching}
      ), scored AS MATERIALIZED (
        SELECT address,SUM(CASE WHEN source!=3 THEN weight / (1.0 + MAX(${now}-date,0)/(${MONTH}*1.0)) ELSE 0 END) + MAX(CASE WHEN source=3 THEN 0.2 ELSE 0 END) AS score FROM matched GROUP BY address
      )
      SELECT s.address, (SELECT NULLIF(h.name,'') FROM contact_candidates h
        WHERE h.address=s.address AND h.name!='' AND ${scope("h")}
        ORDER BY h.source DESC,h.date DESC,h.account_id,h.id LIMIT 1) AS name
      FROM scored s
      WHERE s.address LIKE '%@%' AND s.address != ${exclude?.trim().toLowerCase() ?? ""}
        AND NOT EXISTS(SELECT 1 FROM hidden_contacts hidden WHERE hidden.address=s.address)
        AND s.address NOT LIKE '%noreply%' AND s.address NOT LIKE '%no-reply%' AND s.address NOT LIKE '%donotreply%'
      ORDER BY s.score DESC,s.address LIMIT ${boundedLimit}`);

    return rows.map((r): Address => ({ name: r.name ?? "", address: r.address }));
  });

  const hiddenContacts = all(AddressRow)(
    sql`SELECT address FROM hidden_contacts ORDER BY address`,
  ).pipe(
    Effect.map((rows) => rows.map((r) => r.address)),
    Effect.withSpan("Store.hiddenContacts"),
  );

  const setContactHidden = Effect.fn("Store.setContactHidden")((
    address: string,
    hidden: boolean,
  ) => {
    const key = address.trim().toLowerCase();
    return hidden
      ? run(sql`INSERT INTO hidden_contacts (address) VALUES (${key}) ON CONFLICT DO NOTHING`)
      : run(sql`DELETE FROM hidden_contacts WHERE address = ${key}`);
  });

  // Remote images

  const imageSenders = all(EntryRow)(sql`SELECT entry FROM image_senders ORDER BY entry`).pipe(
    Effect.map((rows) => rows.map((r) => r.entry)),
    Effect.withSpan("Store.imageSenders"),
  );

  const setImageSender = Effect.fn("Store.setImageSender")(function* (
    entry: string,
    allowed: boolean,
  ) {
    const key = imageSenderKey(entry);
    if (!key) return;
    if (!allowed) {
      yield* run(sql`DELETE FROM image_senders WHERE entry = ${key}`);
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    yield* run(sql`INSERT INTO image_senders (entry, created_at) VALUES (${key}, ${now})
      ON CONFLICT DO NOTHING`);
  });

  return {
    imageSenders,
    setImageSender,
    localDrafts,
    countLocalDrafts,
    getDraft,
    draftByRemoteMessage,
    draftByProposal,
    putDraft,
    setDraftRemote,
    draftCreateState,
    setDraftCreateState,
    setDraftOrganizationKey,
    draftSaveState,
    setDraftSyncError,
    setDraftLocalOnly,
    deleteDraft,
    enqueueDraftSave,
    dropSyncedDrafts,
    ...makeOutboxStore(sql),
    prefs,
    setPrefs,
    signatures,
    setSignature,
    templates,
    saveTemplate,
    deleteTemplate,
    suggestContacts,
    hiddenContacts,
    setContactHidden,
  };
}
