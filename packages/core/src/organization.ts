import { Schema } from "effect";
import { ThreadSummary } from "./domain.js";

export const LabelChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    name: Schema.String,
    parentId: Schema.optionalKey(Schema.String),
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
  color: Schema.NullOr(Schema.String),
});
export type LabelPreference = typeof LabelPreference.Type;
export const AccountOrganization = Schema.Struct({
  accountId: Schema.String,
  categories: Schema.Boolean,
});
export type AccountOrganization = typeof AccountOrganization.Type;

/** Shared subset that maps losslessly to Gmail filters and Outlook inbox rules. */
export const FilterCriteria = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  query: Schema.String,
  hasAttachment: Schema.Boolean,
});
export type FilterCriteria = typeof FilterCriteria.Type;
export const FilterAction = Schema.Struct({
  archive: Schema.Boolean,
  markRead: Schema.Boolean,
  star: Schema.Boolean,
  trash: Schema.Boolean,
  label: Schema.NullOr(Schema.String),
});
export type FilterAction = typeof FilterAction.Type;
export const FilterInput = Schema.Struct({
  name: Schema.String,
  criteria: FilterCriteria,
  action: FilterAction,
  queryDeletionConfirmed: Schema.optionalKey(Schema.Literal(true)),
});
export type FilterInput = typeof FilterInput.Type;
export const ServerFilter = Schema.Struct({ id: Schema.String, ...FilterInput.fields });
export type ServerFilter = typeof ServerFilter.Type;
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
  errors: Schema.Array(Schema.Struct({ accountId: Schema.String, message: Schema.String })),
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
  return input.action.trash && input.criteria.query.trim().length > 0;
}
