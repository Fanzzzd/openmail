import type { SearchObject } from "imapflow";
import type { ThreadQuery } from "../../domain/message.js";
import {
  parseSearchQuery,
  searchWords,
  unquoteSearchValue,
  searchCalendarDate,
  parseSearchExpression,
  projectServerSearch,
  serverSearchIgnored,
  hasSearchExpression,
} from "../../search/search.js";

/** IMAP has no filename/attachment key; those are checked on fetched MIME. */
export function imapSearch(query: ThreadQuery): SearchObject {
  if (
    query.search &&
    (hasSearchExpression(query.search) ||
      searchWords(query.search).some((word) => word.startsWith("-")))
  ) {
    const expression = projectServerSearch<SearchObject>(
      parseSearchExpression(query.search),
      (value) => {
        if (serverSearchIgnored({ search: value }, "imap").length) return null;
        const parsed = parseSearchQuery({ search: value });
        const extra = imapSearch({ ...parsed, search: undefined });
        return parsed.search
          ? { ...extra, text: unquoteSearchValue(parsed.search).replace(/\*$/, "") }
          : extra;
      },
      (kind, children) =>
        children.length === 1 && children[0]
          ? children[0]
          : kind === "or"
            ? { or: children }
            : { not: { or: children.map((child) => ({ not: child })) } },
      (child) => ({ not: child }),
    );
    const extra = imapSearch({ ...query, search: undefined });
    const predicate = expression.value;
    if (predicate && extra.all && Object.keys(extra).length === 1) return predicate;
    return predicate ? { not: { or: [{ not: predicate }, { not: extra }] } } : extra;
  }
  const q = parseSearchQuery(query);
  const c = q.criteria ?? {};
  const terms: SearchObject[] = [];
  const text = searchWords(q.search ?? "").map(unquoteSearchValue);
  if (text.length === 1) terms.push({ text: text[0] });
  else if (text.length > 1)
    terms.push({ not: { or: text.map((word) => ({ not: { text: word } })) } });
  if (c.from) terms.push({ from: c.from });
  if (c.to) terms.push({ to: c.to });
  if (c.bcc) terms.push({ bcc: c.bcc });
  if (c.rfcMessageId) terms.push({ header: { "message-id": c.rfcMessageId } });
  if (c.sizeLarger !== undefined) terms.push({ larger: c.sizeLarger });
  if (c.sizeSmaller !== undefined) terms.push({ smaller: c.sizeSmaller });
  if (c.unread !== undefined) terms.push({ seen: !c.unread });
  if (c.cc) terms.push({ cc: c.cc });
  if (c.subject) terms.push({ subject: c.subject });
  if (c.important)
    terms.push({
      or: [
        { keyword: "$Important" },
        { header: { Importance: "high" } },
        { header: { "X-Priority": "1" } },
        { header: { "X-Priority": "2" } },
      ],
    });
  if (q.unreadOnly) terms.push({ seen: false });
  if (q.starredOnly) terms.push({ flagged: true });
  if (c.dateAfter !== undefined) terms.push({ since: searchCalendarDate(new Date(c.dateAfter)) });
  if (c.dateBefore !== undefined)
    terms.push({ before: searchCalendarDate(new Date(c.dateBefore)) });
  return terms.reduce<SearchObject>(
    (out, term) => ({ ...out, ...term }),
    terms.length ? {} : { all: true },
  );
}
