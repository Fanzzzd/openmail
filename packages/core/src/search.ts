import type {
  Address,
  Attachment,
  AttachmentType,
  SearchCondition,
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
  "cc:",
  "subject:",
  "in:",
  "label:",
  "folder:",
  "is:unread",
  "is:starred",
  "is:important",
  "has:attachment",
  "has:image",
  "has:pdf",
  "has:document",
  "has:spreadsheet",
  "has:presentation",
  "in:attachment",
  "filename:",
  "before:",
  "after:",
];
export const searchWords = (text: string): string[] =>
  text.match(/(?:[^\s"]|"(?:\\.|[^"\\])*(?:"|$))+/g) ?? [];

function completeQuotes(text: string): boolean {
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) escaped = false;
    else if (character === "\\" && quoted) escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  return !quoted;
}
/** The final term stays editable until whitespace/Enter finishes it outside quotes. */
export function searchFieldParts(value: string): {
  chips: string[];
  text: string;
  pending: string;
} {
  const words = searchWords(value);
  const complete = /\s$/.test(value) && completeQuotes(value);
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

export const unquoteSearchValue = (text: string) =>
  text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).replace(/\\(["\\])/g, "$1") : text;
export const quoteSearchValue = (text: string): string =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Calendar tokens describe local midnight, including the timezone's DST rules. */
export function parseSearchDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.replaceAll("/", "-"));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date.getTime()
    : null;
}
export function searchCalendarDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** A partly typed native date field must never commit an early year. */
export function selectSearchDate(value: string, operator: string, date: string): string | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number(date.slice(0, 4)) < 1970 ||
    parseSearchDate(date) === null
  )
    return null;
  return selectSearchOperator(value, `${operator}${date}`);
}

function gmailAttachmentType(type: AttachmentType, negated = false): string {
  const terms = ATTACHMENT_TYPES[type].extensions.map(
    (extension) => `${negated ? "-" : ""}filename:${extension}`,
  );
  return negated ? terms.join(" ") : `has:attachment {${terms.join(" ")}}`;
}

/** A single quoted operator prevents provider-controlled addresses injecting search terms. */
export const senderSearchQuery = (address: string): string => `from:${quoteSearchValue(address)} `;

/** Invalid/incomplete operators stay searchable text while the person is typing. */
export function parseSearchQuery(query: ThreadQuery): ThreadQuery {
  const criteria: { -readonly [K in keyof SearchCriteria]: SearchCriteria[K] } = {
    ...query.criteria,
  };
  const words: string[] = [];
  let unread = query.unreadOnly;
  let starred = query.starredOnly;
  for (const word of searchWords(query.search ?? "")) {
    if (word.startsWith("-") && !word.startsWith("--")) {
      const parsed = parseSearchQuery({ search: word.slice(1) });
      if (
        parsed.search ||
        (Object.keys(parsed.criteria ?? {}).length === 0 &&
          !parsed.unreadOnly &&
          !parsed.starredOnly)
      )
        words.push(word);
      else {
        const { excluded: _excluded, ...condition } = parsed.criteria ?? {};
        criteria.excluded = [
          ...(criteria.excluded ?? []),
          {
            ...condition,
            ...(parsed.unreadOnly ? { unread: true } : {}),
            ...(parsed.starredOnly ? { starred: true } : {}),
          },
        ];
      }
      continue;
    }
    const colon = word.indexOf(":");
    const key = word.slice(0, colon).toLowerCase();
    const value = unquoteSearchValue(word.slice(colon + 1));
    if (colon < 1 || !value || !completeQuotes(word)) {
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
      case "cc":
        criteria.cc = value;
        break;
      case "subject":
        criteria.subject = value;
        break;
      case "label":
      case "folder":
        criteria.labels = [...(criteria.labels ?? []), searchFolderValue(value)];
        break;
      case "filename":
        criteria.filename = value;
        break;
      case "has":
        if (value === "attachment") criteria.attachment = true;
        else if (value === "image") criteria.image = true;
        else if (isAttachmentType(value))
          criteria.attachmentTypes = [...(criteria.attachmentTypes ?? []), value];
        else words.push(word);
        break;
      case "in":
        if (value === "attachment") criteria.attachmentText = true;
        else if (value === "anywhere" || value === "all") words.push(word);
        else criteria.labels = [...(criteria.labels ?? []), searchFolderValue(value)];
        break;
      case "is":
        if (value === "unread") unread = true;
        else if (value === "starred") starred = true;
        else if (value === "important") criteria.important = true;
        else words.push(word);
        break;
      case "before":
      case "after": {
        const date = parseSearchDate(value);
        if (date === null) words.push(word);
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
  const words = searchWords(query.search ?? "").flatMap((word) => {
    const type = /^(-?)has:(pdf|image|document|spreadsheet|presentation)$/.exec(word);
    const attachmentType = type?.[2];
    if (type && attachmentType && isAttachmentType(attachmentType))
      return gmailAttachmentType(attachmentType, type[1] === "-");
    const matchIn = /^(-?)in:(.+)$/.exec(word);
    if (matchIn && !["attachment", "anywhere", "all"].includes(matchIn[2] ?? "")) {
      const value = searchFolderValue(unquoteSearchValue(matchIn[2] ?? ""));
      if (Object.values(SEARCH_FOLDER_LABELS).includes(value)) return word;
      return `${matchIn[1]}label:${quoteSearchValue(labels.find((l) => l.id === value)?.name ?? value)}`;
    }
    const match = /^(-?)(label|folder):(.+)$/.exec(word);
    if (match) {
      const value = searchFolderValue(unquoteSearchValue(match[3] ?? ""));
      return `${match[1]}label:${quoteSearchValue(labels.find((l) => l.id === value)?.name ?? value)}`;
    }
    const dateWord = /^(-?)(before|after):(.+)$/i.exec(word);
    if (dateWord) {
      const token = parseSearchQuery({ search: word.replace(/^-/, "") }).criteria;
      const date = dateWord[2]?.toLowerCase() === "before" ? token?.dateBefore : token?.dateAfter;
      if (date !== undefined)
        return `${dateWord[1]}${dateWord[2]?.toLowerCase()}:${Math.floor(date / 1000)}`;
    }
    return word;
  });
  const c = query.criteria;
  if (c?.from) words.push(`from:${quoteSearchValue(c.from)}`);
  if (c?.cc) words.push(`cc:${quoteSearchValue(c.cc)}`);
  if (c?.to) words.push(`to:${quoteSearchValue(c.to)}`);
  if (c?.subject) words.push(`subject:${quoteSearchValue(c.subject)}`);
  if (c?.filename) words.push(`filename:${quoteSearchValue(c.filename)}`);
  if (c?.important) words.push("is:important");
  if (c?.attachment) words.push("has:attachment");
  if (c?.image) words.push(gmailAttachmentType("image"));
  for (const type of c?.attachmentTypes ?? []) words.push(gmailAttachmentType(type));
  for (const label of c?.labels ?? [])
    words.push(`label:${quoteSearchValue(labels.find((l) => l.id === label)?.name ?? label)}`);
  if (c?.dateBefore !== undefined) words.push(`before:${Math.floor(c.dateBefore / 1000)}`);
  if (c?.dateAfter !== undefined) words.push(`after:${Math.floor(c.dateAfter / 1000)}`);
  let text = words.join(" ");
  const scope = searchMailboxLabel(query);
  if (scope)
    text += ` label:${quoteSearchValue(labels.find((l) => l.id === scope)?.name ?? scope)}`;
  if (query.unreadOnly) text += " is:unread";
  if (query.starredOnly) text += " is:starred";
  return text.trim();
}

/** Graph $search uses KQL. Read/star/folder predicates are checked after fetching. */
export function graphSearch(query: ThreadQuery): string {
  const parsed = parseSearchQuery(query);
  const c = parsed.criteria ?? {};
  const terms = searchWords(parsed.search ?? "")
    .map(unquoteSearchValue)
    .map(quoteSearchValue);
  if (c.from) terms.push(`from:${quoteSearchValue(c.from)}`);
  if (c.cc) terms.push(`cc:${quoteSearchValue(c.cc)}`);
  if (c.to) terms.push(`to:${quoteSearchValue(c.to)}`);
  if (c.subject) terms.push(`subject:${quoteSearchValue(c.subject)}`);
  if (c.attachment) terms.push("hasAttachments:true");
  if (c.filename) terms.push(`attachment:${quoteSearchValue(c.filename)}`);
  if (c.important) terms.push("importance:high");
  if (c.dateAfter !== undefined) terms.push(`received>=${new Date(c.dateAfter).toISOString()}`);
  if (c.dateBefore !== undefined) terms.push(`received<${new Date(c.dateBefore).toISOString()}`);
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
  const filters = q.listFilters;
  if (filters?.enabled) {
    if (filters.inInbox && !message.labels.includes("INBOX")) return false;
    if (
      (filters.unread || filters.starred || filters.important) &&
      !(
        (filters.unread && message.isUnread) ||
        (filters.starred && message.isStarred) ||
        (filters.important && message.labels.includes("IMPORTANT"))
      )
    )
      return false;
  }
  const scope = searchMailboxLabel(q);
  if (scope && !message.labels.includes(scope)) return false;
  if (!matchesSearchCondition(message, c, labels)) return false;
  if (c.excluded?.some((condition) => matchesSearchCondition(message, condition, labels)))
    return false;
  return searchWords(q.search ?? "").every((word) =>
    contains(
      `${message.subject} ${message.from.name} ${message.from.address} ${message.bodyText}`,
      unquoteSearchValue(word),
    ),
  );
}

export function matchesSearchCondition(
  message: IncomingMessage,
  c: SearchCondition,
  labels: readonly Pick<Label, "id" | "name">[] = [],
): boolean {
  if (c.unread !== undefined && c.unread !== message.isUnread) return false;
  if (c.starred !== undefined && c.starred !== message.isStarred) return false;
  if (c.cc && !message.cc.some((a) => contains(`${a.address} ${a.name}`, c.cc ?? ""))) return false;
  if (
    c.image &&
    !message.attachments.some((a) => attachmentHasType(a, "image")) &&
    !message.bodyHtml.includes("cid:")
  )
    return false;
  if (
    c.attachmentTypes?.some((type) => !message.attachments.some((a) => attachmentHasType(a, type)))
  )
    return false;
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
  return true;
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

/** MIME and filename fallbacks share one definition for fetched mail and SQLite. */
export const ATTACHMENT_TYPES = {
  pdf: { mimeTypes: ["application/pdf"], extensions: ["pdf"] },
  image: {
    mimeTypes: [],
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "heic",
      "heif",
      "tif",
      "tiff",
      "bmp",
      "svg",
      "avif",
    ],
  },
  document: {
    mimeTypes: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.oasis.opendocument.text",
      "application/rtf",
      "text/rtf",
      "text/plain",
    ],
    extensions: ["doc", "docx", "odt", "rtf", "txt"],
  },
  spreadsheet: {
    mimeTypes: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.oasis.opendocument.spreadsheet",
      "text/csv",
    ],
    extensions: ["xls", "xlsx", "ods", "csv", "tsv"],
  },
  presentation: {
    mimeTypes: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.presentation",
    ],
    extensions: ["ppt", "pptx", "odp", "key"],
  },
} satisfies Record<AttachmentType, { mimeTypes: string[]; extensions: string[] }>;

export const isAttachmentType = (value: string): value is AttachmentType =>
  Object.hasOwn(ATTACHMENT_TYPES, value);
export function attachmentHasType(
  attachment: Pick<Attachment, "filename" | "mimeType">,
  type: AttachmentType,
): boolean {
  const spec = ATTACHMENT_TYPES[type];
  const mime = attachment.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    (type === "image" && mime.startsWith("image/")) ||
    spec.mimeTypes.some((value) => value === mime) ||
    spec.extensions.includes(/\.([^.]+)$/.exec(attachment.filename)?.[1]?.toLowerCase() ?? "")
  );
}

const SEARCH_FOLDER_LABELS: Record<string, string> = {
  inbox: "INBOX",
  starred: "STARRED",
  snoozed: "SNOOZED",
  drafts: "DRAFT",
  sent: "SENT",
  trash: "TRASH",
  spam: "SPAM",
  important: "IMPORTANT",
};
export function searchFolderValue(value: string): string {
  const key = value.toLowerCase();
  return Object.hasOwn(SEARCH_FOLDER_LABELS, key) ? (SEARCH_FOLDER_LABELS[key] ?? value) : value;
}

/** Incomplete quoted values are decoded for lookup, never for query construction. */
export function searchValueTarget(pending: string): { operator: string; value: string } | null {
  const match = /^(-?)(from|to|cc|label|folder|in|before|after):(.*)$/i.exec(pending);
  if (!match) return null;
  const raw = match[3] ?? "";
  return {
    operator: `${match[1]}${match[2]?.toLowerCase()}:`,
    value:
      raw.startsWith('"') && !completeQuotes(raw)
        ? unquoteSearchValue(`${raw}"`)
        : unquoteSearchValue(raw),
  };
}

export function searchValueSuggestions(
  pending: string,
  contacts: readonly Address[],
  labels: readonly Pick<Label, "id" | "name">[],
): { token: string; label: string }[] {
  const target = searchValueTarget(pending);
  if (!target) return [];
  const operator = target.operator.replace(/^-/, "");
  const needle = target.value.toLocaleLowerCase();
  if (["from:", "to:", "cc:"].includes(operator))
    return contacts
      .filter((a) => `${a.name} ${a.address}`.toLocaleLowerCase().includes(needle))
      .slice(0, 10)
      .map((a) => ({
        token: `${target.operator}${quoteSearchValue(a.address)}`,
        label: a.name ? `${a.name} <${a.address}>` : a.address,
      }));
  if (["label:", "folder:", "in:"].includes(operator)) {
    const values = new Map(labels.map((l) => [l.name, l.name]));
    if (operator !== "label:")
      for (const name of Object.keys(SEARCH_FOLDER_LABELS)) values.set(name, name);
    return [...values]
      .filter(([name]) => name.toLocaleLowerCase().includes(needle))
      .slice(0, 10)
      .map(([name, value]) => ({
        token: `${target.operator}${quoteSearchValue(value)}`,
        label: name,
      }));
  }
  return [];
}

export function searchDateSuggestions(
  operator: string,
  now = new Date(),
): { kind: "today" | "yesterday" | "last7Days"; token: string }[] {
  const day = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const date = (offset: number) => new Date(day + offset * 86_400_000).toISOString().slice(0, 10);
  const suggestions: { kind: "today" | "yesterday" | "last7Days"; token: string }[] = [
    { kind: "today", token: `${operator}${date(0)}` },
    { kind: "yesterday", token: `${operator}${date(-1)}` },
    { kind: "last7Days", token: `after:${date(-6)} before:${date(1)}` },
  ];
  return operator.startsWith("-") ? suggestions.slice(0, 2) : suggestions;
}

export function searchTokenModifiers(token: string): string[] {
  const key = token.replace(/^-/, "").split(":")[0];
  if (["from", "to", "cc"].includes(key ?? "")) return ["from", "to", "cc"];
  if (["label", "folder", "in"].includes(key ?? "") && !token.endsWith(":attachment"))
    return ["label", "in", "folder"];
  if (["before", "after"].includes(key ?? "")) return ["before", "after"];
  return [];
}
export function modifySearchToken(token: string, modifier: string): string {
  return `${token.startsWith("-") ? "-" : ""}${modifier}${token.slice(token.indexOf(":"))}`;
}
export const negateSearchToken = (token: string): string =>
  token.startsWith("-") ? token.slice(1) : `-${token}`;
export function editSearchToken(value: string, index: number): string {
  const { chips, text } = searchFieldParts(value);
  const token = chips[index];
  return serializeSearchField(
    chips.filter((_, i) => i !== index),
    [text, token].filter(Boolean).join(" "),
  );
}
