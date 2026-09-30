import type {
  IncomingMessage,
  Label,
  SearchCriteria,
  ThreadQuery,
  ThreadSummary,
} from "./domain.js";
import type { FilterCriteria } from "./organization.js";

export const SEARCH_OPERATORS = [
  "from:",
  "to:",
  "label:",
  "folder:",
  "is:unread",
  "is:starred",
  "is:important",
  "has:attachment",
  "has:image",
  "in:attachment",
  "filename:",
  "before:",
  "after:",
];
export const searchWords = (text: string): string[] =>
  text.match(/(?:[^\s"]|"[^"]*(?:"|$))+/g) ?? [];
/** The final term stays editable until whitespace/Enter finishes it outside quotes. */
export function searchFieldParts(value: string): {
  chips: string[];
  text: string;
  pending: string;
} {
  const words = searchWords(value);
  const complete = /\s$/.test(value) && (value.match(/"/g)?.length ?? 0) % 2 === 0;
  const pending = complete ? "" : (words.at(-1) ?? "");
  const finished = pending ? words.slice(0, -1) : words;
  return {
    chips: finished.filter((word) => word.includes(":")),
    text: [...finished.filter((word) => !word.includes(":")), pending].filter(Boolean).join(" "),
    pending,
  };
}
export function serializeSearchField(chips: readonly string[], text: string): string {
  const value = [...chips, text].filter(Boolean).join(" ");
  return chips.length > 0 && !text ? `${value} ` : value;
}

export function selectSearchOperator(value: string, operator: string): string {
  const { chips, text, pending } = searchFieldParts(value);
  const free = pending ? text.slice(0, -pending.length).trimEnd() : text;
  const next = [free, operator].filter(Boolean).join(" ");
  return serializeSearchField(chips, operator.endsWith(":") ? next : `${next} `);
}

const unquote = (text: string) => text.replace(/^"(.*)"$/, "$1");
const quote = (text: string) => `"${text.replaceAll('"', "").replaceAll("\\", "")}"`;

/** Invalid/incomplete operators stay searchable text while the person is typing. */
export function parseSearchQuery(query: ThreadQuery): ThreadQuery {
  const criteria: { -readonly [K in keyof SearchCriteria]: SearchCriteria[K] } = {
    ...query.criteria,
  };
  const words: string[] = [];
  let unread = query.unreadOnly;
  let starred = query.starredOnly;
  for (const word of searchWords(query.search ?? "")) {
    const colon = word.indexOf(":");
    const key = word.slice(0, colon).toLowerCase();
    const value = unquote(word.slice(colon + 1));
    if (colon < 1 || !value || (word.match(/"/g)?.length ?? 0) % 2 !== 0) {
      words.push(word);
      continue;
    }
    switch (key) {
      case "from":
        criteria.from = value;
        break;
      case "to":
        criteria.to = value;
        break;
      case "subject":
        criteria.subject = value;
        break;
      case "label":
      case "folder":
        criteria.labels = [...(criteria.labels ?? []), value];
        break;
      case "filename":
        criteria.filename = value;
        break;
      case "has":
        if (value === "attachment") criteria.attachment = true;
        else if (value === "image") criteria.image = true;
        else words.push(word);
        break;
      case "in":
        if (value === "attachment") criteria.attachmentText = true;
        else words.push(word);
        break;
      case "is":
        if (value === "unread") unread = true;
        else if (value === "starred") starred = true;
        else if (value === "important") criteria.important = true;
        else words.push(word);
        break;
      case "before":
      case "after": {
        const normalized = value.replaceAll("/", "-");
        const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
          ? Date.parse(`${normalized}T00:00:00Z`)
          : NaN;
        if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== normalized)
          words.push(word);
        else if (key === "before") criteria.dateBefore = date;
        else criteria.dateAfter = date;
        break;
      }
      default:
        words.push(word);
    }
  }
  return {
    ...query,
    search: words.join(" "),
    criteria,
    ...(unread === undefined ? {} : { unreadOnly: unread }),
    ...(starred === undefined ? {} : { starredOnly: starred }),
  };
}

export const searchMailboxLabel = (q: ThreadQuery): string | undefined => {
  if (q.searchScope !== "folder") return undefined;
  if (q.label) return q.label;
  const names = {
    inbox: "INBOX",
    snoozed: "SNOOZED",
    important: "IMPORTANT",
    starred: "STARRED",
    sent: "SENT",
    drafts: "DRAFT",
    spam: "SPAM",
    trash: "TRASH",
    all: undefined,
  };
  return names[q.mailbox ?? "inbox"];
};

export function gmailSearch(
  query: ThreadQuery,
  labels: readonly Pick<Label, "id" | "name">[] = [],
): string {
  // Gmail also accepts its advanced q syntax beyond our common chips.
  const parsed = parseSearchQuery(query);
  const words = searchWords(query.search ?? "").map((word) => {
    const match = /^(label|folder):(.+)$/.exec(word);
    if (match) {
      const value = unquote(match[2] ?? "");
      return `label:${quote(labels.find((l) => l.id === value)?.name ?? value)}`;
    }
    if (word.startsWith("before:") && parsed.criteria?.dateBefore !== undefined)
      return `before:${Math.floor(parsed.criteria.dateBefore / 1000)}`;
    if (word.startsWith("after:") && parsed.criteria?.dateAfter !== undefined)
      return `after:${Math.floor(parsed.criteria.dateAfter / 1000)}`;
    return word;
  });
  const c = query.criteria;
  if (c?.from) words.push(`from:${quote(c.from)}`);
  if (c?.to) words.push(`to:${quote(c.to)}`);
  if (c?.subject) words.push(`subject:${quote(c.subject)}`);
  if (c?.filename) words.push(`filename:${quote(c.filename)}`);
  if (c?.important) words.push("is:important");
  if (c?.attachment) words.push("has:attachment");
  for (const label of c?.labels ?? [])
    words.push(`label:${quote(labels.find((l) => l.id === label)?.name ?? label)}`);
  if (c?.dateBefore !== undefined) words.push(`before:${Math.floor(c.dateBefore / 1000)}`);
  if (c?.dateAfter !== undefined) words.push(`after:${Math.floor(c.dateAfter / 1000)}`);
  let text = words.join(" ");
  const scope = searchMailboxLabel(query);
  if (scope) text += ` label:${quote(labels.find((l) => l.id === scope)?.name ?? scope)}`;
  if (query.unreadOnly) text += " is:unread";
  if (query.starredOnly) text += " is:starred";
  return text.trim();
}

/** Graph $search uses KQL. Read/star/folder predicates are checked after fetching. */
export function graphSearch(query: ThreadQuery): string {
  const parsed = parseSearchQuery(query);
  const c = parsed.criteria ?? {};
  const terms = searchWords(parsed.search ?? "").map(quote);
  if (c.from) terms.push(`from:${quote(c.from)}`);
  if (c.to) terms.push(`to:${quote(c.to)}`);
  if (c.subject) terms.push(`subject:${quote(c.subject)}`);
  if (c.attachment) terms.push("hasAttachments:true");
  if (c.filename) terms.push(`attachment:${quote(c.filename)}`);
  if (c.important) terms.push("importance:high");
  if (c.dateAfter !== undefined)
    terms.push(`received>=${new Date(c.dateAfter).toISOString().slice(0, 10)}`);
  if (c.dateBefore !== undefined)
    terms.push(`received<${new Date(c.dateBefore).toISOString().slice(0, 10)}`);
  return terms.join(" AND ");
}

const contains = (text: string, term: string) =>
  text.toLocaleLowerCase().includes(term.toLocaleLowerCase());

export function matchesSearch(
  message: IncomingMessage,
  raw: ThreadQuery,
  labels: readonly Pick<Label, "id" | "name">[] = [],
): boolean {
  const q = parseSearchQuery(raw);
  const c = q.criteria ?? {};
  if ((q.unreadOnly && !message.isUnread) || (q.starredOnly && !message.isStarred)) return false;
  const scope = searchMailboxLabel(q);
  if (scope && !message.labels.includes(scope)) return false;
  if (c.from && !contains(`${message.from.address} ${message.from.name}`, c.from)) return false;
  if (c.to && !message.to.some((a) => contains(`${a.address} ${a.name}`, c.to ?? ""))) return false;
  if (c.subject && !contains(message.subject, c.subject)) return false;
  if (c.important && !message.labels.includes("IMPORTANT")) return false;
  if (c.attachment && message.attachments.length === 0) return false;
  if (c.filename && !message.attachments.some((a) => contains(a.filename, c.filename ?? "")))
    return false;
  if (
    (c.dateAfter !== undefined && message.date < c.dateAfter) ||
    (c.dateBefore !== undefined && message.date >= c.dateBefore)
  )
    return false;
  if (
    c.labels?.some(
      (value) =>
        !message.labels.includes(
          labels.find((l) => l.id === value || l.name === value)?.id ?? value,
        ),
    )
  )
    return false;
  return searchWords(q.search ?? "").every((word) =>
    contains(
      `${message.subject} ${message.from.name} ${message.from.address} ${message.bodyText}`,
      unquote(word),
    ),
  );
}

export function filterQuery(criteria: FilterCriteria): ThreadQuery {
  return {
    mailbox: "all",
    searchScope: "all",
    ...(criteria.query.trim() ? { search: criteria.query } : {}),
    criteria: {
      ...(criteria.from ? { from: criteria.from } : {}),
      ...(criteria.to ? { to: criteria.to } : {}),
      ...(criteria.subject ? { subject: criteria.subject } : {}),
      ...(criteria.hasAttachment ? { attachment: true } : {}),
    },
  };
}

export function mergeSearchResults(
  local: readonly ThreadSummary[],
  remote: readonly ThreadSummary[],
  flat = false,
): ThreadSummary[] {
  if (local.some((row) => (row.derivedMatches?.length ?? 0) > 0))
    return reciprocalRankFusion(local, remote, flat);
  const found = new Map<string, ThreadSummary>();
  for (const row of [...local, ...remote]) {
    const key = flat ? row.id : `${row.accountId}/${row.threadId}`;
    const previous = found.get(key);
    const next = !previous || previous.date < row.date ? row : previous;
    const derivedMatches = previous?.derivedMatches ?? row.derivedMatches;
    found.set(key, { ...next, ...(derivedMatches ? { derivedMatches } : {}) });
  }
  return [...found.values()].toSorted((a, b) => b.date - a.date);
}

/** RRF keeps exact mail and attachment candidates useful without comparing score scales. */
export function reciprocalRankFusion(
  body: readonly ThreadSummary[],
  derived: readonly ThreadSummary[],
  flat = false,
): ThreadSummary[] {
  const scores = new Map<string, { thread: ThreadSummary; score: number }>();
  for (const list of [body, derived])
    for (const [rank, thread] of list.entries()) {
      const key = flat ? thread.id : `${thread.accountId}/${thread.threadId}`;
      const old = scores.get(key);
      scores.set(key, {
        thread: { ...old?.thread, ...thread },
        score: (old?.score ?? 0) + 1 / (60 + rank + 1),
      });
    }
  return [...scores.values()]
    .toSorted((a, b) => b.score - a.score || b.thread.date - a.thread.date)
    .map((entry) => entry.thread);
}

/** FTS remains an independent, stronger signal than either semantic route. */
export function semanticRankFusion(
  fts: readonly ThreadSummary[],
  text: readonly ThreadSummary[],
  images: readonly ThreadSummary[],
  flat = false,
): ThreadSummary[] {
  const found = new Map<string, { thread: ThreadSummary; score: number }>();
  for (const [index, list] of [fts, text, images].entries())
    for (const [rank, thread] of list.entries()) {
      const key = flat ? thread.id : `${thread.accountId}/${thread.threadId}`;
      const previous = found.get(key);
      const matches = [
        ...(previous?.thread.derivedMatches ?? []),
        ...(thread.derivedMatches ?? []),
      ];
      const unique = [...new Map(matches.map((hit) => [JSON.stringify(hit), hit])).values()].slice(
        0,
        20,
      );
      found.set(key, {
        thread: {
          ...previous?.thread,
          ...thread,
          ...(unique.length ? { derivedMatches: unique } : {}),
        },
        score: (previous?.score ?? 0) + (index === 0 ? 2 : 1) / (60 + rank + 1),
      });
    }
  return [...found.values()]
    .toSorted((a, b) => b.score - a.score || b.thread.date - a.thread.date)
    .map((item) => item.thread);
}
