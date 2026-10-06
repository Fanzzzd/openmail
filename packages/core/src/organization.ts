import { sameProviderWrite } from "./provider-write.js";
import { Schema } from "effect";
import { ThreadSummary, type MailboxView, type Provider, CATEGORIES } from "./domain.js";

export function moveSourceLabel(mailbox: MailboxView, currentLabel?: string): string | null {
  if (currentLabel?.startsWith("category:")) return null;
  if (mailbox === "inbox") return "INBOX";
  if (mailbox === "trash") return "TRASH";
  if (mailbox === "spam") return "SPAM";
  return currentLabel ?? null;
}

export const SYSTEM_FOLDERS = [
  "inbox",
  "snoozed",
  "important",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "all",
] as const;
export const systemFolderId = (id: (typeof SYSTEM_FOLDERS)[number]) => `mailbox:${id}`;

export const FilterPreview = Schema.Struct({
  token: Schema.String,
  matches: Schema.Array(ThreadSummary),
  truncated: Schema.Boolean,
  unavailable: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type FilterPreview = typeof FilterPreview.Type;

export const LabelChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    name: Schema.String,
    parentId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("parent"),
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("visibility"),
    id: Schema.String,
    labelListVisibility: Schema.Literals(["labelShow", "labelShowIfUnread", "labelHide"]),
    messageListVisibility: Schema.Literals(["show", "hide"]),
  }),
  Schema.Struct({ kind: Schema.Literal("rename"), id: Schema.String, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("delete"), id: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("color"),
    id: Schema.String,
    color: Schema.NullOr(Schema.String),
  }),
]);
export type LabelChange = typeof LabelChange.Type;

export const LabelPreference = Schema.Struct({
  accountId: Schema.String,
  id: Schema.String,
  visible: Schema.Boolean,
  favorite: Schema.Boolean,
  position: Schema.optionalKey(Schema.Number),
  color: Schema.NullOr(Schema.String),
});
export type LabelPreference = typeof LabelPreference.Type;
export const AccountOrganization = Schema.Struct({
  accountId: Schema.String,
  categories: Schema.Boolean,
  selectedCategories: Schema.optionalKey(Schema.Array(Schema.Literals(CATEGORIES))),
});
export type AccountOrganization = typeof AccountOrganization.Type;

export const RULE_IMPORTANCE = ["low", "normal", "high"] as const;
export const RULE_SENSITIVITY = ["normal", "personal", "private", "confidential"] as const;
export const MESSAGE_ACTION_FLAGS = [
  "any",
  "call",
  "doNotForward",
  "followUp",
  "fyi",
  "forward",
  "noResponseNecessary",
  "read",
  "reply",
  "replyToAll",
  "review",
] as const;
/** Additional Graph predicates, shared by conditions and exceptions. Sizes are KiB. */
export const OutlookRulePredicates = Schema.Struct({
  bodyContains: Schema.optionalKey(Schema.Array(Schema.String)),
  headerContains: Schema.optionalKey(Schema.Array(Schema.String)),
  importance: Schema.optionalKey(Schema.Literals(RULE_IMPORTANCE)),
  sensitivity: Schema.optionalKey(Schema.Literals(RULE_SENSITIVITY)),
  messageActionFlag: Schema.optionalKey(Schema.Literals(MESSAGE_ACTION_FLAGS)),
  isAutomaticReply: Schema.optionalKey(Schema.Boolean),
  sentToMe: Schema.optionalKey(Schema.Boolean),
  sentOnlyToMe: Schema.optionalKey(Schema.Boolean),
  sentCcMe: Schema.optionalKey(Schema.Boolean),
  notSentToMe: Schema.optionalKey(Schema.Boolean),
  sentToOrCcMe: Schema.optionalKey(Schema.Boolean),
  withinSizeRange: Schema.optionalKey(
    Schema.Struct({
      minimumSize: Schema.optionalKey(Schema.Number),
      maximumSize: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type OutlookRulePredicates = typeof OutlookRulePredicates.Type;
/** Shared fields plus explicit provider-specific predicates. */
export const FilterCriteria = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  query: Schema.String,
  hasAttachment: Schema.Boolean,
  excludeChats: Schema.optionalKey(Schema.Boolean),
  outlook: Schema.optionalKey(OutlookRulePredicates),
  outlookExceptions: Schema.optionalKey(OutlookRulePredicates),
  hasWords: Schema.optionalKey(Schema.String),
  notWords: Schema.optionalKey(Schema.String),
  exceptFrom: Schema.optionalKey(Schema.String),
  exceptTo: Schema.optionalKey(Schema.String),
  exceptSubject: Schema.optionalKey(Schema.String),
  exceptAttachment: Schema.optionalKey(Schema.Boolean),
  size: Schema.optionalKey(Schema.Number),
  sizeComparison: Schema.optionalKey(Schema.Literals(["larger", "smaller"])),
});
export type FilterCriteria = typeof FilterCriteria.Type;
export const FilterAction = Schema.Struct({
  markImportance: Schema.optionalKey(Schema.Literals(RULE_IMPORTANCE)),
  assignCategories: Schema.optionalKey(Schema.Array(Schema.String)),
  copyToFolder: Schema.optionalKey(Schema.String),
  addLabelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  removeLabelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  stopProcessing: Schema.optionalKey(Schema.Boolean),
  archive: Schema.Boolean,
  markRead: Schema.Boolean,
  star: Schema.Boolean,
  trash: Schema.Boolean,
  label: Schema.NullOr(Schema.String),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  important: Schema.optionalKey(Schema.Boolean),
  category: Schema.optionalKey(Schema.Literals(CATEGORIES)),
});
export type FilterAction = typeof FilterAction.Type;
/** System removals represented by the archive, read and importance switches. */
export const GMAIL_REMOVABLE_SYSTEM_LABELS = ["INBOX", "UNREAD", "IMPORTANT"] as const;
/** Omit undocumented INBOX/UNREAD/SPAM additions and reserved SENT/DRAFT additions. */
export const GMAIL_READ_ONLY_ADD_LABELS = ["INBOX", "UNREAD", "SPAM", "SENT", "DRAFT"] as const;
export function ruleImportance(action: FilterAction) {
  if (action.markImportance) return action.markImportance;
  return action.important === undefined ? undefined : action.important ? "high" : "normal";
}
export function outlookServerOnlyAction(action: FilterAction): boolean {
  return !!(
    action.stopProcessing ||
    ruleImportance(action) ||
    action.assignCategories?.length ||
    action.copyToFolder
  );
}
export function gmailRuleLabels(a: FilterAction) {
  const removals = { INBOX: a.archive, UNREAD: a.markRead, IMPORTANT: a.important === false };
  return {
    addLabelIds: [
      ...new Set([
        ...(a.addLabelIds ?? []),
        ...(a.star ? ["STARRED"] : []),
        ...(a.trash ? ["TRASH"] : []),
        ...(a.label ? [a.label] : []),
        ...(a.labels ?? []),
        ...(a.important === true ? ["IMPORTANT"] : []),
        ...(a.category ? [a.category] : []),
      ]),
    ],
    removeLabelIds: [
      ...new Set([
        ...(a.removeLabelIds ?? []),
        ...GMAIL_REMOVABLE_SYSTEM_LABELS.filter((id) => removals[id]),
      ]),
    ],
  };
}
export function filterDestinationsSupported(action: FilterAction, provider: Provider): boolean {
  const labels = gmailRuleLabels(action);
  if (
    provider === "gmail" &&
    (labels.addLabelIds.some(
      (id) =>
        labels.removeLabelIds.includes(id) ||
        GMAIL_READ_ONLY_ADD_LABELS.some((label) => label === id),
    ) ||
      (labels.addLabelIds.includes("TRASH") &&
        (labels.removeLabelIds.includes("INBOX") ||
          labels.addLabelIds.some(
            (id) =>
              id.startsWith("Label_") ||
              CATEGORIES.some((category) => category === id) ||
              ["INBOX", "SPAM"].includes(id),
          ))))
  )
    return false;
  return (
    !(
      provider !== "outlook" &&
      (action.markImportance || action.assignCategories?.length || action.copyToFolder)
    ) &&
    !(provider !== "gmail" && (action.addLabelIds?.length || action.removeLabelIds?.length)) &&
    !(provider !== "outlook" && action.stopProcessing) &&
    !(
      action.trash &&
      (action.archive || action.label || action.labels?.length || action.category)
    ) &&
    !(action.archive && action.label && provider !== "gmail") &&
    !(provider !== "gmail" && (action.labels?.length || action.category))
  );
}
export const FilterInput = Schema.Struct({
  name: Schema.String,
  criteria: FilterCriteria,
  action: FilterAction,
  queryDeletionConfirmed: Schema.optionalKey(Schema.Literal(true)),
});
export type FilterInput = typeof FilterInput.Type;
export const ServerFilter = Schema.Struct({
  id: Schema.String,
  ...FilterInput.fields,
  editable: Schema.optionalKey(Schema.Boolean),
});
export type ServerFilter = typeof ServerFilter.Type;
export const GmailRuleDefinition = Schema.Struct({
  criteria: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  action: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type GmailRuleDefinition = typeof GmailRuleDefinition.Type;
export const FilterRestoration = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  originalId: Schema.String,
  input: FilterInput,
  definition: GmailRuleDefinition,
});
export type FilterRestoration = typeof FilterRestoration.Type;
export const FilterRestorationPreview = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("complete") }),
  Schema.Struct({ kind: Schema.Literal("preview"), preview: FilterPreview }),
]);
export type FilterRestorationPreview = typeof FilterRestorationPreview.Type;

export function sameFilterRule(left: FilterInput, right: FilterInput): boolean {
  const values = (input: FilterInput) => [
    input.criteria.from,
    input.criteria.to,
    input.criteria.subject,
    input.criteria.query,
    input.criteria.hasAttachment,
    input.criteria.excludeChats ?? false,
    input.criteria.outlook ?? {},
    input.criteria.outlookExceptions ?? {},
    input.action.assignCategories ?? [],
    input.action.copyToFolder ?? null,
    input.action.addLabelIds ?? [],
    input.action.removeLabelIds ?? [],
    input.criteria.hasWords ?? "",
    input.criteria.notWords ?? "",
    input.criteria.exceptFrom ?? "",
    input.criteria.exceptTo ?? "",
    input.criteria.exceptSubject ?? "",
    input.criteria.exceptAttachment ?? false,
    input.action.stopProcessing ?? false,
    input.criteria.size ?? null,
    input.criteria.sizeComparison ?? null,
    input.action.archive,
    input.action.markRead,
    input.action.star,
    input.action.trash,
    input.action.label,
    input.action.labels ?? [],
    ruleImportance(input.action) ?? null,
    input.action.category ?? null,
  ];
  const named = (input: FilterInput) =>
    Object.fromEntries(values(input).map((value, index) => [index, value]));
  return sameProviderWrite(named(left), named(right));
}
export const Vacation = Schema.Struct({
  enabled: Schema.Boolean,
  start: Schema.NullOr(Schema.Number),
  end: Schema.NullOr(Schema.Number),
  subject: Schema.String,
  body: Schema.String,
  contactsOnly: Schema.Boolean,
  outlook: Schema.optionalKey(
    Schema.Struct({
      externalAudience: Schema.Literals(["none", "contactsOnly", "all"]),
      internalReplyMessage: Schema.String,
      externalReplyMessage: Schema.String,
    }),
  ),
  gmail: Schema.optionalKey(
    Schema.Struct({ responseBodyHtml: Schema.String, originalBody: Schema.String }),
  ),
});
export type Vacation = typeof Vacation.Type;
export const SendAs = Schema.Struct({
  accountId: Schema.String,
  address: Schema.String,
  name: Schema.String,
  isDefault: Schema.Boolean,
  signature: Schema.String,
  signatureHtml: Schema.optionalKey(Schema.String),
});
export type SendAs = typeof SendAs.Type;

export const EMPTY_FILTER: FilterInput = {
  name: "",
  criteria: { from: "", to: "", subject: "", query: "", hasAttachment: false },
  action: { archive: false, markRead: false, star: false, trash: false, label: null },
};
export const EMPTY_VACATION: Vacation = {
  enabled: false,
  start: null,
  end: null,
  subject: "",
  body: "",
  contactsOnly: false,
};

/** Fuzzy subsequence matching, with contiguous and prefix matches ranked first. */
export function fuzzyFolders<T>(
  items: readonly T[],
  query: string,
  name: (item: T) => string,
): T[] {
  const needle = query.toLocaleLowerCase().trim();
  const score = (text: string) => {
    const hay = text.toLocaleLowerCase();
    if (!needle) return 0;
    const exact = hay.indexOf(needle);
    if (exact >= 0) return exact;
    let index = -1;
    let gaps = 0;
    for (const c of needle) {
      const next = hay.indexOf(c, index + 1);
      if (next < 0) return Infinity;
      gaps += next - index - 1;
      index = next;
    }
    return 1000 + gaps;
  };
  return items
    .map((item) => ({ item, score: score(name(item)) }))
    .filter((row) => Number.isFinite(row.score))
    .toSorted((a, b) => a.score - b.score)
    .map((row) => row.item);
}

export const SearchResult = Schema.Struct({
  threads: Schema.Array(ThreadSummary),
  truncated: Schema.Boolean,
  ignored: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ accountId: Schema.String, operators: Schema.Array(Schema.String) }),
    ),
  ),
  errors: Schema.Array(
    Schema.Struct({
      accountId: Schema.String,
      message: Schema.String,
      requiresReauth: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type SearchResult = typeof SearchResult.Type;

export function snoozeTimes(now: number): { later: number; tomorrow: number; nextWeek: number } {
  const morning = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  return { later: now + 3 * 60 * 60_000, tomorrow: morning(1), nextWeek: morning(7) };
}

export function requiresFilterDeleteConfirmation(input: FilterInput): boolean {
  return input.action.trash || input.action.addLabelIds?.includes("TRASH") === true;
}

/** Supported reminder phrases use local calendar dates, including across DST changes. */
export function parseSnoozeTime(input: string, now: number): number | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^一(?=周|天|小时|分钟)/, "1")
    .replace(/^两(?=周|天|小时|分钟)/, "2");
  const future = (date: Date) =>
    Number.isFinite(date.getTime()) && date.getTime() > now ? date.getTime() : null;
  const relative =
    /^(?:in\s*)?(\d+)\s*(w(?:eeks?)?|d(?:ays?)?|h(?:ours?)?|m(?:in(?:ute)?s?)?)$/.exec(text) ??
    /^(\d+)\s*(周|星期|天|日|小时|分钟)(?:后)?$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] ?? "";
    const date = new Date(now);
    if (/^(w|周|星期)/.test(unit)) date.setDate(date.getDate() + amount * 7);
    else if (/^(d|天|日)/.test(unit)) date.setDate(date.getDate() + amount);
    else date.setTime(now + amount * (/^(h|小时)/.test(unit) ? 60 * 60_000 : 60_000));
    return future(date);
  }
  const overnightClock = /^(晚上|半夜)\s*12(?:(?::|点|时)(\d{1,2})?)?\s*分?$/.test(text);
  const day = /^(tomorrow|today|明天|今天|后天)(.*)$/.exec(overnightClock ? `今天${text}` : text);
  const week = /^(next\s+)(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(.*)$/.exec(
    text,
  );
  const chineseWeek = /^(下周|下星期)([一二三四五六日天])(.*)$/.exec(text);
  if (day || week || chineseWeek) {
    const date = new Date(now);
    let rest = "";
    if (day) {
      date.setDate(
        date.getDate() + (day[1] === "后天" ? 2 : /^(today|今天)$/.test(day[1] ?? "") ? 0 : 1),
      );
      rest = day[2] ?? "";
    } else {
      const weekdays = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ];
      const target = week
        ? weekdays.indexOf(week[2] ?? "")
        : "日一二三四五六".indexOf((chineseWeek?.[2] ?? "日").replace("天", "日"));
      // Next names a day in the following calendar week (Monday is its first day).
      date.setDate(date.getDate() + 7 - ((date.getDay() + 6) % 7) + ((target + 6) % 7));
      rest = week?.[3] ?? chineseWeek?.[3] ?? "";
    }
    const clock = rest.trim().replace(/^at\s+/, "");
    let hour = 9;
    let minute = 0;
    if (clock && !/^(morning|上午|早上)$/.test(clock)) {
      const match =
        /^(?:(上午|早上|下午|晚上|半夜)\s*)?(\d{1,2})(?:(?::|点|时)(\d{1,2})?)?\s*(am|pm|分)?$/.exec(
          clock,
        );
      if (!match) return null;
      hour = Number(match[2]);
      minute = Number(match[3] ?? 0);
      const period = match[1] ?? match[4];
      if (period && period !== "分") {
        if (hour < 1 || hour > 12) return null;
        const midnight = hour === 12 && /^(晚上|半夜)$/.test(period);
        hour %= 12;
        if (midnight) date.setDate(date.getDate() + 1);
        else if (/^(pm|下午|晚上)$/.test(period)) hour += 12;
      }
      if (hour > 23 || minute > 59) return null;
    }
    date.setHours(hour, minute, 0, 0);
    return future(date);
  }
  // Keep the native date/time picker as a precise alternative.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/i.test(text)) return future(new Date(input));
  return null;
}
