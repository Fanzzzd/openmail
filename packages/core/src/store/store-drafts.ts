import { attachmentFilename } from "../mime/attachment-filename.js";
/**
 * The Store's SQL for writing and reading settings: drafts, preferences,
 * signatures, templates, recipient suggestions and the remote image allowlist. Part of the Store service (store.ts
 * spreads these into it); split out to keep each file readable.
 */
import { Clock, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fragment } from "effect/sql/Statement";

import { type ThreadQuery, type ThreadSummary } from "../domain/message.js";
import {
  type DraftRemote,
  DraftCreateState,
  SendPreparationState,
  OutgoingMessage,
} from "../domain/changes.js";
import { normalizeComposeMessage } from "../compose/compose-body.js";
import type { DraftDiscard, StoredDraft } from "./service.js";
import { all, first, run } from "./sql-rows.js";
import { recipientList } from "./store-rows.js";

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
  revision: Schema.Number,
  editor: Schema.NullOr(Schema.String),
  remote_json: Schema.NullOr(
    Schema.fromJsonString(
      Schema.Struct({
        changeKey: Schema.optionalKey(Schema.String),
        lastWrittenAt: Schema.optionalKey(Schema.Number),
        writeNonce: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const LocalDraftRow = Schema.Struct({
  ...DraftRow.fields,
  email: Schema.String,
});

const IdRow = Schema.Struct({ id: Schema.String });
const RevisionRow = Schema.Struct({ revision: Schema.Number });

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
    revision: r.revision,
    editor: r.editor,
  };
}

/** Local drafts: their rows, remote copies, save queue and creation state. */
export function makeDraftStore(sql: SqlClient.SqlClient) {
  const DRAFT_COLUMNS = sql.literal(`d.id, d.account_id, d.message_json, d.updated_at,
    d.proposal_id, d.remote_draft_id, d.remote_message_id, d.pushed_attachments, d.pushed_organization, d.sync_error, d.local_only, d.revision, d.editor,
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
    editor?: string | null;
  }) {
    const now = yield* Clock.currentTimeMillis;
    // Revisions come from one counter for all drafts, so a draft deleted and written
    // again under the same id (an account switch, a resave after sync dropped it)
    // never repeats a revision an editor already holds.
    const { revision } = yield* first(RevisionRow)(
      sql`INSERT INTO prefs(key,value_json)
        VALUES('draft-revision',(SELECT COALESCE(MAX(revision),0)+1 FROM drafts))
        ON CONFLICT(key) DO UPDATE SET value_json=CAST(value_json AS INTEGER)+1
        RETURNING CAST(value_json AS INTEGER) AS revision`,
    ).pipe(Effect.map(Option.getOrThrow));
    yield* run(sql`INSERT INTO drafts (id, account_id, message_json, updated_at, proposal_id, revision, editor)
      VALUES (${draft.id}, ${draft.accountId}, ${JSON.stringify(draft.message)}, ${now},
        ${draft.proposalId ?? null}, ${revision}, ${draft.editor ?? null})
      ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id,
        message_json = excluded.message_json, updated_at = excluded.updated_at,
        revision = excluded.revision, editor = excluded.editor,
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
  /** Records an update about to be sent; the next confirmed setDraftRemote clears it. */
  const setDraftWriteNonce = (id: string, nonce: string) =>
    run(
      sql`INSERT INTO prefs(key,value_json) SELECT ${`draft-remote:${id}`},${JSON.stringify({ writeNonce: nonce })} WHERE EXISTS(SELECT 1 FROM drafts WHERE id=${id}) ON CONFLICT(key) DO UPDATE SET value_json=json_set(value_json,'$.writeNonce',${nonce})`,
    );
  const setDraftCreateState = (id: string, state: DraftCreateState | null) =>
    state
      ? run(
          sql`INSERT INTO prefs(key,value_json) VALUES(${`draft-create:${id}`},${JSON.stringify(state)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
        )
      : run(sql`DELETE FROM prefs WHERE key=${`draft-create:${id}`}`);

  const setDraftOrganizationKey = (id: string, key: string | null) =>
    run(sql`UPDATE drafts SET pushed_organization = ${key} WHERE id = ${id}`);

  const sendPreparationState = (id: string) =>
    first(Schema.Struct({ value_json: Schema.fromJsonString(SendPreparationState) }))(
      sql`SELECT value_json FROM prefs WHERE key=${`send-prepare:${id}`}`,
    ).pipe(Effect.map(Option.map((row) => row.value_json)));
  const setSendPreparationState = (id: string, state: SendPreparationState | null) =>
    state
      ? run(
          sql`INSERT INTO prefs(key,value_json) VALUES(${`send-prepare:${id}`},${JSON.stringify(state)}) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
        )
      : run(sql`DELETE FROM prefs WHERE key=${`send-prepare:${id}`}`);

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
          const sendPreparation = yield* first(
            Schema.Struct({
              account_id: Schema.String,
              state: Schema.fromJsonString(SendPreparationState),
            }),
          )(
            sql`SELECT d.account_id,p.value_json AS state FROM drafts d JOIN prefs p ON p.key=${`send-prepare:${id}`} WHERE d.id=${id}`,
          );
          if (Option.isSome(sendPreparation))
            uncertain.push({
              account_id: sendPreparation.value.account_id,
              appended_message_id: sendPreparation.value.state.messageId,
              progress_json: [],
            });
          yield* enqueueAppendedCleanup(id, [...(yield* waitingDraftSaves(id)), ...uncertain]);
          yield* setDraftCreateState(id, null);
          yield* run(sql`DELETE FROM prefs WHERE key=${`draft-remote:${id}`}`);
          yield* run(sql`DELETE FROM prefs WHERE key=${`send-uncertain:${id}`}`);
          yield* setSendPreparationState(id, null);
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
   * pushed but not pulled back yet. Newest first, as thread rows. A draft whose
   * discard waits out its Undo is left out.
   */
  const localDraftFilter = (q: ThreadQuery) => {
    const where: Fragment[] = [
      sql`(d.remote_message_id IS NULL OR NOT EXISTS (SELECT 1 FROM messages m
        WHERE m.account_id = d.account_id AND m.provider_id = d.remote_message_id))`,
      sql`NOT EXISTS (SELECT 1 FROM draft_discards x WHERE x.id = d.id)`,
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
            recipients: recipientList([m.to, m.cc, m.bcc]),
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

  const DiscardRow = Schema.Struct({
    id: Schema.String,
    discard_at: Schema.Number,
    discarded: Schema.BooleanFromBit,
  });
  const toDiscard = (row: typeof DiscardRow.Type): DraftDiscard => ({
    id: row.id,
    discardAt: row.discard_at,
    discarded: row.discarded,
  });

  const holdDraftDiscard = Effect.fn("Store.holdDraftDiscard")((id: string, discardAt: number) =>
    run(sql`INSERT INTO draft_discards(id,discard_at,discarded) VALUES(${id},${discardAt},0)
      ON CONFLICT(id) DO UPDATE SET discard_at=excluded.discard_at, discarded=0`),
  );

  /** Drops a held discard; a finished one stays. True when one was held. */
  const releaseDraftDiscard = Effect.fn("Store.releaseDraftDiscard")(function* (id: string) {
    const rows = yield* all(IdRow)(
      sql`DELETE FROM draft_discards WHERE id=${id} AND discarded=0 RETURNING id`,
    );
    return rows.length > 0;
  });

  const markDraftDiscarded = Effect.fn("Store.markDraftDiscarded")(function* (id: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* run(sql`INSERT INTO draft_discards(id,discard_at,discarded) VALUES(${id},${now},1)
      ON CONFLICT(id) DO UPDATE SET discard_at=excluded.discard_at, discarded=1`);
  });

  const draftDiscard = Effect.fn("Store.draftDiscard")((id: string) =>
    first(DiscardRow)(sql`SELECT id,discard_at,discarded FROM draft_discards WHERE id=${id}`).pipe(
      Effect.map(Option.map(toDiscard)),
    ),
  );

  const draftDiscards = all(DiscardRow)(
    sql`SELECT id,discard_at,discarded FROM draft_discards ORDER BY discard_at`,
  ).pipe(Effect.map((rows) => rows.map(toDiscard)));

  const pruneDraftDiscards = Effect.fn("Store.pruneDraftDiscards")((before: number) =>
    run(sql`DELETE FROM draft_discards WHERE discarded=1 AND discard_at < ${before}`),
  );

  return {
    localDrafts,
    holdDraftDiscard,
    releaseDraftDiscard,
    markDraftDiscarded,
    draftDiscard,
    draftDiscards,
    pruneDraftDiscards,
    countLocalDrafts,
    getDraft,
    draftByRemoteMessage,
    draftByProposal,
    putDraft,
    setDraftRemote,
    draftCreateState,
    setDraftCreateState,
    setDraftWriteNonce,
    sendPreparationState,
    setSendPreparationState,
    setDraftOrganizationKey,
    draftSaveState,
    setDraftSyncError,
    setDraftLocalOnly,
    deleteDraft,
    enqueueDraftSave,
    dropSyncedDrafts,
  };
}
