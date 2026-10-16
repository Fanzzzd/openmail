/** The label filter of a thread list, as an agent or a person types it: an id or a name. */
import { Effect } from "effect";
import type { Label } from "../domain/account.js";
import { INBOX_CATEGORIES, type ThreadQuery, type ThreadSummary } from "../domain/message.js";
import { MAILBOX_LABEL } from "../domain/mailbox-labels.js";
import { searchFolderValue } from "../search/search-tokens.js";
import { sqliteTextCompare } from "../store/sql-rows.js";
import type { MailboxReading } from "./mailbox.js";

/** Labels every account can carry without a row in the labels table. */
const SYSTEM_LABELS: ReadonlySet<string> = new Set([
  ...Object.values(MAILBOX_LABEL),
  ...INBOX_CATEGORIES,
]);

/** One label id and the accounts it applies to. */
export type LabelTarget = { readonly label: string; readonly accountIds: readonly string[] };

/**
 * Resolves a label filter to label ids. A system label (`INBOX`, `inbox`, `CATEGORY_UPDATES`) or a
 * label id matches as is. Otherwise the text matches label names without regard to case, like
 * Gmail's `label:`; the same name can have a different id in each account. Undefined when
 * nothing matches, so a typo fails instead of listing an empty mailbox.
 */
export function resolveLabelFilter(
  label: string,
  labels: readonly Label[],
  accountIds: readonly string[],
): readonly LabelTarget[] | undefined {
  const system = searchFolderValue(label);
  if (SYSTEM_LABELS.has(system)) return [{ label: system, accountIds }];
  if (SYSTEM_LABELS.has(label.toUpperCase())) return [{ label: label.toUpperCase(), accountIds }];
  if (labels.some((row) => row.id === label)) return [{ label, accountIds }];
  const name = label.toLocaleLowerCase();
  const byId = new Map<string, string[]>();
  for (const row of labels)
    if (row.name.toLocaleLowerCase() === name && accountIds.includes(row.accountId))
      byId.set(row.id, [...(byId.get(row.id) ?? []), row.accountId]);
  return byId.size
    ? [...byId].map(([id, accounts]) => ({ label: id, accountIds: accounts }))
    : undefined;
}

const newestFirst = (a: ThreadSummary, b: ThreadSummary) =>
  b.date - a.date || sqliteTextCompare(b.id, a.id);

/**
 * Lists threads with a label given by id or name. Null when the label is neither a system label,
 * a label id nor a label name in the selected accounts; callers report it as not found.
 */
export const threadsWithLabel = Effect.fnUntraced(function* (
  reading: Pick<MailboxReading, "threads" | "labels">,
  q: ThreadQuery & { readonly label: string; readonly accountIds: readonly string[] },
) {
  const targets = resolveLabelFilter(q.label, yield* reading.labels(q.accountIds), q.accountIds);
  if (!targets) return null;
  const pages = yield* Effect.forEach(targets, (target) =>
    reading.threads({ ...q, label: target.label, accountIds: target.accountIds }),
  );
  if (pages.length === 1) return pages[0] ?? [];
  const merged = pages.flat().toSorted(newestFirst);
  return q.limit === undefined ? merged : merged.slice(0, q.limit);
});
