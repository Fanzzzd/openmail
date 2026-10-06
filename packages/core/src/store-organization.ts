import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import {
  FilterRestoration,
  type AccountOrganization,
  type LabelPreference,
  type SendAs,
} from "./organization.js";
import { richComposeBody, textComposeHtml } from "./compose-body.js";
import { INBOX_CATEGORIES, inboxCategories, Provider } from "./domain.js";
import { all, run } from "./sql-rows.js";

const LabelPrefRow = Schema.Struct({
  account_id: Schema.String,
  id: Schema.String,
  visible: Schema.BooleanFromBit,
  favorite: Schema.BooleanFromBit,
  position: Schema.Number,
  color: Schema.NullOr(Schema.String),
});
const OrganizationRow = Schema.Struct({
  account_id: Schema.String,
  categories: Schema.BooleanFromBit,
  provider: Provider,
  selected_categories: Schema.NullOr(
    Schema.fromJsonString(Schema.Array(Schema.Literals(INBOX_CATEGORIES))),
  ),
});
const AliasRow = Schema.Struct({
  account_id: Schema.String,
  address: Schema.String,
  name: Schema.String,
  is_default: Schema.BooleanFromBit,
  signature: Schema.String,
  signature_html: Schema.String,
});
const WakeRow = Schema.Struct({ account_id: Schema.String, thread_id: Schema.String });
const IdRow = Schema.Struct({ id: Schema.String });

export function makeOrganizationStore(sql: SqlClient.SqlClient) {
  const filterRestorations = (accountId: string) =>
    all(Schema.Struct({ backup_json: Schema.String }))(
      sql`SELECT backup_json FROM filter_restorations WHERE account_id=${accountId} ORDER BY rowid`,
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(FilterRestoration))(
            row.backup_json,
          ).pipe(Effect.orDie),
        ),
      ),
    );
  const saveFilterRestoration = (backup: FilterRestoration) =>
    run(
      sql`INSERT INTO filter_restorations (id, account_id, backup_json)
      VALUES (${backup.id}, ${backup.accountId}, ${JSON.stringify(backup)})`,
    );
  const deleteFilterRestoration = (accountId: string, id: string) =>
    run(sql`DELETE FROM filter_restorations WHERE account_id=${accountId} AND id=${id}`);
  const labelPreferences = all(LabelPrefRow)(
    sql`SELECT * FROM label_preferences ORDER BY position, account_id, id`,
  ).pipe(
    Effect.map((rows) =>
      rows.map((r) => ({
        accountId: r.account_id,
        id: r.id,
        visible: r.visible,
        favorite: r.favorite,
        position: r.position,
        color: r.color,
      })),
    ),
  );
  const setLabelPreference = (p: LabelPreference) =>
    run(sql`INSERT INTO label_preferences (account_id, id, visible, favorite, color, position)
    VALUES (${p.accountId}, ${p.id}, ${Number(p.visible)}, ${Number(p.favorite)}, ${p.color}, ${p.position ?? 0})
    ON CONFLICT(account_id, id) DO UPDATE SET visible=excluded.visible, favorite=excluded.favorite, color=excluded.color, position=excluded.position`);
  const moveLabelPreference = (accountId: string, from: string, to: string | null) =>
    Effect.gen(function* () {
      if (from === to) return;
      const old = (yield* labelPreferences).find((p) => p.accountId === accountId && p.id === from);
      if (old && to) yield* setLabelPreference({ ...old, id: to });
      yield* run(sql`DELETE FROM label_preferences WHERE account_id=${accountId} AND id=${from}`);
    });
  const organization = all(
    OrganizationRow,
  )(sql`SELECT a.id AS account_id, a.provider, COALESCE(o.categories, 1) AS categories, o.selected_categories
    FROM accounts a LEFT JOIN account_organization o ON a.id=o.account_id`).pipe(
    Effect.map((rows) =>
      rows.map((r) => ({
        accountId: r.account_id,
        categories: r.categories,
        selectedCategories: r.selected_categories ?? [...inboxCategories(r.provider)],
      })),
    ),
  );
  const setOrganization = (p: AccountOrganization) =>
    run(
      sql`INSERT INTO account_organization (account_id, categories, selected_categories) VALUES (${p.accountId}, ${Number(p.categories)}, ${p.selectedCategories === undefined ? null : JSON.stringify(p.selectedCategories)}) ON CONFLICT(account_id) DO UPDATE SET categories=excluded.categories, selected_categories=excluded.selected_categories`,
    );
  const sendAs = all(AliasRow)(sql`SELECT * FROM send_as ORDER BY is_default DESC, address`).pipe(
    Effect.map((rows) =>
      rows.map((r) => ({
        accountId: r.account_id,
        address: r.address,
        name: r.name,
        isDefault: r.is_default,
        signature: r.signature,
        signatureHtml: r.signature_html,
      })),
    ),
  );
  const replaceSendAs = (accountId: string, aliases: readonly SendAs[]) =>
    Effect.gen(function* () {
      const previous = yield* all(AliasRow)(
        sql`SELECT * FROM send_as WHERE account_id=${accountId}`,
      );
      for (const old of previous)
        yield* run(sql`DELETE FROM signatures WHERE address=${old.address} AND source='gmail'`);
      yield* run(sql`DELETE FROM send_as WHERE account_id=${accountId}`);
      for (const alias of aliases) {
        yield* run(
          sql`INSERT INTO send_as (account_id, address, name, is_default, signature, signature_html) VALUES (${accountId}, ${alias.address.trim().toLowerCase()}, ${alias.name}, ${Number(alias.isDefault)}, ${alias.signature}, ${richComposeBody(alias.signatureHtml ?? textComposeHtml(alias.signature)).html})`,
        );
        for (const kind of ["new", "reply"]) {
          if (alias.signature)
            yield* run(sql`INSERT INTO signatures (address, kind, text, source)
          VALUES (${alias.address}, ${kind}, ${alias.signature}, 'gmail') ON CONFLICT(address, kind, source)
          DO UPDATE SET text=excluded.text`);
        }
      }
    });
  const wakeSnoozed = (now: number) =>
    Effect.gen(function* () {
      const due = yield* all(
        WakeRow,
      )(sql`UPDATE thread_reminders SET due_at=NULL, woken_at=${now}, wake_pending=0
      WHERE due_at<=${now} RETURNING account_id, thread_id`);
      const ids: string[] = [];
      for (const r of due) {
        const messages = yield* all(IdRow)(
          sql`SELECT m.id FROM messages m JOIN snoozed_messages s ON s.account_id=m.account_id AND s.provider_id=m.provider_id
            WHERE s.account_id=${r.account_id} AND s.thread_id=${r.thread_id}
            AND NOT EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value IN ('DRAFT','TRASH','SPAM'))`,
        );
        yield* run(
          sql`UPDATE snoozed_messages SET wake_pending=1 WHERE account_id=${r.account_id} AND thread_id=${r.thread_id}`,
        );
        ids.push(...messages.map((m) => m.id));
      }
      return ids;
    });
  return {
    filterRestorations,
    saveFilterRestoration,
    deleteFilterRestoration,
    labelPreferences,
    setLabelPreference,
    moveLabelPreference,
    organization,
    setOrganization,
    sendAs,
    replaceSendAs,
    wakeSnoozed,
  };
}
