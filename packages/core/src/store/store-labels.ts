import { Effect, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { type Fragment } from "effect/sql/Statement";
import { categoryKey } from "../domain/categories.js";
import type { Label } from "../domain/account.js";
import { all } from "./sql-rows.js";
import { type makeComposeStore } from "./store-compose.js";
import { accountScope, heldDraftMessage, type makeQueryStore } from "./store-query.js";
import { Count, counts, LabelRow } from "./store-rows.js";

/** Labels and unread counts per label and mailbox. */
export const makeLabelsStore = ({
  sql,
  compose,
  hasLabel,
}: {
  sql: SqlClient.SqlClient;
  compose: ReturnType<typeof makeComposeStore>;
  hasLabel: ReturnType<typeof makeQueryStore>["hasLabel"];
}) => {
  /** Sidebar/account badge units follow the conversation preference. */
  const unreadCounts = Effect.gen(function* () {
    const prefs = yield* compose.prefs;
    const rows = yield* all(
      Count,
    )(sql`SELECT account_id AS key, ${prefs.threadGrouping ? sql`COUNT(DISTINCT thread_id)` : sql`COUNT(*)`} AS n FROM messages m
        WHERE m.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND is_unread=1 AND ${hasLabel("INBOX")} AND NOT EXISTS (SELECT 1 FROM thread_reminders r WHERE r.account_id=m.account_id AND r.thread_id=m.thread_id AND r.due_at IS NOT NULL) GROUP BY account_id`);
    return counts(rows);
  }).pipe(Effect.withSpan("Store.unreadCounts"));

  /**
   * Unread messages per label id, across the given accounts (all when omitted).
   * Keys are system labels (INBOX, SPAM, CATEGORY_*) and user label ids alike.
   * `within` counts only messages that also carry that label, e.g. INBOX for
   * category badges.
   */
  const unreadByLabel = Effect.fn("Store.unreadByLabel")(function* (
    accountIds?: readonly string[],
    within?: string,
    conversations = false,
  ) {
    const where: Fragment[] = [sql`b.account_id IN (SELECT id FROM accounts WHERE enabled=1)`];
    if (accountIds) where.push(accountScope(sql, accountIds, "b.account_id"));
    if (within === "INBOX") where.push(sql`b.in_inbox=1`);
    else if (within !== undefined)
      where.push(
        sql`EXISTS (SELECT 1 FROM messages m WHERE m.id=b.message_id AND ${hasLabel(within)})`,
      );
    where.push(
      sql`(b.label != 'INBOX' OR NOT EXISTS(SELECT 1 FROM thread_reminders r WHERE r.account_id=b.account_id AND r.thread_id=b.thread_id AND r.due_at IS NOT NULL))`,
    );
    const literalLabels = [
      ...where,
      sql`(b.label!='CATEGORY_PERSONAL' OR b.account_id NOT IN (SELECT id FROM accounts WHERE provider='outlook'))`,
      // A draft whose discard waits out its Undo no longer counts.
      sql`(b.label!='DRAFT' OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id=b.message_id
        AND ${heldDraftMessage(sql)}))`,
    ];
    const rows = yield* all(Count)(
      conversations
        ? sql`SELECT key,SUM(n) AS n FROM (
            SELECT b.label AS key,b.account_id,COUNT(DISTINCT b.thread_id) AS n
            FROM message_badges b
            WHERE ${sql.and(literalLabels)} GROUP BY b.label,b.account_id
          ) GROUP BY key`
        : sql`SELECT b.label AS key,COUNT(*) AS n
            FROM message_badges b
            WHERE ${sql.and(literalLabels)} GROUP BY b.label`,
    );
    const result = counts(rows);
    // Unknown Outlook Inbox mail belongs to Focused. Count eligible messages
    // before grouping: a conversation may contain both Focused and Other mail.
    const focusedWhere = [
      ...where,
      sql`b.label='INBOX'`,
      sql`b.account_id IN (SELECT id FROM accounts WHERE provider='outlook')`,
      sql`NOT EXISTS(SELECT 1 FROM message_badges other WHERE other.label='CATEGORY_OTHER'
        AND other.account_id=b.account_id AND other.thread_id=b.thread_id AND other.message_id=b.message_id)`,
    ];
    const focused = yield* all(Count)(
      conversations
        ? sql`SELECT 'CATEGORY_PERSONAL' AS key,SUM(n) AS n FROM (
          SELECT COUNT(DISTINCT b.thread_id) AS n FROM message_badges b
          WHERE ${sql.and(focusedWhere)} GROUP BY b.account_id
        ) HAVING SUM(n)>0`
        : sql`SELECT 'CATEGORY_PERSONAL' AS key,COUNT(*) AS n FROM message_badges b
          WHERE ${sql.and(focusedWhere)} HAVING COUNT(*)>0`,
    );
    for (const row of focused) result[row.key] = (result[row.key] ?? 0) + row.n;
    if (within === undefined || within === "DRAFT") {
      const local = yield* compose.countLocalDrafts(accountIds);
      if (local) result["DRAFT"] = (result["DRAFT"] ?? 0) + local;
    }
    return result;
  });

  // Labels

  /** Replaces an account's label list with what the provider reports now. */
  const replaceLabels = Effect.fn("Store.replaceLabels")(
    (account: string, labels: readonly Omit<Label, "accountId">[]) =>
      Effect.orDie(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM labels WHERE account_id = ${account}`;
            for (const l of labels) {
              yield* sql`INSERT INTO labels (account_id, id, name, color, label_list_visibility, message_list_visibility)
                  VALUES (${account}, ${l.id}, ${l.name}, ${l.color}, ${l.labelListVisibility ?? null}, ${l.messageListVisibility ?? null})`;
            }
          }),
        ),
      ),
  );

  const listLabels = Effect.fn("Store.listLabels")(function* (accountIds?: readonly string[]) {
    const rows = yield* all(
      LabelRow,
    )(sql`SELECT account_id, id, name, color, label_list_visibility, message_list_visibility FROM labels m
        WHERE m.account_id IN (SELECT id FROM accounts WHERE enabled=1) AND ${accountScope(sql, accountIds)}
        ORDER BY account_id, name`);
    // Outlook categories live only in labels_json. Reading it from the covering
    // index avoids walking every message row and its body overflow pages.
    const categories = yield* all(
      Schema.Struct({
        accountId: Schema.String,
        id: Schema.String,
        name: Schema.String,
        color: Schema.NullOr(Schema.String),
      }),
    )(sql`
        SELECT DISTINCT m.account_id AS accountId, j.value AS id, substr(j.value,10) AS name, NULL AS color
        FROM messages m INDEXED BY messages_thread_state JOIN accounts a ON a.id=m.account_id, json_each(m.labels_json) j
        WHERE a.enabled=1 AND a.provider='outlook' AND j.value LIKE 'category:%' AND ${accountScope(sql, accountIds)}`);
    return [
      ...new Map(
        categories.map((category) => [
          `${category.accountId}/${categoryKey(category.id.slice(9))}`,
          category,
        ]),
      ).values(),
      ...rows.map((r) => ({
        accountId: r.account_id,
        id: r.id,
        name: r.name,
        color: r.color,
        ...(r.label_list_visibility ? { labelListVisibility: r.label_list_visibility } : {}),
        ...(r.message_list_visibility ? { messageListVisibility: r.message_list_visibility } : {}),
      })),
    ];
  });

  return { unreadCounts, unreadByLabel, replaceLabels, listLabels };
};
