import type { IncomingMessage, Message } from "./domain.js";
import {
  ruleImportance,
  type FilterCriteria,
  type FilterAction,
  type OutlookRulePredicates,
} from "./organization.js";

export function outlookConditions(c: FilterCriteria) {
  return {
    ...(c.from ? { senderContains: [c.from] } : {}),
    ...(c.to ? { recipientContains: [c.to] } : {}),
    ...(c.subject ? { subjectContains: [c.subject] } : {}),
    ...(c.hasAttachment ? { hasAttachments: true } : {}),
    ...(c.hasWords ? { bodyOrSubjectContains: [c.hasWords] } : {}),
    ...(c.size !== undefined
      ? {
          withinSizeRange:
            c.sizeComparison === "smaller"
              ? { maximumSize: c.size / 1024 }
              : { minimumSize: c.size / 1024 },
        }
      : {}),
    ...c.outlook,
  };
}
export function outlookExceptions(c: FilterCriteria) {
  return {
    ...(c.notWords ? { bodyOrSubjectContains: [c.notWords] } : {}),
    ...(c.exceptFrom ? { senderContains: [c.exceptFrom] } : {}),
    ...(c.exceptTo ? { recipientContains: [c.exceptTo] } : {}),
    ...(c.exceptSubject ? { subjectContains: [c.exceptSubject] } : {}),
    ...(c.exceptAttachment === true ? { hasAttachments: true } : {}),
    ...c.outlookExceptions,
  };
}
export function outlookActions(a: FilterAction, archiveId: string | null) {
  const importance = ruleImportance(a);
  return {
    ...(a.stopProcessing !== undefined ? { stopProcessingRules: a.stopProcessing } : {}),
    ...(importance ? { markImportance: importance } : {}),
    ...(a.assignCategories?.length ? { assignCategories: a.assignCategories } : {}),
    ...(a.copyToFolder ? { copyToFolder: a.copyToFolder } : {}),
    ...(a.markRead ? { markAsRead: true } : {}),
    ...(a.trash ? { delete: true } : {}),
    ...(a.label || archiveId ? { moveToFolder: a.label ?? archiveId } : {}),
  };
}

type Predicates = ReturnType<typeof outlookConditions>;
type CachedMessage = IncomingMessage | Message;
type Evaluation = { readonly matches: boolean; readonly unavailable: readonly string[] };
const contains = (text: string, needle: string) =>
  text.toLowerCase().includes(needle.toLowerCase());
const addressContains = (address: CachedMessage["from"], word: string) =>
  contains(address.name, word) || contains(address.address, word);

const words = (values: readonly string[] | undefined, text: string | undefined) =>
  values === undefined || text === undefined
    ? undefined
    : values.some((word) => contains(text, word));

const UNCACHED_PREDICATES = [
  "headerContains",
  "importance",
  "sensitivity",
  "isAutomaticReply",
  "messageActionFlag",
  "sentOnlyToMe",
  "notSentToMe",
] as const;
const OWNER_PREDICATES = ["sentToMe", "sentCcMe", "sentToOrCcMe"] as const;

/** Graph collections are OR within a field; condition fields are AND. Exception fields are OR. */
export function evaluateOutlookRule(
  c: FilterCriteria,
  message: CachedMessage,
  owners: readonly string[] | undefined,
): Evaluation {
  const isOwner = (address: CachedMessage["from"]) =>
    owners?.some((owner) => address.address.toLowerCase() === owner.toLowerCase()) === true;
  const evaluate = (p: Predicates, exception: boolean): Evaluation => {
    const results: boolean[] = [];
    const unavailable: string[] = [];
    const add = (key: string, value: unknown, result: boolean | undefined) => {
      if (value === undefined) return;
      if (result === undefined) unavailable.push(key);
      else results.push(result);
    };
    const body = message.bodyCached === false ? undefined : message.bodyText;
    add(
      "senderContains",
      p.senderContains,
      p.senderContains?.some((word) => addressContains(message.from, word)),
    );
    add(
      "recipientContains",
      p.recipientContains,
      p.recipientContains?.some((word) =>
        [...message.to, ...message.cc].some((address) => addressContains(address, word)),
      ),
    );
    add("subjectContains", p.subjectContains, words(p.subjectContains, message.subject));
    add(
      "hasAttachments",
      p.hasAttachments,
      message.attachments.length > 0 ? true : message.bodyCached === false ? undefined : false,
    );
    add("bodyContains", p.bodyContains, words(p.bodyContains, body));
    add(
      "bodyOrSubjectContains",
      p.bodyOrSubjectContains,
      p.bodyOrSubjectContains?.some((word) => contains(message.subject, word))
        ? true
        : words(p.bodyOrSubjectContains, body),
    );
    // Cached headers may be a selected subset; they cannot prove the absence of a header.
    for (const key of UNCACHED_PREDICATES) add(key, p[key], undefined);
    const toMe = owners ? message.to.some(isOwner) : undefined;
    const ccMe = owners ? message.cc.some(isOwner) : undefined;
    add("sentToMe", p.sentToMe, toMe);
    add("sentCcMe", p.sentCcMe, ccMe);
    add("sentToOrCcMe", p.sentToOrCcMe, owners ? toMe || ccMe : undefined);
    add(
      "withinSizeRange",
      p.withinSizeRange,
      message.size === undefined
        ? undefined
        : (p.withinSizeRange?.minimumSize === undefined ||
            message.size >= p.withinSizeRange.minimumSize * 1024) &&
            (p.withinSizeRange?.maximumSize === undefined ||
              message.size <= p.withinSizeRange.maximumSize * 1024),
    );
    return { matches: exception ? results.some(Boolean) : results.every(Boolean), unavailable };
  };
  const conditions = evaluate(outlookConditions(c), false);
  const exceptions = evaluate(outlookExceptions(c), true);
  return {
    matches: conditions.matches && !exceptions.matches,
    unavailable: [...new Set([...conditions.unavailable, ...exceptions.unavailable])],
  };
}

export function outlookPreviewUnavailable(c: FilterCriteria, identitiesKnown = true): string[] {
  const keys = identitiesKnown
    ? UNCACHED_PREDICATES
    : [...UNCACHED_PREDICATES, ...OWNER_PREDICATES];
  return keys.filter(
    (key) => c.outlook?.[key] !== undefined || c.outlookExceptions?.[key] !== undefined,
  );
}

export function validOutlookPredicates(p: OutlookRulePredicates | undefined): boolean {
  if (!p) return true;
  if (Object.values(p).some((v) => v === false)) return false;
  if (
    [p.bodyContains, p.headerContains].some(
      (values) => values && (values.length !== 1 || !values[0]?.trim()),
    )
  )
    return false;
  const range = p.withinSizeRange;
  if (!range) return true;
  const sizes = [range.minimumSize, range.maximumSize].filter((size) => size !== undefined);
  return (
    sizes.length > 0 &&
    sizes.every((size) => Number.isSafeInteger(size) && size >= 0 && size <= 2147483647) &&
    !(
      range.minimumSize !== undefined &&
      range.maximumSize !== undefined &&
      range.minimumSize > range.maximumSize
    )
  );
}
