/** Compiles a parsed query into Gmail search and Graph KQL, and reports which predicates a server cannot evaluate. */

import type { AttachmentType, ThreadQuery } from "../domain/message.js";
import { ATTACHMENT_TYPES, isAttachmentType } from "./attachment-types.js";
import type { Label } from "../domain/account.js";
import {
  hasSearchExpression,
  parseSearchExpression,
  parseSearchQuery,
  searchMailboxLabel,
  type SearchExpression,
} from "./search.js";
import {
  SEARCH_FOLDER_LABELS,
  quoteSearchValue,
  searchFolderValue,
  searchWords,
  unquoteSearchValue,
} from "./search-tokens.js";

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
