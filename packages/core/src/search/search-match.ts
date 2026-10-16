/** Evaluates a parsed query against a fetched message: operators, attachment types and Drive links. */

import type {
  AttachmentType,
  IncomingMessage,
  SearchCondition,
  ThreadQuery,
} from "../domain/message.js";
import type { Label, Provider } from "../domain/account.js";
import {
  expressionHasSize,
  parseSearchExpression,
  parseSearchQuery,
  searchIncludesSpecialFolders,
  searchMailboxLabel,
  type SearchExpression,
} from "./search.js";
import { proximityMatch, wholeWordMatch } from "./fts.js";
import { contains } from "./search-tokens.js";
import { stripMessageIdBrackets } from "../mime/message-id.js";
import { attachmentHasType } from "./attachment-types.js";
import { providerCapabilities } from "../providers/capabilities.js";

export function matchesSearch(
  incoming: IncomingMessage,
  raw: ThreadQuery,
  labels: readonly Pick<Label, "id" | "name">[] = [],
  provider?: Provider,
): boolean {
  const message =
    provider &&
    providerCapabilities(provider).inboxTabs === "focused" &&
    !incoming.labels.includes("CATEGORY_OTHER")
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
          (
            labels.find((l) => l.id === value) ??
            labels.find((l) => l.name.toLowerCase() === value.toLowerCase())
          )?.id ?? value,
        ),
    )
  )
    return false;
  return true;
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
export function hasDriveLink(text: string): boolean {
  return /https:\/\/(?:drive|docs)\.google\.com\//i.test(text);
}

export function typedDrivePath(
  type: AttachmentType,
): "document" | "spreadsheets" | "presentation" | null {
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
