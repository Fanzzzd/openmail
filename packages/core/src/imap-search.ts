import type { SearchObject } from "imapflow";
import type { ThreadQuery } from "./domain.js";
import { parseSearchQuery, searchWords } from "./search.js";

/** IMAP has no filename/attachment key; those are checked on fetched MIME. */
export function imapSearch(query: ThreadQuery): SearchObject {
  const q = parseSearchQuery(query);
  const c = q.criteria ?? {};
  const terms: SearchObject[] = [];
  const text = searchWords(q.search ?? "").map((word) => word.replace(/^"(.*)"$/, "$1"));
  if (text.length === 1) terms.push({ text: text[0] });
  else if (text.length > 1)
    terms.push({ not: { or: text.map((word) => ({ not: { text: word } })) } });
  if (c.from) terms.push({ from: c.from });
  if (c.to) terms.push({ to: c.to });
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
  if (c.dateAfter !== undefined) terms.push({ since: new Date(c.dateAfter) });
  if (c.dateBefore !== undefined) terms.push({ before: new Date(c.dateBefore) });
  return terms.reduce<SearchObject>(
    (out, term) => ({ ...out, ...term }),
    terms.length ? {} : { all: true },
  );
}
