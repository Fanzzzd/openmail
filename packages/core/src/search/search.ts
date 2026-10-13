import { SearchCondition, type SearchCriteria, type ThreadQuery } from "../domain/message.js";
import {
  completeQuotes,
  parseSearchDate,
  quoteSearchValue,
  searchFolderValue,
  searchWords,
  unquoteSearchValue,
} from "./search-tokens.js";
import { ftsSearchTerm } from "./fts.js";
import { Option, Schema } from "effect";
import { isAttachmentType } from "./attachment-types.js";
import { MAILBOX_LABEL } from "../domain/mailbox-labels.js";
import type { FilterCriteria } from "../domain/organization.js";
import { InvalidInput } from "../domain/errors.js";

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
