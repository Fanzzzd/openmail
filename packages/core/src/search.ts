import { stripMessageIdBrackets } from "./message-id.js";
import { MAILBOX_LABEL } from "./mailbox-labels.js";
import { Option, Schema } from "effect";
import {
  SearchCondition,
  type Provider,
  type Address,
  type Attachment,
  type AttachmentType,
  type IncomingMessage,
  type Label,
  type SearchCriteria,
  type ThreadQuery,
  type ThreadSummary,
} from "./domain.js";
import { InvalidInput } from "./errors.js";
import type { FilterCriteria } from "./organization.js";

const SEARCH_FOLDER_LABELS: Readonly<Record<string, string>> = MAILBOX_LABEL;

export const SEARCH_OPERATORS = [
  "list:",
  "deliveredto:",
  "header:",
  "has:userlabels",
  "has:nouserlabels",
  "from:",
  "to:",
  "cc:",
  "bcc:",
  "has:drive",
  "category:",
  "rfc822msgid:",
  "older_than:",
  "newer_than:",
  "larger:",
  "smaller:",
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
  "older:",
  "newer:",
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
  if (hasSearchExpression(value))
    return {
      chips: [],
      text: value.trimEnd(),
      pending: /\s$/.test(value) ? "" : (words.at(-1) ?? ""),
    };
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
  const attachment = negated ? terms.join(" ") : `has:attachment {${terms.join(" ")}}`;
  return ["document", "spreadsheet", "presentation"].includes(type)
    ? negated
      ? `${attachment} -has:${type}`
      : `(${attachment} OR has:${type})`
    : attachment;
}

/** A single quoted operator prevents provider-controlled addresses injecting search terms. */
export const senderSearchQuery = (address: string): string => `from:${quoteSearchValue(address)} `;

/** Invalid/incomplete operators stay searchable text while the person is typing. */
export function parseSearchQuery(query: ThreadQuery): ThreadQuery {
  const invalid = searchInputError(query.search ?? "");
  if (invalid) throw invalid;
  if (hasSearchExpression(query.search ?? "")) return query;
  const criteria: { -readonly [K in keyof SearchCriteria]: SearchCriteria[K] } = {
    ...query.criteria,
  };
  const words: string[] = [];
  let unread = query.unreadOnly;
  let starred = query.starredOnly;
  for (const word of searchWords(query.search ?? "")) {
    if (ftsSearchTerm(word.replace(/^-/, "")) === null) continue;
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
      case "__around": {
        const parsed = Schema.decodeUnknownOption(
          Schema.fromJsonString(SearchCondition.fields.proximity.schema),
        )(value);
        if (Option.isSome(parsed)) criteria.proximity = parsed.value;
        else words.push(word);
        break;
      }
      case "list":
        criteria.mailingList = value;
        break;
      case "deliveredto":
        criteria.header = { name: "delivered-to", value };
        break;
      case "header": {
        const separator = value.indexOf(":");
        const name = separator < 0 ? value : value.slice(0, separator);
        if (/^[A-Za-z0-9-]+$/.test(name))
          criteria.header = {
            name: name.toLowerCase(),
            value: separator < 0 ? "" : value.slice(separator + 1),
          };
        else words.push(word);
        break;
      }
      case "from":
        criteria.from = value;
        break;
      case "to":
        criteria.to = value;
        break;
      case "bcc":
        criteria.bcc = value;
        break;
      case "rfc822msgid":
        criteria.rfcMessageId = value;
        break;
      case "category": {
        const category = ["PRIMARY", "FOCUSED"].includes(value.toUpperCase())
          ? "PERSONAL"
          : value.toUpperCase();
        criteria.labels = [...(criteria.labels ?? []), `CATEGORY_${category}`];
        break;
      }
      case "larger":
      case "size":
      case "smaller": {
        const size = parseSearchSize(value);
        if (size === null) words.push(word);
        else if (key === "smaller")
          criteria.sizeSmaller = Math.min(criteria.sizeSmaller ?? size, size);
        else criteria.sizeLarger = Math.max(criteria.sizeLarger ?? size, size);
        break;
      }
      case "older_than":
      case "newer_than": {
        const date = relativeSearchDate(value, Date.now());
        if (date === null) words.push(word);
        else if (key === "older_than")
          criteria.dateBefore = Math.min(criteria.dateBefore ?? date, date);
        else criteria.dateAfter = Math.max(criteria.dateAfter ?? date, date);
        break;
      }
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
        if (value === "userlabels" || value === "nouserlabels")
          criteria.userLabels = value === "userlabels";
        else if (value === "drive") criteria.drive = true;
        else if (value === "attachment") criteria.attachment = true;
        else if (value === "image") criteria.image = true;
        else if (isAttachmentType(value))
          criteria.attachmentTypes = [...(criteria.attachmentTypes ?? []), value];
        else words.push(word);
        break;
      case "in":
        if (value === "attachment") criteria.attachmentText = true;
        else if (value === "anywhere" || value === "all") criteria.anywhere = true;
        else criteria.labels = [...(criteria.labels ?? []), searchFolderValue(value)];
        break;
      case "is":
        if (value === "read") criteria.unread = false;
        else if (value === "unread") unread = true;
        else if (value === "starred") starred = true;
        else if (value === "important") criteria.important = true;
        else words.push(word);
        break;
      case "older":
      case "newer":
      case "before":
      case "after": {
        const date = parseSearchDate(value);
        if (date === null) words.push(word);
        else if (key === "before" || key === "older")
          criteria.dateBefore = Math.min(criteria.dateBefore ?? date, date);
        else criteria.dateAfter = Math.max(criteria.dateAfter ?? date, date);
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
  const mailbox = q.mailbox ?? "inbox";
  return mailbox === "all" ? undefined : MAILBOX_LABEL[mailbox];
};

export function gmailSearch(
  query: ThreadQuery,
  labels: readonly Pick<Label, "id" | "name">[] = [],
): string {
  if (query.search && /[()]/.test(query.search.replace(/"(?:\\.|[^"\\])*(?:"|$)/g, ""))) {
    const render = (node: SearchExpression): string => {
      if (node.kind === "term") {
        const proximity = parseSearchQuery({ search: node.value }).criteria?.proximity;
        if (proximity) {
          const value = `${proximity.left} AROUND ${proximity.distance} ${proximity.right}`;
          return proximity.ordered
            ? quoteSearchValue(value)
            : `${quoteSearchValue(proximity.left)} AROUND ${proximity.distance} ${quoteSearchValue(proximity.right)}`;
        }
        return gmailSearch({ search: node.value }, labels);
      }
      if (node.kind === "not") return `-(${render(node.child)})`;
      return `(${node.children.map(render).join(node.kind === "or" ? " OR " : " ")})`;
    };
    return [
      render(parseSearchExpression(query.search)),
      gmailSearch({ ...query, search: undefined }, labels),
    ]
      .filter(Boolean)
      .join(" ");
  }
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
    const dateWord = /^(-?)(before|after|older|newer):(.+)$/i.exec(word);
    if (dateWord) {
      const token = parseSearchQuery({ search: word.replace(/^-/, "") }).criteria;
      const before = ["before", "older"].includes(dateWord[2]?.toLowerCase() ?? "");
      const date = before ? token?.dateBefore : token?.dateAfter;
      if (date !== undefined)
        return `${dateWord[1]}${before ? "before" : "after"}:${Math.floor(date / 1000)}`;
    }
    return word;
  });
  const c = query.criteria;
  if (c?.rfcMessageId) words.push(`rfc822msgid:${quoteSearchValue(c.rfcMessageId)}`);
  if (c?.bcc) words.push(`bcc:${quoteSearchValue(c.bcc)}`);
  if (c?.sizeLarger !== undefined) words.push(`larger:${c.sizeLarger}`);
  if (c?.sizeSmaller !== undefined) words.push(`smaller:${c.sizeSmaller}`);
  if (c?.drive) words.push("has:drive");
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
  if (
    query.search &&
    (hasSearchExpression(query.search) ||
      searchWords(query.search).some((word) => word.startsWith("-")))
  ) {
    const expression = projectServerSearch(
      parseSearchExpression(query.search),
      (value) => {
        if (serverSearchIgnored({ search: value }, "outlook").length) return null;
        const parsed = parseSearchQuery({ search: value });
        // Read and flagged status are checked locally; Graph KQL cannot express them reliably.
        if (parsed.unreadOnly || parsed.starredOnly || parsed.criteria?.unread !== undefined)
          return null;
        return (
          graphSearch({ ...parsed, search: undefined }) ||
          (parsed.search ? quoteSearchValue(unquoteSearchValue(parsed.search)) : null)
        );
      },
      (kind, children) =>
        children.length === 1
          ? children.join("")
          : `(${children.join(kind === "and" ? " AND " : " OR ")})`,
      (child) => `NOT (${child})`,
    );
    const extra = graphSearch({ ...query, search: undefined });
    return [expression.value, extra].filter(Boolean).join(" AND ");
  }
  const parsed = parseSearchQuery(query);
  const c = parsed.criteria ?? {};
  const terms = searchWords(parsed.search ?? "")
    .map(unquoteSearchValue)
    .map((term) =>
      /^[\p{L}\p{N}]+$/u.test(term) && !["AND", "OR", "NOT"].includes(term.toUpperCase())
        ? term
        : quoteSearchValue(term),
    );
  if (c.from) terms.push(`from:${quoteSearchValue(c.from)}`);
  if (c.bcc) terms.push(`bcc:${quoteSearchValue(c.bcc)}`);
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
  incoming: IncomingMessage,
  raw: ThreadQuery,
  labels: readonly Pick<Label, "id" | "name">[] = [],
  provider?: Provider,
): boolean {
  const message =
    provider === "outlook" && !incoming.labels.includes("CATEGORY_OTHER")
      ? { ...incoming, labels: [...incoming.labels, "CATEGORY_PERSONAL"] }
      : incoming;
  const q = parseSearchQuery(raw);
  if (
    raw.search !== undefined &&
    !searchIncludesSpecialFolders(raw) &&
    message.labels.some((label) => label === "SPAM" || label === "TRASH")
  )
    return false;
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
  if (
    c.excluded?.some(
      (condition) =>
        !(
          message.size === undefined &&
          (condition.sizeLarger !== undefined || condition.sizeSmaller !== undefined)
        ) && matchesSearchCondition(message, condition, labels),
    )
  )
    return false;
  return evaluateSearchExpression(
    parseSearchExpression(q.search ?? ""),
    (word) => {
      const atom = parseSearchQuery({ search: word });
      if (!matchesSearchCondition(message, atom.criteria ?? {}, labels)) return false;
      if ((atom.unreadOnly && !message.isUnread) || (atom.starredOnly && !message.isStarred))
        return false;
      if (
        atom.criteria?.excluded?.some((condition) =>
          matchesSearchCondition(message, condition, labels),
        )
      )
        return false;
      return (
        !atom.search ||
        wholeWordMatch(
          `${message.subject} ${message.from.name} ${message.from.address} ${message.bodyText}`,
          atom.search,
        )
      );
    },
    (node) => message.size === undefined && expressionHasSize(node),
  );
}

export function matchesSearchCondition(
  message: IncomingMessage,
  c: SearchCondition,
  labels: readonly Pick<Label, "id" | "name">[] = [],
): boolean {
  const proximity = c.proximity;
  if (
    proximity &&
    ![message.subject, message.from.name, message.from.address, message.bodyText].some((text) =>
      proximityMatch(text, proximity),
    )
  )
    return false;
  if (c.subjectContains && !contains(message.subject, c.subjectContains)) return false;
  const mailingList = c.mailingList;
  if (
    mailingList &&
    !(message.headers ?? []).some(
      (h) =>
        ["list-id", "list-post"].includes(h.name.toLowerCase()) &&
        (contains(h.value, mailingList) ||
          (h.name.toLowerCase() === "list-id" && contains(h.value, mailingList.replace("@", ".")))),
    )
  )
    return false;
  const header = c.header;
  if (
    header &&
    !(message.headers ?? []).some(
      (h) => h.name.toLowerCase() === header.name.toLowerCase() && contains(h.value, header.value),
    )
  )
    return false;
  if (
    c.userLabels !== undefined &&
    c.userLabels !==
      message.labels.some(
        (id) =>
          !id.startsWith("CATEGORY_") &&
          !id.startsWith("category:") &&
          labels.some((l) => l.id === id),
      )
  )
    return false;
  if (c.unread !== undefined && c.unread !== message.isUnread) return false;
  if (c.starred !== undefined && c.starred !== message.isStarred) return false;
  if (c.bcc && !(message.bcc ?? []).some((a) => contains(`${a.address} ${a.name}`, c.bcc ?? "")))
    return false;
  if (
    c.rfcMessageId &&
    (message.rfcMessageId === undefined
      ? undefined
      : stripMessageIdBrackets(message.rfcMessageId)) !== stripMessageIdBrackets(c.rfcMessageId)
  )
    return false;
  if (c.sizeLarger !== undefined && message.size !== undefined && message.size <= c.sizeLarger)
    return false;
  if (c.sizeSmaller !== undefined && message.size !== undefined && message.size >= c.sizeSmaller)
    return false;
  if (c.drive && !hasDriveLink(`${message.bodyHtml} ${message.bodyText}`)) return false;
  if (c.cc && !message.cc.some((a) => contains(`${a.address} ${a.name}`, c.cc ?? ""))) return false;
  if (
    c.image &&
    !message.attachments.some((a) => attachmentHasType(a, "image")) &&
    !message.bodyHtml.includes("cid:")
  )
    return false;
  if (
    c.attachmentTypes?.some(
      (type) =>
        !message.attachments.some((a) => attachmentHasType(a, type)) &&
        !hasTypedDriveLink(`${message.bodyHtml} ${message.bodyText}`, type),
    )
  )
    return false;
  if (c.from && !contains(`${message.from.address} ${message.from.name}`, c.from)) return false;
  if (c.to && !message.to.some((a) => contains(`${a.address} ${a.name}`, c.to ?? ""))) return false;
  if (c.subject && !wholeWordMatch(message.subject, c.subject)) return false;
  if (c.important && !message.labels.includes("IMPORTANT")) return false;
  if (c.attachment !== undefined && c.attachment !== message.attachments.length > 0) return false;
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
  const terms = [
    criteria.excludeChats ? "-is:chat" : "",
    criteria.query.trim(),
    criteria.hasWords?.trim(),
    criteria.notWords?.trim() ? `-(${criteria.notWords})` : "",
  ].filter(Boolean);
  return {
    mailbox: "all",
    searchScope: "all",
    ...(terms.length ? { search: terms.join(" ") } : {}),
    criteria: {
      excluded: [
        ...(criteria.exceptFrom ? [{ from: criteria.exceptFrom }] : []),
        ...(criteria.exceptTo ? [{ to: criteria.exceptTo }, { cc: criteria.exceptTo }] : []),
        ...(criteria.exceptSubject ? [{ subjectContains: criteria.exceptSubject }] : []),
        ...(criteria.exceptAttachment !== undefined
          ? [{ attachment: criteria.exceptAttachment }]
          : []),
      ],
      ...(criteria.from ? { from: criteria.from } : {}),
      ...(criteria.to ? { to: criteria.to } : {}),
      ...(criteria.subject ? { subject: criteria.subject } : {}),
      ...(criteria.hasAttachment ? { attachment: true } : {}),
      ...(criteria.size !== undefined
        ? criteria.sizeComparison === "smaller"
          ? { sizeSmaller: criteria.size }
          : { sizeLarger: criteria.size }
        : {}),
    },
  };
}

/** One identity for conversation grouping, flat search and all fusion routes. */
export const keyOf = (
  thread: Pick<ThreadSummary, "id" | "accountId" | "threadId">,
  flat = false,
): string => (flat ? thread.id : `${thread.accountId}/${thread.threadId}`);

export function mergeSearchResults(
  local: readonly ThreadSummary[],
  remote: readonly ThreadSummary[],
  flat = false,
): ThreadSummary[] {
  if (local.some((row) => (row.derivedMatches?.length ?? 0) > 0))
    return reciprocalRankFusion(local, remote, flat);
  const found = new Map<string, ThreadSummary>();
  for (const row of [...local, ...remote]) {
    const key = keyOf(row, flat);
    const previous = found.get(key);
    const next = !previous || previous.date < row.date ? row : previous;
    const derivedMatches = previous?.derivedMatches ?? row.derivedMatches;
    found.set(key, { ...next, ...(derivedMatches ? { derivedMatches } : {}) });
  }
  return [...found.values()].toSorted((a, b) => b.date - a.date);
}

const SEARCH_MATCH_LIMIT = 20;

function combineMatches<A>(left: readonly A[] = [], right: readonly A[] = []): readonly A[] {
  if (left === right || right.length === 0)
    return left.length <= SEARCH_MATCH_LIMIT ? left : left.slice(0, SEARCH_MATCH_LIMIT);
  if (left.length === 0)
    return right.length <= SEARCH_MATCH_LIMIT ? right : right.slice(0, SEARCH_MATCH_LIMIT);
  return [...new Map([...left, ...right].map((hit) => [JSON.stringify(hit), hit])).values()].slice(
    0,
    SEARCH_MATCH_LIMIT,
  );
}

/** Weighted RRF combines independent BM25 orders without comparing corpus score scales. */
export function reciprocalRankFusion(
  body: readonly ThreadSummary[],
  derived: readonly ThreadSummary[],
  flat = false,
  exactAttachments: ReadonlySet<string> = new Set(),
  exactMail: ReadonlySet<string> = new Set(),
): ThreadSummary[] {
  const scores = new Map<string, { thread: ThreadSummary; score: number }>();
  // Keep even the last mail candidate above the strongest ordinary OCR-only hit.
  const mailWeight = Math.max(2, (60 + body.length) / 60);
  const phraseBonus = 1.5 * mailWeight - 1;
  for (const [index, list] of [body, derived].entries()) {
    const seen = new Set<string>();
    for (const [rank, thread] of list.entries()) {
      const key = keyOf(thread, flat);
      if (seen.has(key)) continue;
      seen.add(key);
      const old = scores.get(key);
      scores.set(key, {
        thread: {
          ...old?.thread,
          ...thread,
          ...(old?.thread.derivedMatches || thread.derivedMatches
            ? {
                derivedMatches: combineMatches(old?.thread.derivedMatches, thread.derivedMatches),
              }
            : {}),
          ...(old?.thread.searchMatches || thread.searchMatches
            ? {
                searchMatches: combineMatches(old?.thread.searchMatches, thread.searchMatches),
              }
            : {}),
        },
        score:
          (old?.score ?? 0) +
          ((index === 0 ? mailWeight : 1) +
            ((index === 0 ? exactMail : exactAttachments).has(key) ? phraseBonus : 0)) /
            (60 + rank + 1),
      });
    }
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
  const lexical = new Set(fts.map((thread) => keyOf(thread, flat)));
  for (const [index, list] of [fts, text, images].entries())
    for (const [rank, thread] of list.entries()) {
      const key = keyOf(thread, flat);
      const previous = found.get(key);
      const matches = [
        ...(previous?.thread.derivedMatches ?? []),
        ...(thread.derivedMatches ?? []),
      ];
      const unique = [...new Map(matches.map((hit) => [JSON.stringify(hit), hit])).values()].slice(
        0,
        SEARCH_MATCH_LIMIT,
      );
      // A lexical hit keeps its highlighted preview; a semantic-only one is marked related.
      found.set(key, {
        thread: {
          ...previous?.thread,
          ...thread,
          ...(previous ? { snippet: previous.thread.snippet } : {}),
          ...(unique.length ? { derivedMatches: unique } : {}),
          ...(index > 0 && !lexical.has(key) ? { related: true } : {}),
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

export type SearchExpression =
  | { kind: "term"; value: string }
  | { kind: "and" | "or"; children: SearchExpression[] }
  | { kind: "not"; child: SearchExpression };

/** Quoted values are indivisible. Unfinished groups/quotes are accepted while typing. */
export function parseSearchExpression(input: string): SearchExpression {
  const invalid = searchInputError(input);
  if (invalid) throw invalid;
  const rawTokens = expressionTokens(input);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i] ?? "";
    const ordered = /^"([^"\n]+) AROUND (\d+) ([^"\n]+)"$/.exec(token);
    const around =
      ordered ??
      (rawTokens[i + 1] === "AROUND" &&
      /^\d+$/.test(rawTokens[i + 2] ?? "") &&
      rawTokens[i + 3] &&
      !/[(){}:]/.test(token + rawTokens[i + 3])
        ? ["", token, rawTokens[i + 2], rawTokens[i + 3]]
        : null);
    if (around && Number(around[2]) <= 1000) {
      tokens.push(
        `__around:${quoteSearchValue(JSON.stringify({ left: unquoteSearchValue(around[1]), right: unquoteSearchValue(around[3] ?? ""), distance: Number(around[2]), ordered: !!ordered }))}`,
      );
      if (!ordered) i += 3;
    } else tokens.push(token);
  }
  let index = 0;
  const group = (depth: number, disjunction = false): SearchExpression => {
    const alternatives: SearchExpression[] = [];
    let terms: SearchExpression[] = [];
    const flush = () => {
      alternatives.push({ kind: "and", children: terms });
      terms = [];
    };
    while (index < tokens.length) {
      const token = tokens[index++] ?? "";
      if (token === ")" || token === "}") break;
      if (token === "OR" || token === "|") {
        if (terms.length) flush();
        continue;
      }
      if (token === "AND") continue;
      let node: SearchExpression;
      if (/^[a-z_]+:$/i.test(token) && ["(", "{"].includes(tokens[index] ?? "") && depth < 64) {
        const opening = tokens[index++];
        const scoped = (value: SearchExpression): SearchExpression => {
          if (value.kind === "term")
            return {
              ...value,
              value: value.value.includes(":") ? value.value : `${token}${value.value}`,
            };
          if (value.kind === "not") return { ...value, child: scoped(value.child) };
          return { ...value, children: value.children.map(scoped) };
        };
        node = scoped(group(depth + 1, opening === "{"));
      } else if ((token === "(" || token === "{") && depth < 64)
        node = group(depth + 1, token === "{");
      else if (token === "-" && ["(", "{"].includes(tokens[index] ?? "") && depth < 64) {
        const opening = tokens[index++];
        node = { kind: "not", child: group(depth + 1, opening === "{") };
      } else
        node =
          token.startsWith("-") && token.length > 1
            ? { kind: "not", child: { kind: "term", value: token.slice(1) } }
            : { kind: "term", value: token };
      if (
        (node.kind === "term" && ftsSearchTerm(node.value) === null) ||
        (node.kind === "not" &&
          node.child.kind === "term" &&
          ftsSearchTerm(node.child.value) === null)
      )
        continue;
      terms.push(node);
      if (disjunction) flush();
    }
    if (terms.length || !alternatives.length) flush();
    return alternatives.length === 1
      ? (alternatives[0] ?? { kind: "and", children: [] })
      : { kind: "or", children: alternatives };
  };
  return group(0);
}
export function hasSearchExpression(text: string): boolean {
  const unquoted = text.replace(/"(?:\\.|[^"\\])*(?:"|$)/g, "");
  if (/\bAROUND \d+\b/.test(text)) return true;
  if (/[(){}]|(?:^|\s)(?:OR|AND|\|)(?:\s|$)/.test(unquoted)) return true;
  const fields = searchWords(text)
    .filter((word) => !word.startsWith("-"))
    .map((word) => /^([a-z_]+):/i.exec(word)?.[1])
    .filter(
      (field) =>
        field !== undefined &&
        [
          "from",
          "to",
          "cc",
          "bcc",
          "subject",
          "filename",
          "rfc822msgid",
          "header",
          "list",
          "deliveredto",
        ].includes(field),
    );
  return (
    new Set(
      fields.map((field) => (["header", "deliveredto"].includes(field ?? "") ? "header" : field)),
    ).size !== fields.length
  );
}
export function evaluateSearchExpression(
  node: SearchExpression,
  term: (value: string) => boolean,
  skipNegation: (node: SearchExpression) => boolean = () => false,
): boolean {
  switch (node.kind) {
    case "term":
      return term(node.value);
    case "and":
      return node.children.every((n) => evaluateSearchExpression(n, term, skipNegation));
    case "or":
      return node.children.some((n) => evaluateSearchExpression(n, term, skipNegation));
    case "not":
      return skipNegation(node.child) || !evaluateSearchExpression(node.child, term, skipNegation);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}
/** Only a trailing, explicit star enables FTS prefix matching; all syntax is quoted. */
export function ftsSearchTerm(value: string): string | null {
  const prefix = value.endsWith("*");
  const text = unquoteSearchValue(prefix ? value.slice(0, -1) : value);
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  return `"${text.replaceAll('"', '""')}"${prefix ? "*" : ""}`;
}
export const wordTokens = (text: string): string[] =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
export function wholeWordMatch(text: string, value: string): boolean {
  const literal = unquoteSearchValue(value.endsWith("*") ? value.slice(0, -1) : value);
  if (ftsSearchTerm(value) === null) return true;
  if (usesSubstringSearch(literal)) return contains(text, literal);
  const haystack = wordTokens(text);
  const prefix = value.endsWith("*");
  const needle = wordTokens(unquoteSearchValue(prefix ? value.slice(0, -1) : value));
  return (
    needle.length > 0 &&
    haystack.some((_, start) =>
      needle.every((word, offset) => {
        const candidate = haystack[start + offset];
        return prefix && offset === needle.length - 1
          ? candidate?.startsWith(word)
          : candidate === word;
      }),
    )
  );
}
export function parseSearchSize(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(value);
  if (!match) return null;
  const amount =
    Number(match[1]) *
    (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1);
  return Number.isSafeInteger(amount) ? amount : null;
}
export function relativeSearchDate(value: string, now: number): number | null {
  const match = /^(\d+)([dmy])$/i.exec(value);
  if (!match) return null;
  const date = new Date(now);
  const amount = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "d":
      date.setDate(date.getDate() - amount);
      break;
    case "m":
      date.setMonth(date.getMonth() - amount);
      break;
    case "y":
      date.setFullYear(date.getFullYear() - amount);
      break;
  }
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}
export function hasDriveLink(text: string): boolean {
  return /https:\/\/(?:drive|docs)\.google\.com\//i.test(text);
}

/** Unsupported server predicates are omitted; fetched candidates still get the local checks. */
export function serverSearchIgnored(
  query: ThreadQuery,
  provider: "gmail" | "outlook" | "imap",
): string[] {
  if (provider === "gmail") return [];
  const supported =
    provider === "imap"
      ? new Set([
          "from",
          "to",
          "cc",
          "bcc",
          "subject",
          "before",
          "after",
          "older",
          "newer",
          "older_than",
          "newer_than",
          "larger",
          "smaller",
          "size",
          "rfc822msgid",
          "is",
        ])
      : new Set([
          "from",
          "to",
          "cc",
          "bcc",
          "subject",
          "before",
          "after",
          "older",
          "newer",
          "older_than",
          "newer_than",
          "is",
          "has",
          "filename",
        ]);
  if (provider === "outlook" && !hasSearchExpression(query.search ?? ""))
    supported.add("rfc822msgid");
  const ignored: string[] = [];
  const supportedTerm = (term: string): boolean => {
    const match = /^([\w]+):(.+)$/.exec(term);
    if (!match) return true;
    const key = match[1]?.toLowerCase() ?? "";
    const value = unquoteSearchValue(match[2] ?? "");
    return (
      supported.has(key) &&
      !(key === "has" && value !== "attachment") &&
      !(
        key === "is" &&
        !(
          provider === "outlook" ? ["important"] : ["important", "unread", "read", "starred"]
        ).includes(value)
      )
    );
  };
  const projection = (node: SearchExpression) =>
    projectServerSearch(
      node,
      (term) => (supportedTerm(term) ? [term] : null),
      (_kind, children) => children.flat(),
      (child) => child,
    );
  const visit = (node: SearchExpression, dropped = false): void => {
    if (node.kind === "term") {
      if (!supportedTerm(node.value) || (dropped && /^\w+:/.test(node.value)))
        ignored.push(
          parseSearchQuery({ search: node.value }).criteria?.proximity ? "AROUND" : node.value,
        );
    } else if (node.kind === "not") visit(node.child, dropped || !projection(node.child).exact);
    else {
      const omitted = dropped || (node.kind === "or" && projection(node).value === null);
      for (const child of node.children) visit(child, omitted);
    }
  };
  visit(parseSearchExpression(query.search ?? ""));
  return [...new Set(ignored)];
}

/** A partial AND is a safe superset, but its negation would be an unsafe subset. */
export function projectServerSearch<T>(
  node: SearchExpression,
  term: (value: string) => T | null,
  combine: (kind: "and" | "or", children: T[]) => T,
  negate: (child: T) => T,
): { value: T | null; exact: boolean } {
  if (node.kind === "term") {
    const value = term(node.value);
    return { value, exact: value !== null };
  }
  if (node.kind === "not") {
    const child = projectServerSearch(node.child, term, combine, negate);
    return child.exact && child.value !== null
      ? { value: negate(child.value), exact: true }
      : { value: null, exact: false };
  }
  const children = node.children.map((child) => projectServerSearch(child, term, combine, negate));
  const exact = children.every((child) => child.exact);
  if (node.kind === "or" && children.some((child) => child.value === null))
    return { value: null, exact: false };
  const supported = children.flatMap((child) => (child.value === null ? [] : [child.value]));
  return { value: supported.length ? combine(node.kind, supported) : null, exact };
}

export const MAX_SEARCH_TERMS = 256;
const expressionTokens = (input: string): string[] =>
  input.match(/-?(?:[^\s(){}"]|"(?:\\.|[^"\\])*(?:"|$))+|[(){}]|-(?=[({])/g) ?? [];
/** Used at Effect and UI boundaries before invoking the synchronous parser. */
export function searchInputError(input: string): InvalidInput | null {
  let terms = 0;
  let depth = 0;
  for (const token of expressionTokens(input)) {
    if (token === "(" || token === "{") depth++;
    else if (token === ")" || token === "}") depth = Math.max(0, depth - 1);
    else if (!["OR", "AND", "|", "-"].includes(token)) terms++;
    if (terms > MAX_SEARCH_TERMS)
      return new InvalidInput({
        message: `Search supports at most ${MAX_SEARCH_TERMS} terms. Narrow your query.`,
      });
    if (depth > 32)
      return new InvalidInput({
        message: "Search groups are nested too deeply. Simplify your query.",
      });
  }
  return null;
}
/** Scripts normally written without spaces retain the existing substring search. */
export const usesSubstringSearch = (text: string): boolean =>
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{Script=Bopomofo}]/u.test(
    text,
  );

export function searchIncludesSpecialFolders(query: ThreadQuery): boolean {
  if (
    query.searchScope === "folder" &&
    (["spam", "trash"].includes(query.mailbox ?? "") ||
      ["SPAM", "TRASH"].includes(query.label ?? ""))
  )
    return true;
  if (
    query.criteria?.anywhere ||
    query.criteria?.labels?.some((label) => ["SPAM", "TRASH"].includes(label))
  )
    return true;
  return expressionIncludesSpecialFolders(parseSearchExpression(query.search ?? ""));
}

export function typedDrivePath(type: AttachmentType): string | null {
  switch (type) {
    case "document":
      return "document";
    case "spreadsheet":
      return "spreadsheets";
    case "presentation":
      return "presentation";
    case "image":
    case "pdf":
      return null;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}
export function hasTypedDriveLink(text: string, type: AttachmentType): boolean {
  const path = typedDrivePath(type);
  return path !== null && text.toLowerCase().includes(`https://docs.google.com/${path}/`);
}

function expressionIncludesSpecialFolders(node: SearchExpression): boolean {
  if (node.kind === "not") return false;
  if (node.kind === "term") {
    const q = parseSearchQuery({ search: node.value });
    return (
      q.criteria?.anywhere === true ||
      (q.criteria?.labels?.some((label) => ["SPAM", "TRASH"].includes(label)) ?? false)
    );
  }
  return node.children.some(expressionIncludesSpecialFolders);
}

export function expressionHasSize(node: SearchExpression): boolean {
  if (node.kind === "term") {
    const criteria = parseSearchQuery({ search: node.value }).criteria;
    return criteria?.sizeLarger !== undefined || criteria?.sizeSmaller !== undefined;
  }
  return node.kind === "not"
    ? expressionHasSize(node.child)
    : node.children.some(expressionHasSize);
}

const searchConditionTerms = (condition: SearchCondition): number =>
  Object.values(condition).reduce<number>(
    (count, value) => count + (Array.isArray(value) ? value.length : 1),
    0,
  );

/** Structured criteria share the same total budget as parsed search terms. */
export function searchQueryError(query: ThreadQuery): InvalidInput | null {
  const invalid = searchInputError(query.search ?? "");
  if (invalid) return invalid;
  const { excluded = [], ...criteria } = query.criteria ?? {};
  const terms = expressionTokens(query.search ?? "").filter(
    (token) => !["OR", "AND", "|", "-", "(", ")", "{", "}"].includes(token),
  ).length;
  return terms +
    searchConditionTerms(criteria) +
    excluded.reduce((count, condition) => count + searchConditionTerms(condition), 0) >
    MAX_SEARCH_TERMS
    ? new InvalidInput({
        message: `Search supports at most ${MAX_SEARCH_TERMS} terms. Narrow your query.`,
      })
    : null;
}

export function searchUsesSize(query: ThreadQuery): boolean {
  if (searchQueryError(query)) return false;
  return (
    query.criteria?.sizeLarger !== undefined ||
    query.criteria?.sizeSmaller !== undefined ||
    expressionHasSize(parseSearchExpression(query.search ?? ""))
  );
}

export function proximityMatch(
  text: string,
  proximity: NonNullable<SearchCondition["proximity"]>,
): boolean {
  const words = wordTokens(text);
  const left = wordTokens(proximity.left),
    right = wordTokens(proximity.right);
  if (!left.length || !right.length) return false;
  const positions = (phrase: string[]) =>
    words.flatMap((_, i) => (phrase.every((word, j) => words[i + j] === word) ? [i] : []));
  return positions(left).some((a) =>
    positions(right).some((b) =>
      b >= a + left.length
        ? b - a - left.length <= proximity.distance
        : !proximity.ordered && a >= b + right.length && a - b - right.length <= proximity.distance,
    ),
  );
}
