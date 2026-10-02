import type { ThreadQuery, ThreadSummary } from "@openmail/core/portable";
export const PAGE_SIZE = 30;
export const pageQuery = (accountId: string, label: string, last?: ThreadSummary): ThreadQuery => ({
  accountIds: [accountId],
  label,
  limit: PAGE_SIZE,
  ...(last ? { before: last.date, beforeId: last.id } : {}),
});
export const appendPage = (rows: readonly ThreadSummary[], page: readonly ThreadSummary[]) => {
  const seen = new Set(rows.map((row) => row.id));
  return [...rows, ...page.filter((row) => !seen.has(row.id))];
};
